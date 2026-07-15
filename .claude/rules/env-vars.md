---
paths:
  - "packages/config/src/secrets.ts"
  - "turbo.json"
---

# When adding env vars

Two places must change together: the Zod schema in `packages/config/src/secrets.ts` (so validation passes) AND `turbo.json` `globalPassThroughEnv` (so the var actually reaches filtered tasks). Forgetting the latter is the classic "works locally, fails in `pnpm dev:api`" bug.
