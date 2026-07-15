# Blue Dots Economy — Security Audit & Hardening (Epic Design)

**Date:** 2026-07-15
**Status:** Design — awaiting review → writing-plans
**Umbrella host:** Signals-DPG (canonical node); child issues fan out per repo
**Branch:** `spec/security-audit` (Signals-DPG)

> **Disclosure note.** This is a *public* planning document. Concrete candidate
> vulnerabilities — exact `file:line` locations, reproduction steps, and exploit
> mechanics — are **NOT** recorded here. They live in **private GitHub Security
> Advisories** (one draft per repo) so that details of unremediated issues are not
> published before they are fixed. This document describes *scope, structure, and
> acceptance criteria* only.

---

## 1. Purpose & Scope

Stand up a **reusable security-audit capability** and run the **first full audit** against the
Blue Dots DPG ecosystem, then remediate. Delivered in three phases (harness → audit →
remediate/retest), so the harness is a lasting asset and the report is its first output.

### 1.1 Deliverable shape (phased)

- **Phase A — Harness & test cluster** (the reusable half): disposable multi-instance test
  cluster + SAST/SCA in CI + a Shannon runner and Rules of Engagement.
- **Phase B — Audit execution**: dynamic pentest (Shannon + manual), inter-instance/federation
  attack track, config/authz + secrets review — findings proven, not just listed.
- **Phase C — Remediation & retest**: fix by severity, re-run the relevant layer to prove closure.

### 1.2 Repos in scope

| Repo | Layers | Notes |
|---|---|---|
| **Signals-DPG** | all 4 | Canonical node; hosts federation endpoints + authz model |
| **aggregator-dpg** | all 4 | Portal + backend; Keycloak; bulk-write to Signals |
| **signals-search** | all 4 | postgres.js (raw SQL), pgvector/PostGIS, embeddings |
| **notification-service** | all 4 | Multi-channel send; HMAC; Redis queues |
| **ai-diffusion-dpg** | all 4, **lowest priority** | Python/FastAPI; only HTTP-exposing sub-packages for dynamic |
| **bluedots-allusecase-schemas** | config/authz review | JSON only; network.json / PII markers |
| **bluedots-automation** | secrets/infra review | Helm + OpenTofu; also the cluster provisioning vehicle |
| **bluedots-infra-deployments** | secrets review | **Remote repo — clone into workspace before Phase A/B** |

**Out of scope (documented decisions):** `match-engine` (redundant, unused),
`dpg-scoring` (being deprecated), `prototype-aggregator-campaign-manager`, `bluedots-docs`,
`signals-data_processing-layer`.

### 1.3 Networks

Three **independent** networks (no cross-network federation): **blue / orange / purple**.
The multi-instance trust boundary lives **within** each network (e.g. seeker instance +
provider instance federating via count-first discovery / slice aggregation).

- **blue** — stood up **live, multi-instance** as the primary Shannon + federation target
  (richest use case: 6-domain seeker/provider × national/KA/UP).
- **orange / purple** — covered by **config/authz review** (they differ from blue by use-case
  config, not code path), plus a lightweight single-instance stand-up only if a use case has
  unique runtime behavior worth exercising live.

> **Caveat surfaced during recon:** only **blue** and **yellow** have full network configs
> (`domains` + `actions` matrix) in the schemas repo; **orange** and **purple** ship *schema-only*
> files there. Per project convention the authoritative `network.json` source of truth is
> **Signals-DPG examples**, with the schemas repo as the downstream sync. B-Cfg reads the
> Signals-DPG copies as authoritative and treats schema-repo divergence as its own finding.

---

## 2. Epic Structure

Phase-gated at the top (hard dependency: can't dynamic-pentest without a cluster); repo-major
fan-out inside Phase B to match the "each directory is its own git repo / branch-per-plan /
rolling-PR-per-repo" workflow. Cross-cutting work that belongs to no single repo becomes a track.

```
Epic: Blue Dots Security Audit & Hardening
│
├── Phase A — Harness & Test Cluster
│   ├── A1  Multi-instance test cluster (bluedots-automation + infra-deployments)
│   ├── A2  SAST + SCA CI harness (per repo)          ← static; starts immediately
│   └── A3  Shannon runner + Rules of Engagement
│
├── Phase B — Audit Execution   (gated on A)
│   ├── Per-repo sub-epics: Signals-DPG · aggregator-dpg · signals-search ·
│   │                       notification-service · ai-diffusion-dpg (low)
│   │   each carries: dynamic-pentest sub-task + SAST/SCA-triage sub-task
│   ├── Track B-Fed  Inter-instance / federation attack (live blue pair)
│   └── Track B-Cfg  Config/authz + secrets review (schemas, automation, infra-deployments)
│
└── Phase C — Remediation & Retest   (gated on B)
    ├── Consolidated findings report (private; CVSS-ranked)
    ├── Per-repo remediation issues (by severity)
    ├── Retest / verification gate (re-run layer to prove closure)
    └── (spin-off) Inter-instance mutual-auth epic — too large for one remediation task
```

**Tracking:** GitHub umbrella issue on Signals-DPG; child issue per repo + per track; all on the
delivery board (org Project #1, "Blue Dots — Delivery"). Design doc on `spec/security-audit`;
brainstorm → spec → writing-plans. Promotions use merge-commits.

---

## 3. Phase A — Harness & Test Cluster

### 3.1 A1 — Multi-instance test cluster

- Provision via **bluedots-automation** Helm + **bluedots-infra-deployments** secrets, into a
  **dedicated disposable namespace/cluster distinct from demo/prod** (non-negotiable — Shannon
  mutates state and runs real exploits). Torn down after each cycle.
- **Topology:** blue network with ≥2 Signals-DPG instances split by domain (seeker + provider)
  that federate; shared-plane services (aggregator api+web+worker, signals-search query+ingest+TEI,
  notification-service, ai-diffusion HTTP packages) + backing Postgres/Redis(Valkey)/Keycloak.
- **Seed data:** users, orgs, domain-scoped items/profiles, API keys, acting-org identities —
  enough to exercise authz rules *and* authenticated Shannon logins.

**Seeding gotchas to bake in (from prior pain):**
1. **Service-identity seed gap** — `provision_service_users.sql` must actually seed
   org/user/member/apikey, and aggregator's pinned `actingOrgId` must reconcile with the seeded
   org id (otherwise 403 "Invalid API key" → 503 cascade).
2. **pgvector SIGILL** — Postgres nodes must be AVX-512-capable (m6i/m7i/m7a); on m6a, vector
   inserts crash the shared PG and signals-search testing is dead on arrival.

### 3.2 A2 — SAST + SCA CI harness

Wire into each in-scope repo's CI (static; runnable before the cluster exists):
- **SAST:** Semgrep / CodeQL for TS repos; Bandit / Semgrep-py for ai-diffusion (Python).
- **SCA:** `pnpm audit` + Trivy (deps + container images) for TS/Helm; `pip-audit` / `safety` for Python.
- Output feeds the per-repo **SAST/SCA triage** sub-tasks in Phase B.

### 3.3 A3 — Shannon runner + Rules of Engagement

- Containerized Shannon (`@keygraph/shannon`), Docker + Node 18+, Anthropic (Claude) provider creds.
- Target-URL set per instance + repo checkout paths (white-box).
- **Written RoE/authorization doc:** scope, explicit no-prod/no-demo, teardown obligation,
  test-credential rotation/destruction post-run. Shannon runs gated behind this doc.

---

## 4. Phase B — Audit Execution

**Finding model & disclosure.** Concrete candidate findings from the read-only recon sweep
(2026-07-15) are recorded in **private GitHub Security Advisories** (per repo) — not in this public
spec. This section defines, per repo/track, the **scope, the OWASP categories to exercise, and
acceptance criteria**. Each candidate is proven (or dismissed) in Phase B via Shannon PoC or manual
repro before it counts.

> Recon branch caveat: several repos were swept on non-`main` branches (docs/spec branches);
> re-verify against true `main` per repo at Phase B start.

### 4.1 Per-repo dynamic-pentest scope

Each repo's sub-epic runs Shannon + manual against its live instance, covering the OWASP classes
most relevant to its surface, plus triage of its Phase-A SAST/SCA output:

- **Signals-DPG** — broken access control / object-level auth (item & action ownership, acting-org
  assertion), authentication, server-side request forgery, injection, rate-limiting. Highest-value
  target (canonical node + federation surface).
- **aggregator-dpg** — authN/session (Keycloak), object-level auth on org-scoped data, admin
  approval flow, secret/key handling, CSRF, public-endpoint abuse.
- **signals-search** — injection (raw-SQL builder), sensitive-data exposure in results
  (PII/masking dependency), read-model data-integrity, auth model, resource exhaustion.
- **notification-service** — request-integrity/auth, injection/templating across channels,
  send-abuse / rate-limiting, secret handling, info disclosure.
- **ai-diffusion-dpg** (lowest sequencing) — access control on management/HTTP surfaces, authN,
  SSRF, LLM prompt-injection (LLM Top-10), CORS. *Some high-severity leads — may be fast-tracked.*

Candidate counts and exact locations: see the private advisory per repo.
**Acceptance:** every candidate has either a working PoC (with blast radius) or a documented
not-exploitable verdict.

### 4.2 Track B-Fed — Inter-instance / federation

Focused attack track against the live blue multi-instance pair. Goal: **prove + characterize +
document blast radius** of the federation trust boundary (Signals-DPG's own docs already note that
inter-instance calls are currently unauthenticated). The remediation — mutual authentication — is a
Phase-C spin-off epic, not part of this track. Endpoint-level findings: private advisory.

### 4.3 Track B-Cfg — Config/authz + secrets review

- **network.json / schemas (all 3 networks; Signals-DPG copies authoritative):** verify PII marking
  is present and *consistent* across networks, that searchable/embedded fields exclude PII, and that
  domain/action authz is defined per network. Findings: private advisory.
- **Secrets / infra (bluedots-automation + bluedots-infra-deployments):** review secret handling
  (defaults, at-rest, rotation), image provenance/pinning, RBAC, network exposure, pod security.
  **Blocked until bluedots-infra-deployments is cloned** (recon gap S0). Findings: private advisory.

---

## 5. Phase C — Remediation & Retest

- **Consolidated report** (private; Markdown in `local_docs/` or advisory) — all repos + tracks,
  CVSS-ranked, exec summary.
- **Per-repo remediation issues** prioritized by severity; PRs land in each repo (branch-per-plan).
- **Retest gate:** each finding closes only when the relevant layer is re-run to prove closure
  (Shannon re-run fails / manual PoC no longer works / scanner clean).
- **Spin-off epic:** inter-instance **mutual authentication** (verified peer identity for the
  client-facing `network/*` endpoints, network egress controls, and tighter acting-org
  authorization). Too large for a single remediation task; referenced from B-Fed.

---

## 6. Severity, Reporting, Safety

- **Severity:** CVSS v3.1 (Critical/High/Med/Low). A finding is real only once proven in Phase B.
- **Finding record (in private advisory):** title, CVSS, repo, `file:line`, reproduction,
  impact/blast-radius, remediation.
- **Safety / RoE:** written authorization doc; test cluster only, never prod/demo; disposable env
  torn down after; test credentials rotated/destroyed post-run; Shannon gated behind RoE.

---

## 7. Open Items

1. Clone **bluedots-infra-deployments** into the workspace (unblocks B-Cfg secrets-at-rest, S0).
2. Confirm authoritative orange/purple `network.json` location (Signals-DPG examples vs schemas repo).
3. Re-verify every target list against true `main` per repo at Phase B start (recon branches noted).
4. Decide whether the ai-diffusion high-severity leads are fast-tracked ahead of its low sequencing.
