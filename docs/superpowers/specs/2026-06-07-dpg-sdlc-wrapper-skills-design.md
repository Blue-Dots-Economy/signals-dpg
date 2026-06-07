# DPG SDLC Wrapper Skills — Design

**Date:** 2026-06-07
**Author:** Abhishek Gaddi
**Status:** Approved design, pending implementation plan

## Problem

`aggregator-dpg` and `Signals-DPG` share a stack (pnpm/Turborepo, Fastify + Zod +
Drizzle, React UI) and a large set of DPG conventions (network/domain/item vocab,
two fetch paths, two auth paths, partitioned item tables, env-var-in-two-places,
routes-never-throw). A large global skill library is already installed
(superpowers, gstack, everything-claude-code, commit-commands, code-review).

Generic SDLC skills (brainstorm, design review, commit, PR review, TDD, ship)
already exist globally. What is missing is **project context injection** so those
generic skills apply DPG conventions automatically instead of relying on the
operator to remember them each time.

## Decision

Build **thin wrapper skills** that delegate to existing global skills and layer a
DPG context + checklist on top. Do not reimplement generic behavior.

Skills live at **user level** (`~/.claude/skills/`) and are **repo-aware** — one
copy serves both repos, detecting which repo it runs in. No per-repo duplication.

## Scope

Seven skills + one shared reference file:

```
~/.claude/skills/
  dpg-shared/context.md      # shared reference (NOT a skill)
  dpg-brainstorm/SKILL.md
  dpg-design/SKILL.md
  dpg-commit/SKILL.md
  dpg-review/SKILL.md
  dpg-test/SKILL.md
  dpg-ship/SKILL.md
  dpg-feature/SKILL.md       # generalized from aggregator's implement-feature
```

## Architecture

### Repo detection (every skill, step 1)

```bash
git remote get-url origin   # match aggregator-dpg | Signals-DPG
```

Map to a **repo profile**:

| | aggregator-dpg | Signals-DPG |
|---|---|---|
| PR base branch | `feature` (per memory: base on feature, not develop) | `develop` |
| Feature docs | `docs/issues/platform/P-NN-features.md`, `docs/issues/product/PH-N-features.md` | same structure (confirmed) |

If neither repo is detected, the skill states so and stops rather than guessing.

### Shared context (`dpg-shared/context.md`)

Single source of truth that every wrapper reads first. Contents:

- DPG vocab: network / domain / instance / item / action / event; `item_type` is a
  schema id (e.g. `profile_1.0`), never freeform.
- `item_instance_url` / `item_schema_url` are backend-generated; clients never set
  them.
- Two fetch paths: `GET /api/v1/item/fetch` (instance-local) vs
  `GET /api/v1/network/item/fetch` (inter-instance).
- Two auth paths: apikey (`x-api-key`, hard 403 on invalid) vs session; admin needs
  `x-acting-org-id`; `AUTH_MIDDLEWARE_ENABLED` kill switch.
- Partition-aware item tables — use `@dpg/database` helpers, never bare parent scans.
- Env vars: add to `packages/config/src/secrets.ts` **and** `turbo.json`
  `globalPassThroughEnv`.
- Routes never throw — `reply.code(N).send({ error, message })`, handle PG `23505` /
  `23503` explicitly.
- Naming: files snake_case, route exports snake_case, handlers camelCase, Zod
  PascalCase, DB columns snake_case. ESM only, no `any`.
- Codacy MCP rule: run `codacy_cli_analyze` after edits.

Editing a convention happens here once; all skills inherit it.

### Wrapper pattern (uniform shape)

1. Read `dpg-shared/context.md`; detect repo + load profile.
2. Invoke the wrapped global skill via the `Skill` tool.
3. Apply the DPG checklist layered on top.

This works because a SKILL.md is instructions to the agent; "invoke skill X then
apply checklist Y" is followed sequentially.

### Per-skill behavior

| Skill | Step 2 invokes | Step 3 DPG layer |
|---|---|---|
| `dpg-brainstorm` | `superpowers:brainstorming` | force DPG vocab; ask which network/domain; spec → `docs/superpowers/specs/` |
| `dpg-design` | `gstack:plan-eng-review` | verify: auth path chosen, partition keys present, env-var dual-write, `@dpg/*` imports, fetch-path layer chosen |
| `dpg-commit` | `commit-commands:commit` | conventional scope (`feat(item):`); branch base per profile; `Co-Authored-By` trailer |
| `dpg-review` | `/code-review` | routes-never-throw, PG `23505`/`23503`, no client-set `item_*_url`, partition-scan check, Codacy |
| `dpg-test` | `superpowers:test-driven-development` | vitest unit vs `*.integration.test.ts`; `pnpm --filter api test`; partition-aware helpers; `AUTH_MIDDLEWARE_ENABLED` |
| `dpg-ship` | `gstack:ship` | PR → profile base branch; `pnpm schema:bundle:check`; `pnpm typecheck` gate |
| `dpg-feature` | (own logic; from existing `implement-feature`) | repo-aware doc paths; F-NN → sub-issues → branch → commit-per-task → PR |

### dpg-feature generalization

Start from `aggregator-dpg/.claude/skills/implement-feature/SKILL.md`. Replace
hard-coded `aggregator-dpg` assumptions (doc paths, PR base) with repo-profile
lookups. Both repos confirmed to share the F-NN issue/doc + GitHub sub-issue flow.
Once `dpg-feature` is verified, the old per-repo `implement-feature` can be removed
(separate step, not part of initial build).

## Error handling / edge cases

- Unknown repo → skill stops with a clear message, no guessing.
- A wrapped global skill missing/renamed → skill names the expected skill and asks
  the operator how to proceed.
- `dpg-shared/context.md` is reference only; if a convention drifts from CLAUDE.md /
  AGENTS.md, those repo docs win (they are higher priority per superpowers rules).

## Testing / verification

Skills are markdown, not code. Verification = dry-run each skill in both repos:
confirm repo detection picks the right profile, the wrapped skill loads, and the
checklist surfaces. `dpg-feature` verified against one real F-NN issue per repo
before retiring `implement-feature`.

## Out of scope

- Rewriting generic skill behavior.
- A shared npm package / build step (considered, rejected as overkill).
- Removing `implement-feature` (deferred until `dpg-feature` is proven).
