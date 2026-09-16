-- 0007_app_role_least_privilege.sql — Checkpoint 7 forensic-audit repair of migration 0006's grants.
--
-- Migration 0006 got the hard part right: RLS is enabled AND forced on every workspace-owned table, the
-- join/evidence tables chain their policy through their parent, and the application runs as the
-- non-superuser, NOBYPASSRLS role `yeonjae_app`. The audit of that work found the *grants* too wide, in a
-- way RLS cannot compensate for, because the tables concerned are deliberately NOT workspace-scoped:
--
--   1. `users` and `sessions` have no `workspace_id` and therefore no RLS policy. 0006 nevertheless granted
--      `yeonjae_app` SELECT/INSERT/UPDATE/DELETE on them (via GRANT ... ON ALL TABLES). A request-scoped
--      connection could read every user's password verifier and every session/CSRF hash, overwrite a
--      password verifier, or delete another user's sessions. Authentication runs on the *unscoped* pool
--      before `SET LOCAL ROLE`, so the scoped role needs no access to these tables at all.
--   2. `schema_migrations` was writable and deletable by the scoped role: a request-scoped connection could
--      erase the migration ledger, after which `migrate()` would replay every migration. Proven by probe:
--      `set role yeonjae_app; delete from schema_migrations;` removed all 6 rows.
--   3. `prompt_versions` / `prompt_sets` are the global immutable registry (ADR-0016). 0006's comment says
--      the real control is that they are append-only — but only `prompt_versions` carries an immutability
--      trigger; `prompt_sets` had no trigger and was fully writable by the scoped role.
--   4. `api_keys` is workspace-scoped and RLS-covered, but the scoped role could still mint a key for its
--      own workspace and thereby manufacture a credential outside the API's audited path. Key issuance is an
--      owner operation performed on the unscoped pool, so the scoped role gets read-only access.
--
-- The repair is least privilege: REVOKE what the request-scoped role does not need, and make the default
-- privileges for future tables narrower so this cannot silently rot again. Nothing about the RLS design of
-- 0006 changes — this only removes authority the scoped role never had a legitimate use for.
--
-- ROLLBACK. Forward-only (data architecture §15): no down migration exists, and reverting means writing a
-- new migration that re-grants. Because this migration only revokes privileges from a role and adds one
-- trigger, re-applying it is idempotent and reverting it requires no data movement.

-- ---------------------------------------------------------------------------------------------------------
-- 1 + 2. identity and ledger tables the request-scoped role must not touch
-- ---------------------------------------------------------------------------------------------------------
-- Authentication (verifyPassword / resolveSession / resolveApiKey) deliberately runs on the unscoped pool
-- as the owner, *before* any workspace has been proven. The scoped role therefore needs nothing here.
REVOKE ALL ON users FROM yeonjae_app;
REVOKE ALL ON sessions FROM yeonjae_app;
REVOKE ALL ON schema_migrations FROM yeonjae_app;

-- ---------------------------------------------------------------------------------------------------------
-- 3. the global prompt registry is read-only to the application and immutable by trigger
-- ---------------------------------------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE ON prompt_versions FROM yeonjae_app;
REVOKE INSERT, UPDATE, DELETE ON prompt_sets FROM yeonjae_app;

-- `prompt_versions` already refuses UPDATE/DELETE by trigger; `prompt_sets` did not. A prompt set maps roles
-- to pinned prompt versions, so silently rewriting one would repoint production traffic at other prompts
-- while every recorded pin still names the old mapping.
CREATE TRIGGER prompt_set_append_only
  BEFORE UPDATE OR DELETE ON prompt_sets
  FOR EACH ROW EXECUTE FUNCTION canon.audit_append_only();

-- ---------------------------------------------------------------------------------------------------------
-- 4. API keys are readable (authorization) but never mintable by a request-scoped connection
-- ---------------------------------------------------------------------------------------------------------
REVOKE INSERT, DELETE ON api_keys FROM yeonjae_app;

-- ---------------------------------------------------------------------------------------------------------
-- 5. membership is read-only to the request-scoped role
-- ---------------------------------------------------------------------------------------------------------
-- Roles are the authorization source. A request-scoped connection that could UPDATE `workspace_members`
-- could promote its own principal to owner, so member administration stays on the unscoped, audited path.
REVOKE INSERT, UPDATE, DELETE ON workspace_members FROM yeonjae_app;

-- ---------------------------------------------------------------------------------------------------------
-- 6. narrow the default privileges so later migrations do not silently re-widen this
-- ---------------------------------------------------------------------------------------------------------
-- 0006 set ALTER DEFAULT PRIVILEGES to grant full DML on every future table. A future table without a
-- workspace_id would then be fully writable by the scoped role with no RLS to restrain it. Future tables now
-- default to SELECT only; a migration that adds a workspace-owned table grants its DML explicitly, next to
-- the RLS policy it also has to add.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE INSERT, UPDATE, DELETE ON TABLES FROM yeonjae_app;
