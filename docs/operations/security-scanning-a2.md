# Security Scanning in CI (A2) — DevOps Explainer

**Audience:** DevOps / platform engineer picking up signals-dpg issue **#300** (`[Sec-Audit][A2] SAST + SCA in CI`).
**Part of:** Blue Dots Security Audit & Hardening epic (**#307**). This doc is the implementation companion to #300.
**Status:** plan — reusable workflow drafted, not yet committed or wired.
**Baseline verified:** fresh from each repo's `feature`/`main` + live GitHub API (not local checkouts).

---

## TL;DR

Dependency scanning **already exists** — native Dependabot is on for most repos and has surfaced **~144 open vulnerable-dependency alerts** today. What's missing is **code scanning (SAST), container-image + IaC scanning, and secret scanning** — none of which exist, on top of one repo (ai-diffusion) that has no CI at all. A2 fills those gaps and routes everything into each repo's **Security tab** (SARIF), which is the backlog Phase B triages. Start in **report-only** mode, then ratchet to blocking after triage.

---

## 1. Why this exercise is needed

### 1.1 The context
Six repos, all **public**, serving a live network with real participant data (incl. PII). Public + real-data means a vulnerability is discoverable by anyone and exploitable against real users. The security epic (#307) runs in three phases:

- **Phase A — instrument** (where A2 / #300 lives): stand up the scanning + test harness. Static; runnable *now*.
- **Phase B — audit**: run the live pentest and **triage** what the scanners surfaced.
- **Phase C — remediate & retest**.

A2 makes the rest possible: **you can't triage findings you never collected.**

### 1.2 What already exists vs. what's missing (fresh baseline)

| Repo | CI | `dependabot.yml` | Dependabot sec-updates | Open vuln alerts | Secret scanning | CodeQL (SAST) | Security tools in CI |
|---|---|---|---|---|---|---|---|
| signals-dpg | ✅ | ✅ npm/actions/docker | ✅ on | **38** | ❌ | ❌ not-configured | none |
| aggregator-dpg | ✅ | ✅ npm/actions/docker | ✅ on | **76** | ❌ | ❌ | SonarCloud (advisory) |
| signals-search | ✅ | ✅ npm/actions/docker | ✅ on | **21** | ❌ | ❌ | SonarCloud (advisory) |
| notification-service | ✅ | ✅ npm/actions/docker | ✅ on | **9** | ❌ | ❌ | none |
| ai-diffusion-dpg | ❌ **no CI (any branch)** | ❌ | ❌ off | 0 | ❌ | ❌ | none |
| bluedots-automation | ✅ (helm/tofu validate) | ❌ | ❌ off | 0 | ✅ (push-prot off) | ❌ | none |

**Read this correctly:**
- **Dependency scanning is already live.** Native Dependabot alerts are on for 4 repos, all 5 CI repos carry full Dependabot version-update configs, and **~144 vulnerable-dependency alerts are already open** across the estate. This is real, current security — and a **ready-now Phase-B triage backlog** (see §1.5). A2 does *not* need to re-invent dependency alerting.
- **What genuinely does not exist anywhere:** SAST/code scanning (CodeQL not-configured on all 6, no Semgrep); container-image scanning; IaC/misconfig scanning; and SARIF surfacing into the Security tab.
- **Secret scanning** is on in **only** bluedots-automation (and even there push-protection is off).
- **ai-diffusion-dpg is the one true greenfield:** no CI on any branch (`main` *or* `feat/auth-iam-v2`), no Dependabot, security updates off.
- SonarCloud on two repos is advisory (not required, currently red) and does **not** emit SARIF — not a substitute for SAST.

### 1.3 What each scan type buys us (plain-English)
- **SAST** — reads *our* code for insecure patterns (injection, unsafe deserialization, missing authz, hard-coded secrets). **The biggest gap — nothing scans our code today.**
- **SCA** — matches dependencies/base-images against known-CVE data. *Already partly covered* by Dependabot for source deps; **not** covered for container images.
- **Image scanning** — the built Docker images (OS + app packages in the shipped artifact). Scanned nowhere today.
- **IaC/misconfig** (automation) — the Helm/K8s/OpenTofu that decides the cluster's security posture (RBAC, network policy, secrets, exposure).
- **Secret scanning** — credentials committed to git. Off on 5 of 6 (and automation already has a tracked `.gitleaksignore`, ai-diffusion has a tracked `.env.local`).

### 1.4 Why in CI, and why now
Continuous (re-scan every PR, no drift), shift-left (cheapest to fix pre-deploy), and a hard prerequisite for Phase-B triage.

### 1.5 There is already a backlog to triage
The ~144 open Dependabot alerts (76 aggregator / 38 signals-dpg / 21 signals-search / 9 notification) are **actionable right now** — Phase B has real input before A2 even adds SAST/image scanning. Worth surfacing to whoever owns triage in parallel with the A2 build-out; don't let it wait on the new scanners.

---

## 2. What "done" looks like (acceptance)

Per #300, for each in-scope repo:
1. A **security CI job runs green** (green = "the scan ran", not "zero findings").
2. Findings upload as **SARIF and appear in the repo's Security tab** (Code scanning alerts).
3. That output feeds the Phase-B triage sub-task for that repo.

Not in scope for A2: *fixing* findings (Phase C) or the live pentest (Phase B).

---

## 3. How to implement

### 3.0 Phase 0 — quick wins (do first; minutes, no code)

```bash
# Enable secret scanning + push protection (public repos = free).
# Others: signals-dpg aggregator-dpg signals-search notification-service ai-diffusion-dpg
# (automation already has secret scanning on — it only needs push protection.)
gh api -X PATCH repos/Blue-Dots-Economy/<repo> --input - <<'JSON'
{ "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
} }
JSON

# Enable CodeQL default setup (SAST) — one call per repo; TS + Python, auto-SARIF.
gh api -X PUT repos/Blue-Dots-Economy/<repo>/code-scanning/default-setup \
  -f state=configured -f query_suite=default
```

> **ai-diffusion first:** it has a tracked **`.env.local`** + committed `*.log`. Before secret scanning makes that loud: `git rm --cached .env.local`, gitignore, **rotate anything real**, then enable. Also turn on its Dependabot security updates (off today).

### 3.1 Tool choices (and the reasoning)

| Concern | Tool | Why |
|---|---|---|
| SAST (TS + Python) | **CodeQL default setup** | One API call, zero workflow to maintain, native SARIF → Security tab, covers TS *and* Python. Semgrep/Bandit optional deeper layer later. |
| Dependency SCA | **Native Dependabot (already on)** + **Trivy `fs`** in CI | Dependabot handles source-dep alerts; Trivy `fs` adds lockfile CVEs **as SARIF in the Security tab** + Dockerfile/IaC misconfig. |
| Python dep audit | **`uv-secure`** (uv-native) | Audits `uv.lock` **directly** — no pip-export shim; covers all lockfiles in the uv monorepo. Trivy also reads `uv.lock` natively for the SARIF gate. |
| Image scanning | **Trivy `image`** | Scans the built image's OS + app packages; hooks into existing build jobs; SARIF. |
| IaC/config (automation) | **Trivy `config`** (via `fs` misconfig) | One tool over Helm + K8s + OpenTofu + Dockerfiles. |
| Secrets | **GitHub secret scanning + push protection**, plus **gitleaks** in CI (automation has a `.gitleaksignore`) | Native + PR-diff coverage. |
| Dependency updates | **Dependabot** (already on 5 repos; add to ai-diffusion via `uv` ecosystem + automation) | Keeps deps/base-images/actions patched. |

### 3.2 Standardize: one reusable workflow (avoid drift)
Host the reusable `workflow_call` workflow in **`bluedots-automation`** (public, and already the platform/deploy-tooling repo). Each repo adds a ~15-line caller that invokes it.

> **Do not host it in `adhoc-scripts`** — that repo is **private**, and a **public repo cannot call a reusable workflow stored in a private repo**, which would break every caller. All 6 in-scope repos are public, so the host must be public → bluedots-automation.

Callers reference: `Blue-Dots-Economy/bluedots-automation/.github/workflows/security-scan.yml@<ref>`. See the companion **[security-scanning-a2-callers.md](./security-scanning-a2-callers.md)** for per-repo callers and the in-build image-scan snippet.

### 3.3 Failure policy: report-first, then ratchet
- **Phase A (now):** `block: false` → `exit-code: 0`. Scans run, upload SARIF, **don't fail the build**. Purpose: populate the backlog.
- **After triage:** flip `block: true` (fail on `HIGH,CRITICAL`) so no *new* high-severity issue merges. Reconcile with each repo's required-checks policy (e.g. aggregator keeps advisory checks advisory until green).

### 3.4 Per-repo rollout specifics
- **signals-dpg** — CI + Dependabot already in place. Add: CodeQL default setup, secret scanning, the security caller (Trivy fs), and Trivy image scan in `build-images.yaml` (api, ui).
- **aggregator-dpg** — as above; add Trivy image scan into the `docker` matrix (it already emits SBOM — Trivy can consume it); keep advisory vs the "only `CI` required" policy initially.
- **signals-search** — as above; scan **both** images (app + the **TEI/bge-m3** HF image — least-scanned supply-chain surface).
- **notification-service** — **not greenfield** (has `ci.yaml` + image build + Dependabot). Add CodeQL, secret scanning, the security caller + Trivy image scan. (9 alerts already open.)
- **ai-diffusion-dpg** — **the greenfield one**: stand up `.github/` + a first CI workflow, add the security caller, `uv-secure` (native) + Trivy over the 12 `uv` packages and 11 images; add Dependabot via `package-ecosystem: "uv"` and enable security updates; do the `.env.local` remediation first.
- **bluedots-automation** — IaC toolset: Trivy `config` (Helm + K8s + OpenTofu + Dockerfiles), gitleaks CI gate (a `.gitleaksignore` exists) + turn on **push protection** (secret scanning already on), add `.github/dependabot.yml` for `github-actions`+`docker`, Trivy `image` on the postgres-pgvector image. Findings feed **#304 (B-Cfg)**.

### 3.5 Suggested order & ownership
Phase 0 (secret scanning + CodeQL default setup) across all six on day one — independent of the workflow. Then: signals-dpg (prove the reusable pattern) → signals-search + aggregator (graft onto existing CI) → notification-service (light: add scans to existing CI) → ai-diffusion (heaviest: greenfield + monorepo matrix + secret remediation) → bluedots-automation (IaC track). Run the 144-alert triage in parallel (§1.5).

---

## 4. Estate-specific gotchas
- **Branch model is `feature → develop → main`.** CodeQL default setup scans `main` + PRs to it; the callers add `feature`/`develop` PR triggers so scans run where work happens. (Local checkouts lag — always verify against `feature`.)
- **Host must be public.** adhoc-scripts (private) can't serve reusable workflows to public callers → use bluedots-automation.
- **Public repos + sanitization.** Findings stay out of public issue text; SARIF lives in the private Security tab, candidate findings in private GitHub Security Advisories.
- **`uv` ≠ pip for Dependabot.** ai-diffusion's `uv.lock` isn't understood by the `pip` ecosystem — use `uv-secure`/Trivy for detection and the `uv` ecosystem for updates.
- **Only one true greenfield.** ai-diffusion needs CI stood up first; the other five already have CI to add steps to.
- **SonarCloud is not SAST** and emits no SARIF.
