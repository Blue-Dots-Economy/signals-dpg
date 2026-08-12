# CLAUDE.md — packages/config

Zod env schemas, allowed-origins lists, network-config loader, consent-config loader. Root `CLAUDE.md` already has the load-bearing rule: **when adding an env var, update both `secrets.ts` and `turbo.json`'s `globalPassThroughEnv`.** This doc covers the two loaders' non-obvious behavior beyond that.

`email_messages_loader.ts` (#529) mirrors `consent_config_loader.ts`'s local-mode discovery — a network's default `messages.properties` sits beside its `network.json`, brand overrides live in immediate sub-folders — but returns raw file text only (no parsing/merge); that lives in `apps/api/src/notifications/email/messages.ts`.

## `network_config_loader.ts` — local vs remote, and "one-hop" cross-network loading

`loadNetworkConfigs` has two source modes (`NETWORK_CONFIG_SOURCE`):
- **`local`** — reads a single `network.json` file from disk (`NETWORK_CONFIG_LOCAL_FILE`). Exactly one network config, no fetch.
- **`remote`** — resolves URLs from either `NETWORK_CONFIG_URLS` or `SCHEMA_REGISTRY_URL` (+ served domains), then fetches each over HTTP via the schema registry (`fetchSchema`, `packages/schemas`).

**Both modes then always pass through `loadOneHopCrossNetworkConfigs`.** This walks every base config's `cross_network_origins` list and fetches any origin not already loaded — but it does **not** recurse into what it just fetched; a cross-network origin's *own* `cross_network_origins` are never followed. This is an intentional depth limit (one hop), not an oversight — don't "fix" it into a transitive closure without understanding why it was capped (an unbounded network graph would make config load time depend on how interconnected any network happens to be). One consequence worth knowing: even in `local` mode, if the one local `network.json` declares `cross_network_origins`, those *are* fetched remotely — "local mode" only means the network's own config is local, not that the whole load is offline.

## `consent_config_loader.ts` — brand overrides + the support-email placeholder

- **Brand overrides**: in local mode, a network's default `consent.json` sits beside its `network.json`; each immediate sub-folder is a brand id, and a brand's `consent.json` there is a **partial** override (every top-level document optional — unset ones fall back to the network default). See `.claude/rules/consent-v1.md` for what the documents themselves mean; this loader only owns *which file* wins for a given `(network, brand)` pair.
- **`__SUPPORT_EMAIL__` placeholder**: consent copy ships this literal token; the loader substitutes it with `CONSENT_SUPPORT_EMAIL` (default `hello@bluedotseconomy.org`) at load time, so the address is deploy-time configurable without editing consent content. This is distinct from `SUPPORT_EMAIL` (the contact-form recipient, unrelated env var) — don't conflate the two when debugging a wrong support address somewhere.
- `CONSENT_CONFIG_SOURCE=remote` is currently a stub that returns `[]` — remote consent config loading isn't implemented yet.
