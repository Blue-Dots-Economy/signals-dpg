# Signals-DPG MCP Server — Design

**Status:** Draft for review
**Date:** 2026-05-26
**Scope:** v1 — minimum surface required by current consumers; extensions deferred.

---

## 1. Overview

A new HTTP service inside the Signals-DPG monorepo that exposes a subset of Signals APIs as Model Context Protocol (MCP) tools.

- **Consumer model:** any agent runtime that speaks MCP can register the server as a tool source. Initial consumer is `ai-diffusion-dpg`'s action_gateway via its existing MCP adapter; the server is built generically and does not depend on the consumer.
- **Deployment model:** **one MCP process per network**. A single binary, parameterised by a config file path (e.g. one process for `blue_dot`, another for `yellow_dot`).
- **Implementation model:** **config-driven**. Tool names, descriptions, parameters, request bodies, and response projections all come from a YAML config — the server binary contains no per-network logic.

---

## 2. Goals and non-goals

**Goals**

- Expose the Signals endpoints needed by today's consumer as MCP tools, with consumer-facing schemas (tool name, description, input shape) defined entirely in config.
- Reuse the existing Signals-DPG network-schema source of truth (`examples/schemas/<network>/network.json` via `@dpg/config`'s loader).
- Forward consumer-supplied auth headers (`x-api-key`, `x-acting-org-id`) to Signals unchanged for endpoints that need them; require nothing for public endpoints.
- Run cleanly inside the existing pnpm + Turborepo workspace, share TypeScript / Node tooling with `apps/api`.

**Non-goals (v1)**

- Schema-discovery tools (`list_schemas`, `get_schema_by_url`).
- Match-score, event, action-listing, action-status-update, contact-details (PII reveal), or item CRUD tools.
- Validating the LLM's tool-call arguments against the network item schema before forwarding (Signals already validates server-side; pass-through is sufficient).
- Multi-network in a single process.
- Helm chart / production deployment manifests.
- OpenTelemetry tracing.

---

## 3. Scope of v1: four tools, three endpoints

| Tool          | Method | Signals path                        | Auth headers required |
| ------------- | ------ | ----------------------------------- | --------------------- |
| `fetch_profile` | POST | `/api/v1/network/item/fetch_local`  | none |
| `fetch_jobs`    | POST | `/api/v1/network/item/fetch_local`  | none |
| `save_profile`  | POST | `/api/v1/admin/participant`         | `x-api-key`, `x-acting-org-id` |
| `apply_job`     | POST | `/api/v1/action/perform`            | `x-api-key`, `x-acting-org-id` |

Tool semantics, body templates, parameter lists, and response projections are taken from the existing
`action_gateway/config/<network>/action_gateway.yaml` definitions as the v1 contract.

---

## 4. Architecture

```
┌────────────────────────┐       Streamable HTTP MCP             ┌────────────────────────────┐
│  MCP consumer          │  ───────────────────────────────►     │  Signals-DPG MCP server    │
│  (any MCP client;      │   POST /mcp                           │  apps/mcp                  │
│   e.g. action_gateway  │   Optional headers:                   │                            │
│   MCP adapter)         │     x-api-key                         │  - tool registry (config)  │
│                        │     x-acting-org-id                   │  - body-template renderer  │
└────────────────────────┘                                       │  - response projector      │
                                                                 │  - Signals HTTP client     │
                                                                 └──────────────┬─────────────┘
                                                                                │
                                                                                │  Forwards x-api-key
                                                                                │  and x-acting-org-id
                                                                                │  when the tool needs them.
                                                                                ▼
                                                                 ┌────────────────────────────┐
                                                                 │  Signals API               │
                                                                 │  apps/api                  │
                                                                 │  (existing auth_middleware)│
                                                                 └────────────────────────────┘
```

Key properties:

- The MCP server **holds no credentials**. It is a stateless protocol adapter.
- It loads the network schema once at startup via the same `@dpg/config` loader the API uses, so schema changes flow through the existing operational story (rebuild + restart, configurable source).

---

## 5. Repository layout

New top-level package, sibling to the existing apps:

```
apps/
  api/
  docs/
  mcp/                              ← new
    package.json
    tsconfig.json
    Dockerfile
    src/
      server.ts                     entrypoint: transport + lifecycle
      config.ts                     YAML loader + Zod validator
      tool_registry.ts              MCP tool definitions from config
      body_template.ts              parameter substitution into request bodies
      projection.ts                 field-selection over Signals responses
      signals_client.ts             HTTP client (fetch wrapper), forwards headers
      logger.ts                     pino logger (matches apps/api style)
    configs/
      blue_dot.yaml                 starter config for the blue_dot network
  ui/
```

Packages reused (no changes required):

- `@dpg/config` — `loadNetworkConfigs()`, `network_config_source`, `network_config_local_file`, `served_domains`, etc.
- `@dpg/schemas` — `parseNetworkConfigDocument()` for runtime validation of the loaded `network.json`.

Workspace alias `@mcp/*` → `apps/mcp/src/*` follows the existing alias pattern.

---

## 6. Configuration

### 6.1 Process inputs (environment variables)

All env vars are validated in `@dpg/config/src/secrets.ts` per project convention and added to `turbo.json`'s `globalPassThroughEnv`.

| Variable | Purpose | Default |
|---|---|---|
| `MCP_CONFIG_PATH` | Path to the YAML config file. Implies which network the process serves. | (required) |
| `MCP_PORT` | TCP port the Streamable HTTP transport listens on. | `9100` |
| `SIGNALS_API_BASE_URL` | Base URL for outbound calls to Signals (e.g. `http://localhost:2742`). | (required) |
| `NETWORK_CONFIG_SOURCE` | Reused from `@dpg/config`. Determines local-file vs remote schema source. | (per existing apps/api wiring) |
| `NETWORK_CONFIG_LOCAL_FILE` | Reused from `@dpg/config` — points at `examples/schemas/<network>/network.json` (or equivalent). | (per existing apps/api wiring) |
| `LOG_LEVEL` | pino level. | `info` |

The MCP server does **not** read or store `x-api-key` / `x-acting-org-id` from env. Those headers are taken from the per-request context (see §8).

### 6.2 Config file shape

The shape mirrors `action_gateway`'s `tools[]` block so a single mental model covers both REST and MCP tool definitions across the org. Fields that are meaningful only in `action_gateway`'s adapter selection (`type`, `category`, `base_url`, `health_check`) are dropped — the MCP server handles only Signals-bound REST tools, against one configured base URL.

```yaml
# apps/mcp/configs/blue_dot.yaml

network: blue_dot

tools:
  - id: fetch_jobs
    description: |
      Search the blue_dot provider network for live job postings,
      filtered by jobProviderLocation. Returns role, company name,
      location, positions, nature_of_job, and pay-model fields
      (salary / stipend / task_rate). Hiring-manager PII is not
      projected.
    auth_required: false
    endpoint:
      method: POST
      path: /api/v1/network/item/fetch_local
    body_template:
      item_network: blue_dot
      item_domain: provider
      item_type: job_posting_1.0
      item_state:
        jobProviderLocation: "{location}"
      limit: 20
      offset: 0
    params:
      - name: location
        type: string
        required: true
        description: >
          City to filter jobs by. Match is server-side and EXACT —
          use the canonical spelling.
    response:
      max_size_chars: 4000
      projection:
        list_key: items
        fields:
          item_id: item_id
          role: item_state.role
          company: item_state.jobProviderName
          location: item_state.jobProviderLocation
          positions: item_state.positions
          nature_of_job: item_state.natureOfJob
          salary_min: item_state.salaryMin
          salary_max: item_state.salaryMax
          stipend_min: item_state.stipendMin
          stipend_max: item_state.stipendMax
          task_rate_min: item_state.taskRateMin
          task_rate_max: item_state.taskRateMax
          candidate_experience_type: item_state.candidateExperienceType
          work_experience_years: item_state.workExperienceYears
          min_educational_institute: item_state.minEducationalInstitute
          last_role_held: item_state.lastRoleHeld

  - id: save_profile
    description: |
      Create or update a seeker profile via the participant upsert.
      Omit item_id for CREATE; include the existing profile's item_id
      for UPDATE. Returns the upserting user_id (= acting_as_user_id
      for apply_job) and the affected profile(s) in `items`.
    auth_required: true
    endpoint:
      method: POST
      path: /api/v1/admin/participant
    body_template:
      name: "{name}"
      phone_number: "+91{user_id}"
      terms_accepted: true
      privacy_accepted: true
      channel: "voice"
      source_id: "{source_id}"
      network: "blue_dot"
      domain: "seeker"
      item_type: "profile_1.0"
      item_id: "{profile_item_id}"
      item_state:
        name: "{name}"
        phone: "{user_id}"
        gender: "{gender}"
        location: "{location}"
        age: "{age}"
        workExperience: "{work_experience}"
        workExperienceYearsConditional: "{experience_years}"
        nameOfJobRolesInterestedIn: "{trade}"
        highestQualificationOrSkill: "{qualification}"
        natureOfJobsInterestedIn: "{job_nature}"
        otherHelpNeeded: "{help_needed}"
    params:
      # required
      - { name: name,             type: string,  required: true,  description: "Caller's full name." }
      - { name: user_id,          type: string,  required: true,  description: "Caller's 10-digit phone number." }
      - { name: gender,           type: string,  required: true,  description: 'Gender (e.g. "Male", "Female", "Other").' }
      - { name: location,         type: string,  required: true,  description: "City the caller is in / wants to work." }
      - { name: age,              type: integer, required: true,  description: "Caller's age in years (14–65)." }
      - { name: work_experience,  type: string,  required: true,  description: 'One of "Fresher" / "Worked before" / "Returning after a break".' }
      - { name: source_id,        type: string,  required: true,  description: "Outbound number tagging the channel source." }
      # optional
      - { name: profile_item_id,  type: string,  required: false, description: "Existing profile's item_id (UPDATE path). Omit for CREATE." }
      - { name: experience_years, type: string,  required: false, description: "workExperienceYearsConditional enum value." }
      - { name: trade,            type: string,  required: false, description: "Intended job role." }
      - { name: qualification,    type: string,  required: false, description: "highestQualificationOrSkill enum value." }
      - { name: job_nature,       type: string,  required: false, description: "natureOfJobsInterestedIn enum value." }
      - { name: help_needed,      type: string,  required: false, description: "otherHelpNeeded enum value." }
    response:
      max_size_chars: 4000
      projection:
        fields:
          user_id: user_id
          user_existed: user_existed
          items: items
```

(Full `fetch_profile` and `apply_job` definitions follow the same pattern and are checked into `apps/mcp/configs/blue_dot.yaml`.)

### 6.3 Config validation

A Zod schema validates the YAML at startup. Failure to validate is a fatal startup error — the process exits with a clear message naming the offending field path.

Validation rules:

- `id` is unique across all tools in the config.
- `endpoint.method` ∈ `{ GET, POST, PATCH, DELETE }`.
- Every `{placeholder}` referenced in `body_template` corresponds to a declared `params[].name`.
- `params[].required: true` for any placeholder that appears outside an optional pruning rule.
- `response.projection` field paths are syntactically valid dot-path strings.

### 6.4 Body-template rules

- Placeholder substitution is recursive over the YAML tree (strings only).
- A required param missing at call time → MCP tool error before any Signals call.
- An optional param that resolves to `undefined`/`null`/`""` → the **enclosing field is dropped** from the rendered body. This preserves the `item_id`-omitted-for-CREATE behaviour the upstream relies on.

### 6.5 Response projection

Two modes, matching the existing convention:

- `list_key + fields` — pull an array from `body[list_key]` and project each element.
- `fields` only — project a single top-level object.

Field paths are dot-separated (`item_state.name`). Implementation is a small walker; no JSONPath library needed.

After projection, the JSON is serialised and truncated to `response.max_size_chars` (default 4000). Truncation is logged with a counter for visibility.

---

## 7. Network schema loading

At startup:

1. Read `MCP_CONFIG_PATH` → parse YAML → Zod-validate.
2. Call `@dpg/config`.`loadNetworkConfigs({ source, localFile, remoteUrls, servedDomains, schemaRegistryUrls })` with the same env-driven inputs the API uses, restricted to the single network named in the config file.
3. Validate the resulting document via `@dpg/schemas`.`parseNetworkConfigDocument()`.
4. Cache in memory for the process lifetime.

The schema is **not** used to derive tool input schemas in v1 — tool params come from config. The loaded schema is held in memory for two reasons:

- Sanity-check at startup that the `body_template`'s `item_network` / `item_domain` / `item_type` triples exist in the network schema. Mismatch → fatal error.
- Future extension: auto-enrich param descriptions with enum lists pulled from the schema (deferred).

Schema changes require a restart — same operational story as `apps/api`.

---

## 8. Auth: pure header pass-through

The MCP server never reads, stores, or generates Signals credentials.

For each tool invocation:

```
if tool.auth_required:
    if request.headers does not contain x-api-key:
        return MCP error "missing_auth: x-api-key"
    if request.headers does not contain x-acting-org-id:
        return MCP error "missing_auth: x-acting-org-id"
    outbound.headers[x-api-key]      = request.headers[x-api-key]
    outbound.headers[x-acting-org-id] = request.headers[x-acting-org-id]
else:
    # no auth headers attached
```

Implementation note: the MCP HTTP transport (Streamable HTTP via `@modelcontextprotocol/sdk`) exposes the incoming HTTP request per-connection. The server stores the auth headers in a per-call context (e.g. AsyncLocalStorage) keyed by the MCP `tools/call` invocation, then reads them when constructing the Signals request.

**Out-of-band consequence:** anyone with network reach to the MCP server can invoke public-endpoint tools (`fetch_profile`, `fetch_jobs`) without credentials, because the underlying Signals endpoint is itself public. Network-level controls (private network, internal-only DNS, ingress allowlist) are the operator's responsibility — the security posture matches `network/item/fetch_local` as it exists today.

---

## 9. Transport

**Streamable HTTP** (MCP spec 2025-03-26 and later) via `@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport`.

- Bound to `MCP_PORT` (default `9100`).
- Single mount path `/mcp` (POST and GET as the spec requires).
- One server instance per process. Concurrent client sessions are supported by the SDK.
- No additional HTTP routes in v1 — no `/health`, no `/ready`. Liveness/readiness check is performed via an MCP `tools/list` round-trip when needed.

SSE transport is not supported (deprecated in the spec).

---

## 10. Error model

The server never throws to the transport. Every failure path returns an MCP `isError: true` tool result with a structured error code in the text content:

| Code | When |
|---|---|
| `missing_required_param: {name}` | A required `params[]` entry has no value at call time. |
| `unknown_param: {name}` | The caller supplied a parameter not declared in the tool's `params[]`. |
| `missing_auth: {header}` | A private tool was called without one of the required auth headers. |
| `signals_error: {http_status}` | Signals returned a 4xx/5xx. The truncated body is included verbatim. |
| `signals_unreachable: {message}` | Network error, DNS failure, TLS error, etc. |
| `signals_timeout` | Outbound request exceeded the per-tool timeout (default 5000 ms, configurable per tool). |

Startup-time failures (config invalid, schema missing, port in use) exit the process non-zero with a single-line stderr message.

---

## 11. Logging and observability (v1)

- **Logger:** pino, matching the format used by `apps/api`.
- **Per-call log fields:** `tool_id`, `signals_status`, `latency_ms`, `outcome` (`success` / `signals_error` / `unreachable` / `timeout` / `missing_auth`), `param_keys` (names only, not values — params may carry PII).
- **Counters:** total tool calls, errored tool calls, truncated responses. Exposed via pino info logs in v1 (Prometheus scrape can be added later without changes to the call-path code).
- **OpenTelemetry:** out of scope for v1. `apps/api` does not emit OTel today; staying consistent.

---

## 12. Deployment (v1)

Local dev only. No Helm chart in v1.

Additions to `docker-compose.yaml`:

```yaml
services:
  mcp:
    build:
      context: .
      dockerfile: apps/mcp/Dockerfile
    environment:
      MCP_CONFIG_PATH: /etc/mcp/blue_dot.yaml
      MCP_PORT: 9100
      SIGNALS_API_BASE_URL: http://api:2742
      NETWORK_CONFIG_SOURCE: local_file
      NETWORK_CONFIG_LOCAL_FILE: /repo/examples/schemas/blue_dot/network.json
      LOG_LEVEL: info
    ports:
      - "9100:9100"
    volumes:
      - ./apps/mcp/configs/blue_dot.yaml:/etc/mcp/blue_dot.yaml:ro
      - ./examples/schemas:/repo/examples/schemas:ro
    depends_on:
      - api
```

`apps/mcp/Dockerfile`: multi-stage Node 24 image, identical pattern to `apps/api/Dockerfile`. The image is per-network-agnostic — the network is selected by the mounted config file, not baked into the image.

Helm chart, ingress, and production rollout are intentionally deferred. The deployment shape (one Deployment + one Service per network) will mirror `apps/api`'s when added.

---

## 13. Implementation plan

Suggested PR sequence; each PR is independently reviewable and deployable.

1. **Scaffold `apps/mcp`** — `package.json`, `tsconfig.json`, `vitest.config.ts`, empty `server.ts`, workspace wiring (`pnpm-workspace.yaml` update, `turbo.json` `globalPassThroughEnv` additions for the new env vars).
2. **Config loader + Zod schema** — `config.ts` with unit tests for accept/reject cases.
3. **Body template + projection** — `body_template.ts`, `projection.ts` with unit tests covering optional-field pruning and nested-path projection.
4. **Signals HTTP client** — `signals_client.ts` with `fetch` + header forwarding + timeout + error mapping.
5. **MCP server wiring** — `server.ts` mounts `StreamableHTTPServerTransport`, registers tools from the parsed config, and dispatches `tools/call` through the components from (3) and (4).
6. **Sample config + docker-compose integration** — `apps/mcp/configs/blue_dot.yaml`, docker-compose entry, smoke test invoking each of the four tools via the MCP Inspector or a small TS script.
7. **Integration test** — opt-in vitest suite that boots the MCP server + a fake Signals upstream and exercises all four tools end-to-end.

---

## 14. Open items (tracked for future, not blocking v1)

- **Consumer-side MCP-adapter extensions** (e.g. `ai-diffusion-dpg/action_gateway/src/adapters/mcp.py`): add per-server custom headers (so `x-api-key` / `x-acting-org-id` can be forwarded) and a `tools_allowlist` to scope which tools each consumer registers. Tracked separately; lives outside this repo.
- **Schema-derived param enrichment** — append enum lists from the network schema to tool param descriptions.
- **Additional tools** — schema discovery (`list_schemas`, `get_schema_by_url`), `calculate_match_score`, action listing, action-status update. Added when a consumer needs them.
- **Helm chart** — add Deployment + Service templates under `helmcharts/dpg/templates/mcp/`.
- **OpenTelemetry tracing** — adopted alongside the rest of the repo.
- **Multi-tenant variant** — a single MCP process serving multiple networks. Defer until there is concrete demand; v1's per-network deployment is intentionally simpler.
