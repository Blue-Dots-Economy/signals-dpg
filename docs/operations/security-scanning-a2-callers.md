# Callers for the reusable `security-scan.yml`

The reusable workflow lives at `Blue-Dots-Economy/bluedots-automation/.github/workflows/security-scan.yml`.
Each repo adds a thin caller at `.github/workflows/security.yml`. Pin `@main` to a tag/SHA once released.

> **Host must be public.** All 6 in-scope repos are public, and a public repo **cannot** call a
> reusable workflow stored in a **private** repo — so the private `adhoc-scripts` repo is not a
> viable host. `bluedots-automation` (public, already the platform/deploy-tooling repo) is the home.

Two rollout steps per repo regardless of caller:
1. Enable CodeQL default setup (SAST) — one-time, out of band:
   ```bash
   gh api -X PUT repos/Blue-Dots-Economy/<repo>/code-scanning/default-setup \
     -f state=configured -f query_suite=default
   ```
2. Add the caller below.

---

## TS app repo — signals-dpg / aggregator-dpg / signals-search / notification-service

```yaml
# .github/workflows/security.yml
name: security
on:
  pull_request: { branches: [feature, develop, main] }
  push:         { branches: [develop, main] }
  schedule:     [{ cron: "0 3 * * 1" }]   # weekly full sweep
concurrency:
  group: security-${{ github.ref }}
  cancel-in-progress: true
jobs:
  scan:
    uses: Blue-Dots-Economy/bluedots-automation/.github/workflows/security-scan.yml@main
    with:
      language: ts
      node-version: "24"
      block: false            # Phase A: report-only. Flip true after B triage.
    secrets: inherit
```

> notification-service already has CI (`ci.yaml` + image build) and a `dependabot.yml` — this
> caller just adds the security scan. (Only **ai-diffusion-dpg** is greenfield; see below.)

## Python monorepo — ai-diffusion-dpg

```yaml
name: security
on:
  pull_request: { branches: [main] }
  push:         { branches: [main] }
  schedule:     [{ cron: "0 3 * * 1" }]
concurrency: { group: security-${{ github.ref }}, cancel-in-progress: true }
jobs:
  scan:
    uses: Blue-Dots-Economy/bluedots-automation/.github/workflows/security-scan.yml@main
    with:
      language: python
      block: false
    secrets: inherit
```

> **ai-diffusion is the one greenfield repo** — no CI on any branch, no Dependabot. This caller
> is its first workflow; add a minimal build/test workflow alongside it and a `dependabot.yml`
> using `package-ecosystem: "uv"` (the `pip` ecosystem doesn't read `uv.lock`). The audit uses
> **`uv-secure`**, which reads `uv.lock` directly and covers **all 12** lockfiles in one call
> (Trivy `fs` also reads `uv.lock` natively for the SARIF gate). Do the `.env.local` / `*.log`
> remediation + enable Dependabot security updates *before* turning on secret scanning.

## IaC repo — bluedots-automation

```yaml
name: security
on:
  pull_request: { branches: [feature, develop, main] }
  push:         { branches: [develop, main] }
  schedule:     [{ cron: "0 3 * * 1" }]
concurrency: { group: security-${{ github.ref }}, cancel-in-progress: true }
jobs:
  scan:
    uses: Blue-Dots-Economy/bluedots-automation/.github/workflows/security-scan.yml@main
    with:
      language: iac          # skips pnpm/pip audit; Trivy fs misconfig does the work
      run-gitleaks: true     # a .gitleaksignore already exists here
      block: false
    secrets: inherit
```

> Trivy fs `misconfig` covers Helm charts + K8s manifests + OpenTofu + Dockerfiles.
> Also turn on secret-scanning **push protection** (native scanning is already on),
> and add a `.github/dependabot.yml` for `github-actions` + `docker`.

---

## Image scanning — two options

**Option A (recommended): scan the freshly-built local image in the existing build job.**
No registry pull, scans the exact artifact. Paste after the `build` step in each
repo's image-build workflow (`build-images.yaml`, the `docker` matrix, `publish-image`,
`build-postgres-image.yml`, etc.):

```yaml
      - name: Trivy image scan
        uses: aquasecurity/trivy-action@0.28.0
        with:
          scan-type: image
          image-ref: ${{ steps.build.outputs.imageid }}   # local digest from build-push-action
          format: sarif
          output: trivy-image.sarif
          exit-code: "0"          # report-only in Phase A
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with: { sarif_file: trivy-image.sarif, category: trivy-image }
```
(Needs `permissions: security-events: write` on that job.)

**Option B: scan already-published images via the reusable workflow.**
Pass their refs as a JSON array — useful for scheduled re-scans of what's live:

```yaml
  scan:
    uses: Blue-Dots-Economy/bluedots-automation/.github/workflows/security-scan.yml@main
    with:
      language: ts
      image-refs: '["ghcr.io/blue-dots-economy/signals-dpg/api:develop","ghcr.io/blue-dots-economy/signals-dpg/ui:develop"]'
    secrets: inherit
```

Per-repo image sets: signals-dpg = api+ui · aggregator = api+web+worker(+keycloak) ·
signals-search = app+**tei-bge-m3** · notification-service = 1 · ai-diffusion = 11 ·
automation = postgres-pgvector.

---

## Validate before handoff
```bash
# lint the reusable workflow + a caller locally
npx -y @action-validator/cli security-scan.yml
# or push to a throwaway branch and confirm: green run + alerts appear under
# the repo's Security ▸ Code scanning tab (categories: trivy-fs, trivy-image*, gitleaks).
```
