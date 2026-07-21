---
paths:
  - "apps/api/src/routes/v1/item/**"
  - "apps/api/src/routes/v1/network/**"
  - "apps/api/src/utils/inter_instance_fetch.ts"
  - "apps/api/src/utils/item_fetch_cache.ts"
---

# Two fetch paths (don't conflate)

- `GET /api/v1/item/fetch` — **instance-local** read; brief Redis cache. Used for "my own items" reads.
- `GET /api/v1/network/item/fetch` — **inter-instance** read. Does count-first discovery, picks only relevant peers, fetches slices, caches the merged result. Schema fetching and caching live here, not in the item-local layer.

When adding read endpoints, decide which layer they belong to before writing code. See `apps/api/CLAUDE.md` for the two caching TTLs involved (1s local vs domain-minimum inter-instance) and the "only complete aggregates get cached" invariant.
