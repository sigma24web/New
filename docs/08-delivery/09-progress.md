# Progress — durable project state

The single place that records implementation status (ADR-0043). Update it in every checkpoint commit.
Everything else in `docs/` describes design; only this file claims what exists and what has run.

## Current state

| Item | Value |
| --- | --- |
| Project | Yeonjae Studio — English manuscripts in the Korean serialized-webnovel tradition |
| Phase | **Checkpoint 7 — interface and hardening** (active, partially delivered — see the Checkpoint 7 section for exactly what exists; recovered from the previous fork at `d5362d2` and continued); **Checkpoint 6 merged** via upstream PR #9 at `6195700` with post-merge CI green; Checkpoint 5 merged via upstream PR #8 at `c8cfb59`; Checkpoints 0–4 in PRs #1–#4 |
| Default branch | `hoplite/ainos-1ac771f8` (now at the Checkpoint 6 merge `6195700`) |
| Working branch | `hoplite/megale-polis-83bf1984--checkpoint-07-interface-hardening` in the fork `sigma23web/New`, created from the Checkpoint 6 merge commit `6195700a068b04108e26f87affd738842f39a15a` (parents `c8cfb59` + `6c4e227`). Immutable base marker: `hoplite/megale-polis-83bf1984--checkpoint-07-base-6195700` @ `6195700`. The Checkpoint 6 recovery branch `hoplite/megale-polis-83bf1984--checkpoint-06-recovery-1db2611` remains untouched at `1db2611` |
| Application code | pnpm workspace: `packages/prose`, `packages/domain`, `packages/db` (migrations 0001–0004 — 0004 adds `workflow_id`/idempotency/`pins` on `jobs`, `workflow_artifacts` content-addressed store, `dependency_edges`; `canon.commit_delta`, `canon.rollback_latest`, bitemporal helpers, `retrieval.ts` accepted-only reads, lexical search, summaries, ACS/pack persistence), `packages/canon` (deterministic verifier + acceptance), `packages/narrative` (profile store, composition, Block compiler), `packages/prompts` (25 immutable prompt families v1.0.0, registry, prompt sets), `packages/gateway` (Guard, routing, budget, repair, output-language path, audit; Mock/Replay providers — Replay gains `activity:<id>` binding), `packages/context` (Active Constraint Set compiler, 4 pack templates, query plan, structured fetch, Postgres FTS retriever + vector interface, T0–T3 assembler with ladder, provenance renderer, manifest + pack hash, validation, `buildPack`), `packages/workflows` (Postgres-checkpointed `runStep` runtime, planning/drafting/evaluation/revision/acceptance stages, `produceChapter` core loop with previous-chapter gate before spend, `workflowStatus`, `exportAccepted`; Replay fixture `examples/fixture/ch01`), `apps/cli` (incl. `chapter:produce` / `chapter:status` / `chapter:resume` / `export:accepted` operator surface over the production workflow, replay-only), `apps/api` (Checkpoint 7: Fastify `/v1` operator API — session/API-key authentication, membership-derived authorization, RLS-scoped connections, RFC 9457 problem details, `Idempotency-Key` handling, cursor pagination, security headers, health/readiness, audit log; migration 0006 adds identity, membership, row-level security on every workspace-owned table, API idempotency keys, job control columns, the append-only `job_events` log and the `exports` table; migration 0007 narrows the request-scoped role's grants to least privilege after the audit; migration 0008 adds fenced target leases; job control + SSE and accepted-only TXT/DOCX export are delivered), `apps/worker` (Checkpoint 7: Temporal worker over the proven chapter loop, ADR-0047 — deterministic workflow ids, fenced target leases, versioned prose-free activity contracts, typed retry classification, pause/resume/cancel signals, progress queries, deterministic history replay; replay-only provider routing with no live-call path) |
| CI | `planning-validation.yml` (validator) + `ci.yml` (Postgres 16 service; types-fresh, typecheck, lint, format, unit + integration tests, CLI smoke, audit, gitleaks) on every push/PR. Local `pnpm check` is the same sequence; GitHub Actions results are reported per-PR (fork PR shows the fork's runs, upstream PR the upstream's) — a PR with zero check runs is unverified, never "green" |

## Checkpoints

| # | Name | Branch | Status | PR |
| --- | --- | --- | --- | --- |
| 0 | Corrected planning baseline (audit, ADR-0037…0044, validator, schemas, fixture, policies) | `hoplite/prokonnesos-fc9b87c1` | done, awaiting review | [#1](https://github.com/jsisiwb/New/pull/1) |
| 1 | Repository foundation (pnpm workspace, TS strict, lint/format/test, schema→types lockstep, CI, mock provider, CLI skeleton, code-point/length/language primitives, StoryClock + lifecycle machines, policy loader) | `…--build-01-foundation` (stacked on 0) | done, awaiting review | [#2](https://github.com/jsisiwb/New/pull/2) |
| 2 | Domain, database and canon core (migration 0001; immutable versions; code-point evidence trigger; frame × timeline rule; `canon.commit_delta` with change classes + complete `inverse`; `canon.rollback_latest`; quarantine; bitemporal helpers; verifier; CLI DB commands) | `…--build-01-foundation--build-02-domain-canon` (stacked on 1) | done, awaiting review | [#3](https://github.com/jsisiwb/New/pull/3) |
| 3 | Narrative identity (profiles as data, composition, Block compiler with role variants, both contract hashes, shedding, overflow error), prompt registry (24 families, immutable content-hashed versions, strict variables, prompt sets), gateway (fail-closed Guard, routing, budget guard, bounded repair, truncation, output-language discard→regenerate→reroute, idempotent audit; Mock/Replay/fault providers), migration 0002 (append-only `llm_calls` with both contract hashes, immutable `prompt_versions`, `jobs`/`job_steps`) | `…--build-02-domain-canon--build-03-identity-gateway` (stacked on 2) | done, awaiting review | [#4](https://github.com/jsisiwb/New/pull/4) |
| 4 | Context and retrieval (Active Constraint Set compiler with `CONSTRAINTS_OVERFLOW`; templates `pack.scene_writer` / `pack.chapter_planner` / `pack.continuity_checker` / `pack.extractor` v1.0.0; deterministic query plan; structured canon fetch at the pinned canon version on the contract timeline — states with evidence, knower-specific knowledge with secrets and prior-loop/source-story memory labels, directional relationships + register, promises, events, world rules; previous accepted chapter L1 + verbatim tail + hook + committed deltas + elapsed time; migration 0003 `summaries` / `search_documents` (accepted-only triggers, idempotent indexing, de-acceptance cleanup) / `active_constraint_sets` / `context_packs` / `embedding_sets`; Postgres FTS retriever + `VectorRetriever` interface; T0–T3 with `PACK_T0_OVERFLOW` / `PACK_T1_OVERFLOW` and the ladder; provenance-tagged rendering; manifest with sections, sources, versions, rank scores, drop reasons, degradation flags, pack hash; pre-call validation; `pack:build` CLI; ADR-0045) | `…--build-03-identity-gateway--build-04-context-retrieval` (stacked on 3) | done, awaiting review | stacked on #4 |
| 5 | Chapter-production vertical slice (deterministic Postgres-checkpointed core loop: intake → spec → bible → arc → locked contract → scene plan → draft → checks → bounded revision → approval-lock → extraction → verification → atomic commit → L1 summary + accepted-only index + dependency edges; ch.1 → ch.2 carries summary/tail/hook/deltas; `exportAccepted`; migration 0004 `jobs.workflow_id`/idempotency/`pins` + `workflow_artifacts`; Replay `activity:<id>` binding; CLI `chapter:produce` / `chapter:status` / `chapter:resume` / `export:accepted` operator surface with replay-only routing, JSON output, nonzero exit on failure; ADR-0046) | `hoplite/kos-969b8d7e--checkpoint-05-completion` | done, merged | upstream [#8](https://github.com/jsisiwb/New/pull/8) |
| 6 | Quality and long-form validation | `hoplite/megale-polis-83bf1984` in `sigma23web/New` (recovered from `1db2611`; staging PR sigma23web/New#1) | active | — |
| 7 | Interface and hardening | `hoplite/megale-polis-83bf1984--checkpoint-07-interface-hardening` (from the Checkpoint 6 merge `6195700`) | **active — platform/API foundation delivered, remaining surfaces outstanding** | — |

PR dependency rule: each checkpoint PR is based on the previous checkpoint branch and states its parent;
merge bottom-up. No PR is merged without explicit user authorization.

## Validation commands and latest results

| Command | Purpose | Last result |
| --- | --- | --- |
| `pip install jsonschema && python3 tools/validate-planning-package.py` | schemas, examples, canon-delta union, evidence offsets against fixture manuscripts, cross-file refs, stale terms, truthfulness | **ALL OK** (32 schemas; 14 examples + 1 bundle; 0 contradiction hits) |
| `DATABASE_URL=postgres://… CI=true pnpm check` | types-fresh → typecheck → lint → format:check → unit + Postgres integration tests → validator | **local green** (this branch: 27 test files, 227 tests passed — 22 chapter-production integration incl. T19b collision proof + 11 multi-chapter continuity integration + 14 failure-recovery integration + 9 candidate-comparison/patch-regression integration + 10 comparison unit + 5 CLI chapter-surface tests; Postgres 16, Node 24.19.0, pnpm 10.26.0, Python 3.12.3). Local green is not GitHub green: see the PR's Actions runs for CI evidence |
| `pnpm cli identity:compile project/…@1 writer_full 2000` | compiles the fixture identity block: both contracts first, 11 sections, 1,272 est. tokens, deterministic hash | ok |
| `pnpm cli prompts:list` | 25 immutable prompt versions + active prompt set id | ok |
| `pnpm cli verify-evidence examples/fixture/manuscripts/ch09.accepted.txt examples/fixture/canon-delta.ch09.json` | code-point evidence verification via the CLI | ok: 8 spans verified |
| `pnpm cli db:migrate … manuscript:import … manuscript:approve … canon:accept … canon:state-at` | end-to-end: import fixture ch.9, approval-lock, verified atomic commit (version 0 → 1), state query at ch.11 returns the venom injury | ok (see PR #3 body) |
| `pnpm cli db:migrate` (0003) → `project:create` → `entity:create` ×4 → `manuscript:import` ch.9 → `manuscript:approve` → `canon:accept` (fixture delta remapped) → `summary:set 9` → `search:index` → `pack:build <project> 10 scene_writer contract.json spec.json --persist --identity=project/…@1` | Checkpoint 4 smoke: chapter 10 writer pack over the real canon — 10 sections, 4,057 est. tokens of 24,000 (T0 2,751 / T1 1,083 / T2 223), previous chapter 9 pinned (v1, canon v1, 422-word tail, tail hash), 32 included / 53 excluded (`diversity_cap`), all 11 validation checks true, `degradation.vector = not_configured`, manifest persisted (`stored: true`) | ok |
| `pnpm cli constraints:compile 12 examples/fixture/story-spec.v3.json` | Active Constraint Set for ch.12 from the fixture spec (12 hard incl. one merged duplicate, 4 soft, 2 assumptions, 3 excluded by scope/retirement); cap 100 → `CONSTRAINTS_OVERFLOW` | ok |

Tests not run: none skipped locally. Without `DATABASE_URL` the integration suites skip visibly. `gitleaks`
runs in CI only (not installed in the local sandbox); `pnpm audit --audit-level=high` reported no findings.
Live-model tests: none executed; nothing in this repository is evidence of live-model prose quality. Vector
retrieval has no implementation (interface + `embedding_sets` registry only, ADR-0045).

Checkpoint 4 test inventory (`packages/context`): unit — constraints (6: scope selection, stable ids, dedupe,
classification, determinism, scope-driven hash change, `CONSTRAINTS_OVERFLOW`, locked facts, non-English
text without paraphrase refused, scope predicate); assembler (21: identical inputs → identical bytes/section
hashes/pack hash + schema-valid manifest; item order irrelevant; canon version / Narrative Identity /
Production Policy changes alter the hash; provenance + source version on every item and line; T0 survives
trimming; `PACK_T0_OVERFLOW`; ladder then `PACK_T1_OVERFLOW`; deterministic T2 ranking, diversity cap, T1
dedupe; T16 rejected draft excluded with reason and phrase absent, mandatory draft → `PROHIBITED_SOURCE`;
untrusted text excluded and never in the system position; other-project items excluded; contract rendered as
PLANNED; k−1 summary/tail/hook/deltas with pins; k > 1 without accepted k−1 fails validation; stale canon
version / other timeline fail the pin check; writer pack passes the gateway Guard; templates ↔ registry roles
and identity variants; checker/extractor job-scoped text; deterministic query plan). Postgres integration
(12): quarantined draft not indexed/summarizable/retrievable and indexing idempotent; k receives k−1 L1 +
tail + hook + committed deltas + pins + elapsed time + evidence-bearing states + locked facts, manifest and
ACS persisted; determinism over the DB + idempotent persistence; knower-specific knowledge, secrets, T0
guards; directional + time-correct relationships (ch.10 vs ch.4); prior-loop isolation with labeled memory;
distant ch.3 event recovered lexically with provenance, nothing ≥ k, nothing non-accepted; lexical/vector
outage degrades with flags; dead DB → `STRUCTURED_RETRIEVAL_UNAVAILABLE`; k−1 working/missing →
`PREVIOUS_CHAPTER_NOT_ACCEPTED`; rollback removes search documents + summary and unbuilds k; checker accepts
`working` job text, extractor only `approved`, quarantined ids refused. Repair regression (`packages/db`):
version numbering across quarantined versions.

## Verification of the inherited stack (this session, 2026-09-14)

- Repository `jsisiwb/New` read via the public API and `git fetch`; default branch `hoplite/ainos-1ac771f8`
  (`2823bb9`). PRs #1–#4 open, none merged, bases chain #1 → #2 → #3 → #4 as recorded; heads `ae11f05`,
  `1ee4a80`, `21e054f`, `0a01e80` match the handoff; nothing was pushed after `0a01e80`. GitHub Actions
  (`ci`, `planning-validation`, gitleaks) succeeded on every head.
- `DATABASE_URL=… CI=true pnpm check` at `0a01e80` (Node 22.23.2, pnpm 10.26.0, Postgres 16.14): 18 files,
  116 tests passed, validator ALL OK — the recorded Checkpoint 3 state is confirmed.
- Defect found and repaired on this branch (not blocking merge of #1–#4, fixed forward): manuscript version
  numbering could reuse a quarantined version's `version_no` (see decisions log).
- Merge verdict: PRs #1–#4 are internally consistent and green; merging remains a user decision (none
  authorized). Merge order #1 → #2 → #3 → #4, retargeting each next PR to the default branch after the
  previous merge.

## Known failures / gaps

- Contrast sets: 40 sets in the repo (5 genres × 8 narrative functions), meeting the ≥ 40 pre-calibration
  target of B-6-3. The judge calibration run itself is still outstanding: the expectations in
  `contrast-sets.seed.json` are authored starting expectations, not measured judge output, and thresholds
  stay `uncalibrated` until B-4-5 runs them against live judges with bilingual reviewers.
- Fixture manuscripts: only ch.9 (accepted) and its rejected draft exist as text; ch.12/ch.14 evidence is
  described, not addressable, until Checkpoint 5 produces them.
- Thresholds in profiles and policies are `uncalibrated`.

## Unresolved risks (see `03-risk-analysis.md`)

R1/R2 (translation-like vs Western-pacing drift) remain the top product risks and are not testable until
Checkpoint 3 (gateway + judges) and Checkpoint 6 (contrast-set regression on live models).

## Checkpoint 4 limitations (recorded, not hidden)

- Vector retrieval: interface + `embedding_sets` registry only; no embedder, no pgvector (ADR-0045). Packs
  report `degradation.vector = not_configured`.
- Lexical search uses the `english` FTS configuration without the per-project name thesaurus
  (`05-retrieval-and-indexing.md` §3); entity tagging covers names/short forms/aliases. Thesaurus is B-1-13
  follow-up.
- L1 summaries are stored by `summary:set` (operator/tests); the `factual_summarizer` call that produces them
  belongs to the Checkpoint 5 acceptance workflow. The same workflow will call `canon.index_accepted_version`
  inside the acceptance transaction and write dependency edges from stored packs (ADR-0032).
- Token counts use `english_estimator_v1` (words × 1.3); the manifest records the estimator id so a tokenizer
  can replace it without changing the schema.
- The three Production Policies gained `context.input_budget_tokens` and new content hashes at `version: 1`
  (no project pins them yet).

## Next exact tasks (Checkpoint 5 — chapter-production vertical slice): done in this change

1. ~~`git checkout -b …--build-04-context-retrieval--build-05-chapter-vertical-slice` from the Checkpoint 4 head.~~
   Landed as `hoplite/kos-969b8d7e--checkpoint-05-completion` (repair of
   the WIP slice merged as PR #7 at `4ea8ecd`; fork staging PR `huuuiuh/New#1`, upstream integration PR
   targeting `jsisiwb/New:hoplite/ainos-1ac771f8`).
2. `packages/workflows` (Postgres-checkpointed idempotent steps, ADR-0044/ADR-0046): intake →
   `requirement_interpreter` → Story Spec → assumptions → bible commit → arc → `chapter_planner` with
   `pack.chapter_planner` → Chapter Contract (validated, locked) → `pack.scene_writer` → `scene_planner` →
   `scene_writer` per scene through `ReplayProvider` → assembly → deterministic checks → replayed evaluators
   → targeted revision → approval-lock → `canon_extractor` with `pack.extractor` → `verifyDelta` →
   `acceptChapter` (+ `factual_summarizer` L1, `indexAcceptedVersion`, dependency edges) → Chapter 2 pack
   proving it carries Chapter 1's summary/tail/hook/deltas → export. Done; 22/22 integration tests
   (incl. T19b global-identity collision proof).
3. Replay recordings for every fixture call (no live provider). Done (`examples/fixture/ch01/replay.ch01.json`,
   prompt-hash + `activity:<id>` binding, `misses == []`).
4. CLI operator surface over the production workflow. Done in this change: `chapter:produce <project> <ch>`
   (runs/resumes `produceChapter` with replay-only routing, deterministic workflow id, JSON summary, nonzero
   exit on failure), `chapter:status <workflow-id>`, `chapter:resume <workflow-id>` (same resume entrypoint,
   explicit), `export:accepted <project>` (accepted manuscripts only; `--full` prints text, default prints
   hashes/sizes); 5 CLI chapter-surface tests (success, idempotent repeat, failure, interrupt→resume, export).
   Remaining follow-ups (not in this change): per-project name thesaurus (B-1-13); Checkpoint 6
   quality/long-form scope.

## Checkpoint 7 — interface and hardening (active)

Delivered so far on `…--checkpoint-07-interface-hardening`, all of it exercised by tests against a real
PostgreSQL 16:

| Item | State |
| --- | --- |
| Identity and membership | **done**: `users` with a salted scrypt verifier whose parameters are stored per row; `sessions` and `api_keys` stored as SHA-256 of a high-entropy secret with expiry and revocation as columns; `workspace_members` as the single source of a principal's role. Constant-time comparisons; a missing account still spends comparable work so it is not detectable by timing. 25 tests |
| App-role least privilege (audit repair) | **done**: a forensic audit of the recovered migration 0006 found its RLS design sound but its grants too wide on the tables that deliberately have no workspace column, where a policy cannot compensate. `users`/`sessions` were fully writable by `yeonjae_app` (every password verifier and session/CSRF hash readable; a verifier overwritable); `schema_migrations` was deletable, proven by probe — all rows removed, after which `migrate()` would replay every migration; `prompt_sets` had no immutability trigger, unlike `prompt_versions`, and was writable, so a pinned role→version mapping could be repointed silently; `api_keys` was insertable and `workspace_members` updatable, letting a request-scoped connection manufacture its own credential or owner role. Migration 0007 revokes what the request path never needs (authentication runs on the unscoped pool before a workspace is proven), adds the missing `prompt_sets` append-only trigger, and narrows `ALTER DEFAULT PRIVILEGES` so a future table cannot be silently writable without a policy. 9 regression tests, each failing against 0006 alone |
| Workspace isolation (RLS) | **done**: row-level security ENABLED **and** FORCED on every workspace-owned table, including the `*_evidence` join tables isolated through their parent. Because a superuser bypasses RLS unconditionally, migration 0006 adds the non-superuser role `yeonjae_app` and `withWorkspace()` switches to it with a transaction-local `app.workspace_id` — otherwise the policies would never bite for the application's own connection. Proved by reads that deliberately omit a `workspace_id` predicate, by naming a foreign row id explicitly, by an unset context returning nothing, and by a refused cross-workspace INSERT. `prompt_sets`/`prompt_versions` are deliberately excluded as the global immutable prompt registry (ADR-0016), not tenant data |
| Versioned `/v1` API | **partial**: `apps/api` (Fastify) implements authentication (session cookie + bearer API key), membership-derived authorization with the viewer/editor/owner matrix, RLS-scoped request handling, RFC 9457 problem details over the workflow layer's existing stable code vocabulary, `Idempotency-Key` bound to (workspace, method, route, request hash), cursor pagination, conservative security headers, health/readiness, an append-only audit log, and read surfaces for projects, chapters/versions, canon commits, entities, timeline, jobs, workflow status and an accepted-only export preview. 35 contract tests |
| Job control and SSE | **done**: migration 0006's `jobs.control` columns and `job_events` have execution semantics. Control is an intent, not an interrupt — `checkpointControl` runs BEFORE a step, so a pause or cancel stops at a checkpoint boundary, no step is torn in half, resumption replays completed steps from `job_steps` without re-spending, and a cancel that lands before acceptance leaves its artifacts noncanonical (asserted: zero `canon_commits`). Terminal jobs accept nothing, a duplicate cancel emits no second event, and a cancelling job is never downgraded to paused. `GET /v1/jobs/{id}/events` streams the append-only log: `Last-Event-ID` replay is exact (the cursor only moves forward), `seq` is allocated inside the INSERT so concurrent emitters cannot collide, heartbeats are comment frames, a terminal event closes the stream, and event payloads are refused if they carry prose, prompt text or a credential. 46 tests (16 durable control, 12 stream, 5 verb dispatch, 13 HTTP) |
| Accepted-only TXT and DOCX export | **done**: `POST /v1/projects/{id}/exports`, status read and authorized download, with artifacts materialized in `exports.content` — a download names an export id, so no filesystem path exists in the request at any point. The accepted-only rule is NOT re-implemented: rendering goes through Checkpoint 5's `exportAccepted`, whose `acceptedChapter` gate requires an accepted chapter AND an accepted manuscript row with an `accepted_commit_id`. Proved against a chapter accepted by the real replay workflow, with a working draft, a quarantined draft and a losing candidate planted alongside: none appears in the TXT, in the DOCX text, or in the raw bytes of either. DOCX is written by `docx` (OOXML) and unzipped and parsed in the test. TXT is byte-identical across runs; the DOCX *content* hash matches TXT's, since ZIP metadata makes container bytes nondeterministic. 13 tests |
| Durable orchestration (Temporal, `apps/worker`) | **done** (ADR-0047): ADR-0003/ADR-0044 placed Temporal at Checkpoint 7 "once the core loop is proven". `apps/worker` runs a Temporal worker whose workflow is deliberately small — acquire lease → observe control → produce → settle → release — and contains no planning, selection, extraction or commit logic. Checkpoint 5's `produceChapter` is wrapped as ONE durable activity and keeps its Postgres checkpoint log, so durability composes rather than duplicating: Postgres gives step-level exactly-once (a restarted run replays `job_steps` and re-spends nothing), Temporal gives run-level durable timers, typed retries, signals, history replay, cancellation scopes and worker-restart recovery. ADR-0047 records why the literal per-step decomposition of ADR-0044 §2 was NOT applied: it would fork the canon invariants into a second, weaker implementation. Activity contracts are versioned and carry no prose (the intake and bible pass as content-addressed artifact ids); an unknown version is rejected, never reinterpreted. Failures are classified by meaning — provider/network retry, validation/policy/budget refusals are non-retryable. Two independent duplicate-start defences: the deterministic workflow id with an allow-duplicate-failed-only reuse policy, and migration 0008's target leases with a TTL (a dead worker cannot block a target) and a monotone fence (a revived zombie cannot act after its lease is stolen). Proved on Temporal's locally downloaded time-skipping test server with replayed model calls — no paid infrastructure, no credentials: acceptance advancing canon exactly once, duplicate start refused with one job and one commit chain, lease contention reported with the holder, zombie fencing, worker restart resuming with model-call count equal to a clean run, cancel-before-commit leaving zero canon commits and artifacts recorded noncanonical, pause honoured before any spend, a permanent failure not retried (max step attempt 1), contract-version refusal, and deterministic workflow-history replay. 11 tests |
| Correction, retcon and rollback | **done** for the canon-service layer: `impactOf` / `regenerationPreview` / `rollbackImpact` compute a read-only impact report (a dry run cannot have a side effect), and ADR-0032's split is honoured from the recorded edge materiality rather than inferred — material dependents become **stale**, contextual dependents become **review suggestions** only. Corrections and retcons commit through `canon.commit_delta` with `source = 'user_correction'` / `'retcon'`, so they inherit every acceptance check (change class, evidence, frame, validity, atomic optimistic version) instead of getting a second, weaker path; evidence-backed canon is not relaxed for operators (a corrected fact with no span is refused as `EVIDENCE_REQUIRED`). Justification is mandatory, a retcon additionally requires explicit human confirmation and carries its exposure in the refusal, and there is no Beta-only automatic patch engine — affected chapters go stale for a human. Nothing is deleted: a correction supersedes and links the prior row, whose evidence stays readable; rollback retracts by version (row counts unchanged) and MVP latest-only is enforced, including refusing to roll back a rollback. An approved report that has gone out of date is a typed `CANON_STALE` conflict, and two concurrent corrections leave exactly one winner with the loser typed. 15 tests |
| Corrective audit of orchestration and job control | **done**: a review of the Checkpoint 7 orchestration found four real defects, each now fixed with a test that failed before the fix. (1) **Lease renewal failure was ignored** — the heartbeat discarded both a `false` result and a thrown error, so a worker could keep drafting, evaluating and committing canon after its lease expired or was stolen at a higher fence. Ownership is now a separate read (`leaseOwnership`) that distinguishes *lost* (released / expired / fenced out, with the current holder named) from *unknown* (database unreachable), because the two demand opposite responses: fail closed on the first, retry on the second. `runStep` re-verifies ownership **before every step**, so a fenced-out run stops before its next durable side effect rather than at an arbitrary point inside one. (2) **Mid-run control was not observed** — `checkpointControl` was called only before and after the whole activity, so a pause or cancel issued during drafting, evaluation or extraction was not seen until the pipeline finished. It is now called inside `runStep`, the only place that knows a unit of work has not begun; replayed steps deliberately skip the check, since replay performs no work and no spend. (3) **A late cancel relabelled accepted canon** — a cancel losing the race with the atomic commit produced a self-contradictory state (job `cancelled`, chapter `accepted`, canon advanced). A late cancel is now reported as `too_late`, the job settles `completed`, and the ignored request is recorded in the job's history. (4) **A completed run emitted no terminal job event**, so an SSE client could not distinguish "finished" from "idle"; `finishJob` now closes every completed run exactly once. Additionally, `produceChapter` no longer relabels a control stop as `failed`. Proved with the control request submitted **while the pipeline is actively running** (the test polls the persisted step and acts mid-flight), not seeded before start: 10 tests |
| Dependency-audit CI gate | **done**: the step named "high+ fails" ended in `|| (echo … && exit 0)`, so every finding became a success and the gate never existed. `tools/audit-gate.mjs` replaces it: high and critical advisories fail the build, an advisory that must be tolerated needs an entry in `.audit-allowlist.json` carrying a justification, scope and expiry, and an expired or incomplete entry suppresses nothing. Verified by injecting a synthetic high advisory — the gate fails, a current allowlist entry lets it pass, and an expired entry does not |
| Remaining Checkpoint 7 scope | **not delivered**: the remaining resource families of the API plan (spec/assumptions, concepts, bible, plans, production mutations, canon inspectors beyond commits/entities/timeline, costs/budgets) and the HTTP surface for correction/retcon/rollback; `apps/web` and all 11 UI screens; observability/metrics; rate limiting; and the deployment/operator runbooks. None of this is claimed as done |

Honest scope note (ADR-0043): Checkpoint 7 is the largest checkpoint in the roadmap. What exists today is
its platform and API foundation plus job control, SSE, accepted-only export, durable orchestration and the
canon correction/retcon/rollback services,
delivered to the same
evidence bar as earlier checkpoints — real PostgreSQL tests, no suppressions, no placeholder routes. The
table above is the authoritative statement of what does and does not exist; the roadmap's Checkpoint 7
description remains the target, not a claim.

Continuation provenance. This checkpoint was resumed by a second agent after the first ran out of
repository credits. The partial head `d5362d2` was recovered unchanged into the fork `sigma24web/New` and
preserved on the immutable branch `hoplite/klazomenai-1ae11ab0--checkpoint-07-recovery-d5362d2`, with the
Checkpoint 6 baseline on `hoplite/klazomenai-1ae11ab0--checkpoint-07-base-6195700` @ `6195700`. Work
continues on `hoplite/klazomenai-1ae11ab0`, which descends from `d5362d2` with none of its three commits
rewritten. The recovered baseline was reproduced before being extended: 32 files / 455 tests passing,
contrast 800 evaluations with 280/280 agreement and zero false positives or negatives, planning validation
green. Branch naming note: the platform's Git broker only publishes to this thread's branch and branches
derived from it, so the recovery and base markers carry that prefix rather than the bare names in the
continuation brief; their SHAs are exactly as specified.

## Checkpoint 6 — quality and long-form validation (merged upstream at `6195700`)

| Item | State |
| --- | --- |
| B-6-1 multi-chapter continuity | **done for chapters 1 → 2 → 3 (three consecutive accepted chapters)**: `examples/fixture/ch02` and `examples/fixture/ch03` (authored scenes + generated recordings) and 28 Postgres/Replay tests. One canon bump per accepted chapter (v3, v4, v5) with chapter 3's delta based on v4; chapter 3's pack carries chapter 2's summary, hook and verbatim tail and **not** chapter 1's; concrete carry-over asserted by content (the eighteen-percent share, the saved leg, the flagged gate) rather than row counts; the gate fact chapter 2 committed is superseded by chapter 3, not duplicated; StoryClock monotone across D+0/D+1/D+2; the promise chain opened(ch.1) → paid(ch.2) → advanced(ch.3); export returns 1, 2, 3 in order, accepted text only; a rerun adds nothing. Predecessor gate: chapter 3 requested while chapter 2 is absent, working or rejected fails with exactly `PREVIOUS_CHAPTER_NOT_ACCEPTED` at step `chapter_contract` with **zero** model calls and no manuscript, canon, summary, index or dependency edge. Resume: chapter 3 interrupted after `scene_plan`, `scene_draft`, `assemble`, `evaluate`, `approve` and `extract` resumes to exactly one accepted chapter 3, one canon advancement, one summary and no duplicate successful call by idempotency key. The compressed 120-chapter long-form run remains B-4-1 |
| B-6-2 failure-recovery tests (commit fault, stale canon, provider fault, resume) | **done**: 30 Postgres/Replay tests. Failure after each of 8 pre-commit steps leaves no chapter commit/accepted version/summary/index; resume replays every completed step and a third run adds no spend; a racing canon commit fails `CANON_STALE` with nothing half-committed; a provider fault fails closed without substituting a draft; a blocked gate reports `needs_attention` rather than `failed`. Added in this change: budget exhaustion refused **before** the provider and audited as `budget_blocked`, with the resumed run completing and no duplicate successful call by idempotency key; malformed, truncated and empty structured output each failing closed at the drafting boundary; a non-English draft failing the output-language boundary; in-transaction canon rejection (unsupported claim, planned frame) leaving only the bible commits with canon exactly at their version and no fact from a chapter acceptance; the **ambiguous post-commit** case — acceptance committed, process died before the checkpoint — where the retry reuses the same commit id and canon version with no second commit, acceptance, summary or index; and cross-project isolation. **This suite found and fixed a real defect** (see decisions log) |
| B-6-3 contrast corpus 4 → ≥ 40 original sets with expectations | **done in this change**: 40 sets in `examples/fixture/contrast-sets.seed.json` (5 genres × 8 narrative functions; 36 authored here), validator count/structure checks green; the judge calibration *run* is B-4-5 and has not happened |
| B-6-4 candidate comparison, selection and patch regression on replay | **done**: `chapter_comparator` prompt family (25th), `packages/workflows/src/comparison.ts` (position-swapped pairwise judging, shuffled-rubric retry, deterministic tie ladder — ADR-0015; per-dimension patch regression and smoke checks — ADR-0014) and `selection.ts` (N-candidate selection). 41 unit + 47 Postgres/Replay integration tests. **Enforcement is at the production boundary**: `requireSelectedWinner` runs inside `approveVersion` and, independently, inside `acceptDelta`, so a direct call to either with a loser fails closed; whether selection is required is decided from the pinned policy and durable candidate rows, never a caller flag. Eligibility reads the **persisted** scorecard artifact for the exact manuscript version and refuses fabricated, foreign, stale-canon, missing and malformed evidence. A committed decision answers exactly one request: the fingerprint pins workspace, project, chapter, contract, candidate slots and content hashes, canon base, identity, policy, prompt set, scorecard artifacts and evaluator provenance, and a changed request is refused rather than silently answered. Finalization is atomic — migration 0005 `candidate_selections` commits the decision and every loser transition in one transaction — and a lost concurrency race surfaces as a typed retriable `SELECTION_CONFLICT`, never a raw database error. Tie fallback requires the explicit policy field `candidates.tie_fallback_ladder_authorized`. Cyclic comparator preferences return `needs_attention` instead of a schedule artifact presented as a winner |

Known mismatch surfaced by B-6-4 (recorded, not fixed here): `standard.v1` gates four dimensions
(`prose`, `structure`, `genre`, `voice`) but the Checkpoint 5 evaluator scores only the first two, so no
candidate can satisfy the ADR-0015 early stop under that policy. `earlyStopDecision` therefore refuses to
stop and names the missing dimensions rather than treating an absent judge as a silent pass; a test asserts
exactly that. Wiring the genre and voice judges (or narrowing the policy) is a separate decision.

B-6-1 scope note (truthfulness, ADR-0043): what exists is a **three-chapter** chain, proved end to end on
replayed fixtures. Three chapters rather than two because a two-chapter chain cannot distinguish "reads the
previous chapter" from "reads chapter 1"; chapter 3 is written to be consumed — its premise is chapter 2's
ending hook, it carries chapter 2's committed state, and it supersedes the fact chapter 2 committed. The
compressed 120-chapter long-form run remains B-4-1. Nothing here is evidence about live-model prose over
many chapters.

N-candidate scope note (truthfulness, ADR-0043): `standard.v1` sets `chapter_candidates: 1`, so **default
production still generates one candidate** and `produceChapter` does not fan out into N candidates. That is
deliberate and unchanged in this checkpoint. What the checkpoint guarantees is that selection is
*enforceable* whenever it applies: when the pinned policy asks for more than one candidate, or when more
than one live candidate version exists on a chapter, approval and canon acceptance both require the
committed winner and fail closed otherwise. The selection ordering claim is equally narrow: the outcome is
deterministic for the pinned `stable_slot_single_elimination` schedule, which is persisted with the
decision as provenance — it is **not** a claim of a schedule-independent global winner, because a pairwise
comparator is not guaranteed transitive (ADR-0015). Observed cycles return `needs_attention`.

B-6-3 scope note (truthfulness, ADR-0043): the corpus is now large enough for the calibration round, but
nothing in this change measures judge behavior. Every `expected` block is an authored starting expectation
(rank orders, illustrative lint ids from the EP-*/ST-*/RG-*/TRN-* catalog, two gap thresholds); profile and
policy thresholds remain `uncalibrated`. Deterministic replay in CI is not evidence of live-model prose
quality, and synthetic contrast sets are not a substitute for the bilingual reviewer panel (B-4-5).

## Important decisions log

| 2026-09-15 | Known fixture-tooling drift (recorded, not fixed here): `tools/build-ch01-fixture.py` does not emit the `variant:*` recordings that were added to `examples/fixture/ch01/replay.ch01.json` later for fault-injection tests, so re-running that builder would drop them. The chapter-2 and chapter-3 builders reproduce their outputs exactly. Re-running the ch.1 builder is therefore currently safe only for `ids.ch01.json`; reconciling the variants into the builder is a separate change | `tools/build-ch01-fixture.py`, `examples/fixture/ch01/replay.ch01.json` |
| 2026-09-15 | Concurrency repair found by the strengthened B-6-4 assertion (CI caught it first, then reproduced locally on ~half of eight runs): a caller that lost a concurrent race received `INTERNAL` carrying a raw PostgreSQL duplicate-key message. Two paths, both fixed at the source — `llm_calls_idempotency_succeeded` now raises a typed `DuplicateCallError` mapped to the retriable `CONCURRENT_CALL`, and the content-addressed `workflow_artifacts` insert absorbs either conflict target and re-reads the committed row. Neither constraint was weakened; the conflicts are still refused, just reported as the typed retriable conditions they are | `packages/db/src/audit.ts`, `packages/db/src/workflow.ts`, `packages/workflows/src/errors.ts` |
| 2026-09-15 | N-candidate repairs (B-6-4): winner enforcement moved from an optional helper into `approveVersion` and `acceptDelta` themselves; eligibility switched to persisted scorecard artifacts; a complete request fingerprint added; finalization made atomic in `candidate_selections` (migration 0005) with a typed `SELECTION_CONFLICT` instead of a raw duplicate-key error; tie fallback given a real policy field (`candidates.tie_fallback_ladder_authorized`) in place of inferring authorization from an unrelated field's existence; and the schedule-independence claim withdrawn in favour of persisted-schedule determinism with cycle detection | `packages/workflows/src/selection.ts`, `packages/workflows/src/acceptance.ts`, `packages/db/src/selection.ts`, `packages/db/migrations/0005_candidate_selection.sql`, `schemas/production-policy.schema.json` |
| 2026-09-15 | Acceptance repair found by B-6-2: `acceptChapter` passed the project's *current* `canon_version` as the commit's parent, so the optimistic check compared a value with itself and a commit landing between extraction and acceptance was absorbed silently instead of raising `STALE_CANON`. The parent is now the delta's own `base_canon_version` (the version extraction was performed against), and a delta without an integer `base_canon_version` is rejected rather than committed unpinned | `packages/canon/src/accept.ts`, `packages/workflows/src/recovery.integration.test.ts` |

| Date | Decision | Where |
| --- | --- | --- |
| 2026-09-13 | Lifecycle: `origin` + `status`; approval-locked extraction; accepted on commit | ADR-0037 |
| 2026-09-13 | Five bitemporal change classes; extraction emits transitions only | ADR-0038 |
| 2026-09-13 | `source_story` = fact-bearing timeline kind reached through knowledge; reincarnation reuses prior-loop timelines | ADR-0039 |
| 2026-09-13 | StoryClock: narrative order authoritative; world order partial; calendars; `narrated_at` | ADR-0040 |
| 2026-09-13 | Production Policy = single versioned source of limits/gates; per-dimension gates only | ADR-0041 |
| 2026-09-13 | Issue-override matrix (never / canon_workflow / reviewer / advisory) | ADR-0042 |
| 2026-09-13 | Truthful baseline: starter labels, one progress doc | ADR-0043 |
| 2026-09-13 | Modular monolith first; CLI before API/UI; Temporal after the core loop | ADR-0044 |
| 2026-09-14 | Prompt families live in the repo (`packages/prompts/families/<family>/vX.Y.Z/`) as the review surface; the DB mirror (`prompt_versions`) is hash-verified and immutable; `tools/seed-prompt-families.py` authored v1.0.0 and is idempotent | `packages/prompts` |
| 2026-09-14 | Gateway audit rows never contain prompt or output text (hashes + sizes only; outputs live in the artifact store the workflow owns) | `packages/gateway/src/gateway.ts`, migration 0002 |
| 2026-09-14 | Canon boundary is the SQL function: all canon tables carry BEFORE triggers that refuse writes unless `canon.in_commit` is set by `canon.commit_delta`/`rollback_latest`, and refuse DELETE/TRUNCATE outright; `btree_gist` exclusion constraints make overlapping validity impossible; evidence trigger uses Postgres code-point `substring` on NFC text | `packages/db/migrations/0001_canon_core.sql` |
| 2026-09-14 | Toolchain: TypeScript 5.9 (typescript-eslint peer range), Vitest 4, ESLint 10 flat config, Prettier 3, `json-schema-to-typescript` for types with a freshness check in CI, Ajv 2020-12 at runtime; UUIDv7 implemented in-house (no dependency); deterministic script/lexicon output-language check (no statistical language-id dependency) | README.dev.md |
| 2026-09-14 | Context packs are pure functions of pinned inputs (pack id = UUIDv8 of the pack hash; ACS id = UUIDv8 of its content hash); lexical index is accepted-only by SQL trigger, synchronous with acceptance, removed on de-acceptance; vector retrieval is an interface until an embedder exists; structured failure blocks, optional failure degrades with flags; per-template input budgets live in the Production Policy | ADR-0045 |
| 2026-09-14 | Repair: `createManuscriptVersion` numbers versions across `manuscript_versions ∪ quarantine_versions` so a quarantined draft and its replacement never share a `version_no` (found while seeding the fixture; regression test in `canon.integration.test.ts`) | `packages/db/src/repo.ts` |
| 2026-09-15 | Chapter-production repair: previous-chapter gate runs before any model spend or canon write (T17); Replay `activity:<id>` binding with prompt-hash priority (no live calls); canon identity stays global, failure-paths tests isolate per-test via DB reset (T19/T19b); T11 extract-variant fixture carries schema-valid plan-frame + future-dated items | ADR-0046, `packages/workflows`, `examples/fixture/ch01/replay.ch01.json` |
| 2026-09-15 | CLI chapter surface over the production workflow (no parallel orchestration): `chapter:produce` runs/resumes `produceChapter` with replay-only routing and deterministic workflow ids, `chapter:status` reads the persisted job, `chapter:resume` re-runs the same workflow id explicitly, `export:accepted` exports accepted text only; nonzero exit on failure; T19b proves two live projects cannot share deterministic fixture UUIDs | `apps/cli`, `apps/cli/src/chapter.test.ts` |
