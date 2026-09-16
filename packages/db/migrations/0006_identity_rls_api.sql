-- 0006_identity_rls_api.sql — Checkpoint 7: identity, tenancy enforcement and the operator API's own state
--
-- Checkpoints 1–6 put `workspace_id` on every tenant-owned table precisely so that isolation could become
-- a database guarantee without a rewrite (0001's header says so). This migration collects that debt:
--
--  1. IDENTITY. `users` and `workspace_members` give the API a principal and a role. Credentials are stored
--     only as a salted hash with its algorithm and parameters — never plaintext, never a reversible form.
--  2. SESSIONS / API KEYS. Both are stored as hashes of the presented secret, so a database disclosure does
--     not yield a usable credential. Expiry and revocation are columns, not application conventions.
--  3. RLS. Every workspace-owned table gets row-level security keyed on `app.workspace_id`, which only the
--     trusted server sets after verifying membership. This is defence in depth: even if an API authorization
--     check were bypassed, the database still refuses rows from another workspace.
--  4. API IDEMPOTENCY. `api_idempotency_keys` binds a key to (workspace, method, route, request hash) so an
--     identical retry replays the stored response and a changed payload under the same key is refused.
--  5. JOB CONTROL. `jobs` gains the operator control surface (pause/resume/cancel intent) and `job_events`
--     is the durable, ordered event log that SSE replays from — reconnect with `Last-Event-ID` must not
--     invent history.
--  6. AUDIT. `audit_log` records privileged and destructive operator actions with the actor and the request.
--
-- RLS NOTE — WHY A SEPARATE ROLE EXISTS. `FORCE ROW LEVEL SECURITY` makes policies apply to a table's owner,
-- but a SUPERUSER bypasses RLS unconditionally, and the local/CI database user is a superuser. RLS that the
-- application's own connection silently bypasses is isolation theatre, so this migration creates the
-- non-superuser role `yeonjae_app` and the application (and the isolation tests) `SET ROLE` to it after
-- connecting. That way one DATABASE_URL keeps working while the policies genuinely bite — verified by a test
-- that asserts a cross-workspace read returns nothing and an unset context returns nothing.

-- ---------------------------------------------------------------------------------------------------------
-- identity
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT canon.uuid_v7(),
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  -- Credential verifier only: algorithm + parameters + salt + digest. Never a plaintext or reversible value.
  password_algo text NOT NULL CHECK (password_algo IN ('scrypt')),
  password_params jsonb NOT NULL,
  password_salt text NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id uuid NOT NULL REFERENCES users(id),
  -- owner: may administer members, budgets and destructive operations. editor: may produce and review.
  -- viewer: read-only. The API's authorization matrix is derived from this column and nothing else.
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_idx ON workspace_members(user_id);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT canon.uuid_v7(),
  user_id uuid NOT NULL REFERENCES users(id),
  -- sha256 of the presented session secret. The secret itself is never stored.
  token_hash text NOT NULL UNIQUE,
  -- Bound to the session and required on unsafe cookie-authenticated requests (double-submit CSRF).
  csrf_token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT canon.uuid_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX api_keys_workspace_idx ON api_keys(workspace_id);

-- ---------------------------------------------------------------------------------------------------------
-- API idempotency (RFC-style Idempotency-Key)
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE api_idempotency_keys (
  id uuid PRIMARY KEY DEFAULT canon.uuid_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  idempotency_key text NOT NULL,
  method text NOT NULL,
  route text NOT NULL,
  -- sha256 over the canonicalized request body. A same-key/different-body retry is a client error, not a
  -- reason to replay someone else's answer.
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('in_progress', 'completed')),
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT api_idempotency_completed_shape CHECK (
    (status = 'completed' AND response_status IS NOT NULL AND completed_at IS NOT NULL)
    OR (status = 'in_progress' AND response_status IS NULL AND completed_at IS NULL)
  ),
  -- One record per (workspace, key, method, route): this uniqueness is what makes a concurrent duplicate
  -- request contend instead of doing the work twice.
  UNIQUE (workspace_id, idempotency_key, method, route)
);

-- ---------------------------------------------------------------------------------------------------------
-- job control and the durable event log SSE replays from
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE jobs
  ADD COLUMN control text NOT NULL DEFAULT 'run' CHECK (control IN ('run', 'pause', 'cancel')),
  ADD COLUMN control_requested_at timestamptz,
  ADD COLUMN control_requested_by uuid REFERENCES users(id),
  ADD COLUMN paused_at timestamptz,
  ADD COLUMN cancelled_at timestamptz;

CREATE TABLE job_events (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  job_id uuid NOT NULL REFERENCES jobs(id),
  -- Monotone per job: the SSE event id a client echoes back in Last-Event-ID.
  seq integer NOT NULL,
  kind text NOT NULL,
  -- Never prompt text or manuscript prose: progress metadata only (step, status, counters, error code).
  payload jsonb NOT NULL,
  terminal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, seq)
);
CREATE INDEX job_events_job_seq_idx ON job_events(job_id, seq);

-- Append-only: an event history a client can replay must not be rewritten under it.
CREATE TRIGGER job_events_append_only
  BEFORE UPDATE OR DELETE ON job_events
  FOR EACH ROW EXECUTE FUNCTION canon.audit_append_only();

-- ---------------------------------------------------------------------------------------------------------
-- audit log for privileged and destructive operator actions
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT canon.uuid_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid REFERENCES projects(id),
  actor_user_id uuid REFERENCES users(id),
  action text NOT NULL,
  target_kind text,
  target_id text,
  request_id text,
  -- Safe metadata only. No secrets, no manuscript text, no raw provider payloads.
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_workspace_idx ON audit_log(workspace_id, created_at DESC);
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION canon.audit_append_only();

-- ---------------------------------------------------------------------------------------------------------
-- exports (accepted-only; the artifact is materialized in the database, never at an arbitrary path)
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE exports (
  id uuid PRIMARY KEY DEFAULT canon.uuid_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  requested_by uuid REFERENCES users(id),
  format text NOT NULL CHECK (format IN ('txt', 'docx')),
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  -- The canon version the export was produced from, so a download is reproducible evidence.
  canon_version integer,
  chapter_numbers integer[] NOT NULL DEFAULT '{}',
  content_hash text,
  byte_size integer,
  content bytea,
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX exports_project_idx ON exports(project_id, created_at DESC);

-- ---------------------------------------------------------------------------------------------------------
-- row-level security
-- ---------------------------------------------------------------------------------------------------------
-- The role the API and the isolation tests run as. It owns nothing and is never a superuser, so the policies
-- below are binding for it. Privileges are granted on the tenant tables it must use; DDL stays with the
-- migration owner.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yeonjae_app') THEN
    CREATE ROLE yeonjae_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public, canon TO yeonjae_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO yeonjae_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO yeonjae_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA canon TO yeonjae_app;
-- Later migrations' objects too, so this does not silently rot.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO yeonjae_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO yeonjae_app;

CREATE OR REPLACE FUNCTION canon.current_workspace() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.workspace_id', true), '')::uuid
$$;

-- When no workspace context is set the policies below deny everything, which is the correct default for a
-- connection that has not proven membership. Trusted internal paths (migrations, the CLI, tests) either run
-- as a BYPASSRLS role or set the context explicitly.
CREATE OR REPLACE FUNCTION canon.workspace_visible(ws uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT canon.current_workspace() IS NOT NULL AND ws = canon.current_workspace()
$$;

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'projects', 'timelines', 'entities', 'chapters', 'manuscript_versions', 'evidence_spans',
    'facts', 'events', 'knowledge_states', 'propositions',
    'relationship_states', 'promises', 'canon_commits',
    'llm_calls', 'summaries', 'search_documents', 'active_constraint_sets',
    'context_packs', 'embedding_sets', 'jobs', 'workflow_artifacts', 'dependency_edges',
    'candidate_selections', 'job_events', 'audit_log', 'exports', 'api_idempotency_keys', 'api_keys',
    -- quarantine_versions carries workspace_id through its LIKE of manuscript_versions: rejected drafts are
    -- tenant data too, and must not be readable across workspaces.
    'quarantine_versions'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (canon.workspace_visible(workspace_id)) WITH CHECK (canon.workspace_visible(workspace_id))',
      t || '_workspace_isolation', t);
  END LOOP;
END $$;

-- `prompt_sets` and `prompt_versions` are deliberately NOT tenant-scoped: they are the global, immutable
-- prompt registry (ADR-0016), shared by every workspace and never containing customer content. Enabling RLS
-- on them would be isolation theatre; the real control is that they are append-only and immutable.
--
-- `workspace_members` is tenant data: who belongs to a workspace must not be readable from another one.
-- It is listed separately from the loop above only because it is created by this migration.
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_members_workspace_isolation ON workspace_members
  USING (canon.workspace_visible(workspace_id)) WITH CHECK (canon.workspace_visible(workspace_id));

-- `workspaces` itself is visible only as the active workspace.
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspaces_workspace_isolation ON workspaces
  USING (canon.workspace_visible(id)) WITH CHECK (canon.workspace_visible(id));

-- Child tables without their own `workspace_id` inherit isolation through their parent.
ALTER TABLE job_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY job_steps_workspace_isolation ON job_steps
  USING (EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_steps.job_id))
  WITH CHECK (EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_steps.job_id));

ALTER TABLE proposition_truths ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposition_truths FORCE ROW LEVEL SECURITY;
CREATE POLICY proposition_truths_workspace_isolation ON proposition_truths
  USING (EXISTS (SELECT 1 FROM propositions p WHERE p.id = proposition_truths.proposition_id))
  WITH CHECK (EXISTS (SELECT 1 FROM propositions p WHERE p.id = proposition_truths.proposition_id));

ALTER TABLE promise_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE promise_events FORCE ROW LEVEL SECURITY;
CREATE POLICY promise_events_workspace_isolation ON promise_events
  USING (EXISTS (SELECT 1 FROM promises p WHERE p.id = promise_events.promise_id))
  WITH CHECK (EXISTS (SELECT 1 FROM promises p WHERE p.id = promise_events.promise_id));

ALTER TABLE promise_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE promise_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY promise_evidence_workspace_isolation ON promise_evidence
  USING (EXISTS (SELECT 1 FROM promise_events pe WHERE pe.id = promise_evidence.promise_event_id))
  WITH CHECK (EXISTS (SELECT 1 FROM promise_events pe WHERE pe.id = promise_evidence.promise_event_id));

-- The *_evidence join tables carry no workspace_id of their own; they are isolated through their parent row,
-- which is itself isolated. Chaining the policy is what keeps that a database guarantee rather than a
-- convention about how the application happens to query them.
ALTER TABLE fact_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE fact_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY fact_evidence_workspace_isolation ON fact_evidence
  USING (EXISTS (SELECT 1 FROM facts f WHERE f.id = fact_evidence.fact_id))
  WITH CHECK (EXISTS (SELECT 1 FROM facts f WHERE f.id = fact_evidence.fact_id));

ALTER TABLE knowledge_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_evidence_workspace_isolation ON knowledge_evidence
  USING (EXISTS (SELECT 1 FROM knowledge_states k WHERE k.id = knowledge_evidence.knowledge_state_id))
  WITH CHECK (EXISTS (SELECT 1 FROM knowledge_states k WHERE k.id = knowledge_evidence.knowledge_state_id));

ALTER TABLE relationship_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationship_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY relationship_evidence_workspace_isolation ON relationship_evidence
  USING (EXISTS (SELECT 1 FROM relationship_states r WHERE r.id = relationship_evidence.relationship_state_id))
  WITH CHECK (EXISTS (SELECT 1 FROM relationship_states r WHERE r.id = relationship_evidence.relationship_state_id));

ALTER TABLE event_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_participants FORCE ROW LEVEL SECURITY;
CREATE POLICY event_participants_workspace_isolation ON event_participants
  USING (EXISTS (SELECT 1 FROM events e WHERE e.id = event_participants.event_id))
  WITH CHECK (EXISTS (SELECT 1 FROM events e WHERE e.id = event_participants.event_id));

ALTER TABLE event_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY event_evidence_workspace_isolation ON event_evidence
  USING (EXISTS (SELECT 1 FROM events e WHERE e.id = event_evidence.event_id))
  WITH CHECK (EXISTS (SELECT 1 FROM events e WHERE e.id = event_evidence.event_id));
