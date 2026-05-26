/**
 * Canonical implementation lives at apps/api/scripts/e2e/seed_actions.mts
 *
 * This file intentionally stays here so the scripts/e2e/ tree is the
 * documented home for E2E fixtures, but the runnable copy must live under
 * apps/api/ so that drizzle-orm, pg, and @dpg/* resolve via apps/api/node_modules.
 * (ESM bare-specifier resolution walks upward from the *file* location, not cwd.)
 *
 * Use the root package.json script:
 *   pnpm e2e:actions
 *
 * Which runs:
 *   pnpm --filter api exec tsx scripts/e2e/seed_actions.mts
 *   (resolved as apps/api/scripts/e2e/seed_actions.mts by the api workspace)
 */
console.error(
  'Run this script via the workspace: pnpm e2e:actions\n' +
  'Or directly: pnpm --filter api exec tsx scripts/e2e/seed_actions.mts',
);
process.exit(1);
