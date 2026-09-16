-- 0008_target_leases.sql — Checkpoint 7: leases over production targets (workflow reliability plan §1, §2).
--
-- The reliability plan requires that "target_leases guard against concurrent jobs on the same target" and
-- that a duplicate start is rejected with `LEASE_HELD`. Deterministic workflow ids alone cannot provide
-- that: they stop the SAME logical run from starting twice, but two DIFFERENT workflow ids (a chapter
-- production and an operator-triggered regeneration, say) can still target one chapter and race each other
-- into extraction and commit.
--
-- The lease is therefore keyed on the TARGET, not on the workflow:
--
--   * `UNIQUE (project_id, target_kind, target_id)` over live leases means at most one holder per target.
--     A second acquirer contends on the index rather than on an application check, so the guarantee does
--     not depend on two processes reading before either writes.
--   * `expires_at` makes a lease self-healing. A worker that is killed between acquiring and releasing must
--     not block its target forever, so the lease is a deadline the holder renews by heartbeat (the plan's
--     15 s heartbeat / 60 s timeout), and an expired lease may be stolen by a new holder.
--   * `fence` increments on every acquisition. A resumed-from-the-dead holder that still believes it owns
--     the lease presents a stale fence, and a fenced write is refused — which is what keeps a zombie worker
--     from committing canon after its lease was taken over.
--
-- ROLLBACK. Forward-only (data architecture §15). Reverting means a new migration that drops the table;
-- because leases are ephemeral coordination state and never canon, dropping them loses no history.

CREATE TABLE target_leases (
  id uuid PRIMARY KEY DEFAULT canon.uuid_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  -- What is being guarded: 'chapter' for chapter production/regeneration, 'project' for plan-wide work.
  target_kind text NOT NULL CHECK (target_kind IN ('chapter', 'project', 'canon')),
  target_id text NOT NULL,
  -- The workflow that holds it, so the API can tell an operator which run is in the way.
  holder_workflow_id text NOT NULL,
  holder_job_id uuid REFERENCES jobs(id),
  -- Monotone per target: a holder whose fence is behind the current one has been superseded.
  fence bigint NOT NULL DEFAULT 1,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  renewed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  CONSTRAINT target_leases_deadline CHECK (expires_at > acquired_at)
);

-- At most one LIVE lease per target. A released lease is kept as history, so the partial index is what
-- enforces exclusivity without deleting the audit trail.
CREATE UNIQUE INDEX target_leases_live_uniq
  ON target_leases (project_id, target_kind, target_id)
  WHERE released_at IS NULL;

CREATE INDEX target_leases_holder_idx ON target_leases (holder_workflow_id);
CREATE INDEX target_leases_expiry_idx ON target_leases (expires_at) WHERE released_at IS NULL;

ALTER TABLE target_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY target_leases_workspace_isolation ON target_leases
  USING (canon.workspace_visible(workspace_id)) WITH CHECK (canon.workspace_visible(workspace_id));

-- Migration 0007 narrowed ALTER DEFAULT PRIVILEGES to SELECT for future tables precisely so that a new
-- workspace-owned table has to grant its own DML next to its RLS policy. This is that grant.
GRANT SELECT, INSERT, UPDATE ON target_leases TO yeonjae_app;

-- ---------------------------------------------------------------------------------------------------------
-- acquisition
-- ---------------------------------------------------------------------------------------------------------
-- One statement so acquisition is atomic under concurrency. Semantics:
--
--   * no live lease            -> acquire with fence = (highest fence ever seen for this target) + 1
--   * live lease, same holder  -> renew (re-entrant: a resumed workflow re-acquires its own lease)
--   * live lease, expired      -> steal, bumping the fence so the previous holder is fenced out
--   * live lease, still valid  -> return nothing; the caller raises LEASE_HELD
--
-- It returns the lease row on success so the caller learns its fence, and nothing at all on contention.
CREATE OR REPLACE FUNCTION canon.acquire_target_lease(
  p_workspace_id uuid,
  p_project_id uuid,
  p_target_kind text,
  p_target_id text,
  p_holder_workflow_id text,
  p_holder_job_id uuid,
  p_ttl_seconds integer
) RETURNS target_leases
LANGUAGE plpgsql
AS $$
DECLARE
  existing target_leases;
  result target_leases;
  next_fence bigint;
BEGIN
  IF p_ttl_seconds <= 0 THEN
    RAISE EXCEPTION 'LEASE_TTL_INVALID: ttl must be positive' USING HINT = 'LEASE_TTL_INVALID';
  END IF;

  -- Lock the live lease row if there is one, so two acquirers serialize here rather than both proceeding.
  SELECT * INTO existing FROM target_leases
   WHERE project_id = p_project_id AND target_kind = p_target_kind AND target_id = p_target_id
     AND released_at IS NULL
   FOR UPDATE;

  IF existing.id IS NOT NULL THEN
    IF existing.holder_workflow_id = p_holder_workflow_id THEN
      -- Re-entrant renewal: the same workflow resuming after a restart keeps its fence.
      UPDATE target_leases
         SET renewed_at = now(),
             expires_at = now() + make_interval(secs => p_ttl_seconds),
             holder_job_id = coalesce(p_holder_job_id, holder_job_id)
       WHERE id = existing.id
       RETURNING * INTO result;
      RETURN result;
    END IF;

    IF existing.expires_at > now() THEN
      -- Held by a live, different workflow: no lease for the caller.
      RETURN NULL;
    END IF;

    -- Expired: release it as history and fall through to a fresh acquisition with a higher fence.
    UPDATE target_leases SET released_at = now() WHERE id = existing.id;
  END IF;

  SELECT coalesce(max(fence), 0) + 1 INTO next_fence FROM target_leases
   WHERE project_id = p_project_id AND target_kind = p_target_kind AND target_id = p_target_id;

  INSERT INTO target_leases (workspace_id, project_id, target_kind, target_id, holder_workflow_id,
                             holder_job_id, fence, expires_at)
  VALUES (p_workspace_id, p_project_id, p_target_kind, p_target_id, p_holder_workflow_id,
          p_holder_job_id, next_fence, now() + make_interval(secs => p_ttl_seconds))
  RETURNING * INTO result;
  RETURN result;
END $$;

-- Renew only if the caller is still the holder AND its fence is current. A zombie holder fails both.
CREATE OR REPLACE FUNCTION canon.renew_target_lease(
  p_lease_id uuid,
  p_holder_workflow_id text,
  p_fence bigint,
  p_ttl_seconds integer
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  updated integer;
BEGIN
  UPDATE target_leases
     SET renewed_at = now(), expires_at = now() + make_interval(secs => p_ttl_seconds)
   WHERE id = p_lease_id
     AND holder_workflow_id = p_holder_workflow_id
     AND fence = p_fence
     AND released_at IS NULL;
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated > 0;
END $$;

-- Releasing is idempotent: a retried cleanup activity must not error, and a lease already stolen by a new
-- holder must not be released out from under it (the fence check prevents that).
CREATE OR REPLACE FUNCTION canon.release_target_lease(
  p_lease_id uuid,
  p_holder_workflow_id text,
  p_fence bigint
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  updated integer;
BEGIN
  UPDATE target_leases
     SET released_at = now()
   WHERE id = p_lease_id
     AND holder_workflow_id = p_holder_workflow_id
     AND fence = p_fence
     AND released_at IS NULL;
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated > 0;
END $$;

GRANT EXECUTE ON FUNCTION canon.acquire_target_lease(uuid, uuid, text, text, text, uuid, integer)
  TO yeonjae_app;
GRANT EXECUTE ON FUNCTION canon.renew_target_lease(uuid, text, bigint, integer) TO yeonjae_app;
GRANT EXECUTE ON FUNCTION canon.release_target_lease(uuid, text, bigint) TO yeonjae_app;
