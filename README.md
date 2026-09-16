# Yeonjae Studio (연재 스튜디오) — Planning Package

**Status:** Checkpoint 6 (quality and long-form validation) is **merged upstream**. Checkpoint 7 (interface and hardening) is **in progress**: its platform and API foundation — identity, enforced workspace isolation and the versioned `/v1` operator API — is implemented; the remaining Checkpoint 7 surfaces (full API resource families, SSE, Temporal, the web UI, correction/retcon flows, TXT/DOCX export, observability and runbooks) are **not** yet delivered. See `docs/08-delivery/09-progress.md` for the authoritative, itemized state. Checkpoint 6 delivered: a three-chapter continuity chain on replayed fixtures, failure-recovery coverage across the durable boundaries, the frozen contrast regression, and N-candidate selection enforced at approval and canon acceptance. Local verification green. Quality thresholds remain **uncalibrated** (ADR-0029) and nothing here is evidence of live-model prose quality — every model call in tests and CI is replayed. See `docs/08-delivery/09-progress.md` for the current test inventory and CI evidence per PR.
Live status: `docs/08-delivery/09-progress.md`.
**Purpose of this repository state:** a complete, internally consistent, production-level plan for an AI
serialized-fiction production studio, written so that an engineering agent can implement it without
redesigning the system.

> **Governing principle: English is the manuscript language. Korean webnovel is the narrative tradition.**
> The studio composes reader-facing prose **directly in natural English** while preserving the narrative
> DNA of Korean serialized web fiction — episode hooks, local chapter payoff, progression cadence,
> controlled exposition, dialogue-forward scenes, mobile-readable paragraphs, strong forward pull, and the
> genre conventions of Korean webnovel categories. It is **not** a translation product and never
> generates Korean prose as an intermediate step.

Yeonjae Studio turns a short premise plus requirements (genre, characters, tropes, forbidden developments,
tone, chapter count, target words per chapter, mandatory scenes, content restrictions, running
directions) into a complete serialized novel: story specification, story bible, characters, world,
progression rules, series/season/arc plans, chapter contracts, scene plans, English prose, editing,
evaluation, revision, continuity management, canon memory, and manuscript export.

It is designed as a **stateful, resumable, auditable novel-production studio** — many purposeful LLM calls
orchestrated by durable workflows over a canonical story database — not one giant prompt or one long chat.

The two problems this plan treats as first-class architecture (not as prompt wording):

1. **Narrative identity enforcement** — every style-sensitive LLM call carries a compiled, versioned
   **Narrative Identity Block** made of an *English output-language contract* and a *Korean-webnovel
   narrative-tradition contract* (plus genre, setting, naming, dialogue-register, terminology and
   preference profiles). The gateway fails closed without both. English fluency and Korean-webnovel
   structural adherence are detected and repaired as **separate** quality dimensions.
   See `docs/02-narrative-identity/`.
2. **Long-range context and canon memory** — the application, not the model, is the authoritative memory.
   Temporal facts with evidence, per-character knowledge, planned-vs-happened separation, quarantined
   rejected drafts, atomic canon commits, and deterministic context-pack assembly.
   See `docs/04-memory-canon/`.

## How to read this package

| If you want to… | Start here |
| --- | --- |
| Understand the product in 10 minutes | `docs/00-overview/01-executive-product-definition.md` |
| Know what is in the MVP vertical slice vs later | `docs/00-overview/03-scope-and-release-tiers.md` |
| Check requirements (incl. the governing OUTPUT-EN / STYLE-KWN requirements) | `docs/01-requirements/` |
| Understand narrative identity enforcement | `docs/02-narrative-identity/01-narrative-identity-architecture.md` |
| Understand memory, canon, knowledge | `docs/04-memory-canon/01-context-and-memory-architecture.md` |
| Understand the generation pipeline | `docs/05-generation/01-generation-pipeline.md` |
| Build the system | `docs/06-system/` + `schemas/` + `docs/08-delivery/05-implementation-handoff-guide.md` |
| See why decisions were made | `docs/adr/` (ADR-0026 is the governing decision) |
| Verify the plan answers the hard questions | `docs/08-delivery/07-plan-audit.md` |
| See what the Checkpoint 0 audit found and changed | `docs/08-delivery/10-baseline-audit-report.md` |
| Know the current implementation state | `docs/08-delivery/09-progress.md` |
| Start implementing | `AGENTS.md`, then `docs/08-delivery/01-implementation-roadmap.md` and `02-backlog.md` |

## Repository layout (planning phase)

```
README.md                      this file
AGENTS.md                      instructions for engineering agents working in this repo
docs/
  00-overview/                 product definition, glossary, scope & tiers
  01-requirements/             functional / nonfunctional requirements, user workflows, traceability
  02-narrative-identity/       output-language + narrative-tradition architecture, profiles, genre catalog,
                               English prose & structure lint, drift detection, dialogue register, terminology
  03-story-planning/           hierarchical planning, promise ledger, chapter contracts
  04-memory-canon/             context/memory, canon & temporal state, character knowledge, context packs, retrieval
  05-generation/               generation pipeline, evaluation & revision, prompt architecture, role catalog
  06-system/                   system, data, API, workflow reliability, cost/observability, security/rights, UI
  07-quality/                  testing strategy, fixture story, definition of done
  08-delivery/                 roadmap, backlog, risks, open questions, handoff guide, plan audit
  adr/                         architecture decision records
schemas/                       JSON Schema (2020-12) for the core machine-readable objects
examples/                      example instances of the schemas (English fixture story data, narrative profiles)
tools/                         planning-package validator (schemas + $ref resolution, examples, canon-delta union,
                               evidence offsets against fixture manuscripts, cross-file references, stale terms,
                               truthfulness checks) — run in CI
```

## Naming and language conventions

- **Yeonjae (연재)** = "serialization" — the product is a serialized-fiction production studio.
- Documents are written in English. Korean appears only as **terminology** (names of the tradition's craft
  concepts such as 사이다, 회귀, 상태창, always glossed in English), as **source-culture notes**, or inside
  the **terminology and naming policies** that decide how such terms are rendered in English manuscripts.
- Domain terms are defined once in `docs/00-overview/02-glossary.md` and used consistently everywhere else.
- Language-bearing text fields in schemas are language-neutral (`text`, `summary`, `statement`) with
  explicit `language` metadata where the language can vary; **manuscript text is English (`en`)**.

## Validation

```
pip install jsonschema
python3 tools/validate-planning-package.py        # exit 0 = green; --quiet hides per-file [ok] lines
```

## Non-goals of this repository state

- No secrets, keys, or credentials. Provider configuration is described, never populated.
