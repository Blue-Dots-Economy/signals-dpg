# Pull requests: one PR per block, stacked

Applies to every change you open a pull request for. A change that touches several blocks of the monorepo ships as one PR per block, linked as a GitHub stack, so each PR stays small enough to review. This rule has no `paths` frontmatter, so it loads in every session.

## Blocks

Each block is one PR. Listed bottom to top; this is also the stack order.

| # | Block | Holds |
| --- | --- | --- |
| 1 | Shared packages | `packages/*` |
| 2 | API | `apps/api`, including `apps/api/db`, `apps/api/drizzle` and the root `openapi.json` that `spec:dump` regenerates |
| 3 | UI | `apps/ui` |
| 4 | Infra, config and docs | `infra/`, `docker/`, `local-setup/`, `local-mail-sink/`, `scripts/`, `docs/`, `draft/`, `examples/`, `.github/`, root files, `AGENTS.md` and the root `CLAUDE.md` |

- Open a PR only for the blocks the change touches.
- A block's own tests and its own `CLAUDE.md` go in that block's PR.
- A block may depend only on blocks below it. Each PR must typecheck, lint and pass its tests on top of the PRs below it.
- `pnpm-lock.yaml` goes with the lowest PR whose `package.json` changes.

## One PR for several blocks

A change in one block is always one PR.

A change across several blocks may go in one PR only when both are true:

1. The whole change is at most **10 files** and **300 changed lines** (added plus removed, from `git diff --shortstat origin/<target branch>`). The regenerated `openapi.json` and `pnpm-lock.yaml` do not count.
2. The user approves it explicitly, in this session, for this change.

To ask, state the blocks touched, the file and line counts, and why one PR reviews better than a stack. Without a clear yes, split it. Approval for one change does not carry over to the next.

## Stacks

Use GitHub stacks through the `gh stack` extension (`gh extension install github/gh-stack`).

1. Start from the branch the work targets, usually `feature`: `gh stack init --base feature <branch-for-block-1>`. Name branches `<type>/<topic>-<block>`, for example `feat/item-retire-packages`, `feat/item-retire-api`.
2. Commit the lowest block, then `gh stack add <next-branch>` and commit the next block. Repeat up the stack.
3. `gh stack push`, then `gh stack submit`. This opens one PR per branch, sets each PR's base to the branch below, and links them as a stack. With `--auto` the PRs open as drafts; add `--open` when they are ready for review.
4. Give each PR description its place in the stack: "Part 2 of 3", what the PRs below provide, and that the stack merges bottom up.
5. Review comments on a lower PR: fix them on that branch, then `gh stack rebase --upstack` and `gh stack push` to carry the fix up.
6. Merge bottom up. After a PR merges, `gh stack sync` rebases the rest onto the target branch and retargets the next PR.

`gh stack modify` reorders or removes branches. It needs a clean working tree and fails once a PR in the stack is merged or queued.

## CI on stacked PRs

`ci.yaml` runs on pull requests into `main`, `develop`, `feature` and `release/**` only. Every PR above the bottom of a stack has another branch as its base, so it gets no CI run of its own.

- After each push, start CI for every upper branch: `gh workflow run ci.yaml --ref <branch>`.
- Check it with `gh run list --workflow ci.yaml --branch <branch>` and report the result. Do not ask for review on a red or unchecked layer.
- When a lower PR merges and the next one retargets to the target branch, its CI runs as usual.
