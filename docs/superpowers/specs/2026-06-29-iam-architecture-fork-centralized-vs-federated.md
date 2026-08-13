# IAM Architecture Fork — Centralized `sub` vs Federated NF/PID

**Date:** 2026-06-29 · **Status:** Decision required (blocks both the Keycloak migration and consent designs)
**Owner:** Tech lead + Product · **Branch:** `feat/keycloak-migration`
**Inputs:** product answers in `2026-06-25-iam-auth-open-questions-for-product.md`; [RBAC gdoc]; [IAM & Data Handling gdoc](https://docs.google.com/document/d/1EqNU2Jcs0vW8NTpdfmqOLiwKPWht7SFxETeLftgnq54/edit); consent issue [#99](https://github.com/Blue-Dots-Economy/signals-dpg/issues/99).

---

## 1. Why this note exists

The Keycloak migration design (`2026-06-25-keycloak-migration-design.md`) and the consent design (`feat/consent-management`) were both written on a **centralized identity premise**:

> one Keycloak **realm per network** → one global **`sub`** per person → one **central consent DB keyed on `sub`** (Keycloak design §2–§4; consent design §2: "one consent DB… keyed on the global `sub`").

Product's answers (2026-06-29) and the **IAM & Data Handling** business-cases doc describe a **different, federated model**. The two are **incompatible as written**. This decision must be made before either spec is finalized — it is the upstream of consent keying, cross-instance trust, and the entire migration shape.

> **Terminology caution.** The IAM gdoc uses **"domain" = DNS subdomain** (`seeker.bluedots.in`) and frames scenarios as "Single Network, Single Domain." In Signals vocabulary: **instance** = deployment, **network** = blue/orange/purple, **domain** = seeker/provider, **item** = profile schema. The gdoc's "Single Network, Single Domain, Different Instances" (S2) is our "single network, seeker+provider on separate instances." This mismatch is already noted in a gdoc comment (Vineela agreed to add the missing multi-network scenarios). Read the gdoc's scenarios through this translation.

---

## 2. The two options

### Option A — Centralized identity (what our specs currently assume)
One Keycloak realm per network. A person authenticates once and carries **one `sub`** recognized at every instance. Authz from verified token claims. Consent + cross-instance trust hang off the single `sub`.

- **Identity store:** central (the realm).
- **Cross-instance:** same realm token validates anywhere (shared JWKS).
- **Consent:** one central DB keyed on `sub`; raw consent + ledger central.
- **Dedup:** network-level — same phone across instances = one `sub`.

### Option B — Federated identity (what product's answers + IAM gdoc describe)
Each **instance** owns its own registry/accounts. A **Network Facilitator (NF)** issues a network-wide **Participant ID (PID)** and runs the cross-instance plumbing. Per [QD 1.1/1.4/9.3] and [IAM]:

- **Identity store:** **per-instance.** One account per *(identity, instance)*; same phone → separate account per instance; **no dedup** (QD 9.3, 1.4).
- **Network-wide identifier:** **PID**, minted by the **NF's own SSO** (QD 1.4), mapped PID→instance in a **central routing index** ([IAM] RT-3).
- **Cross-instance:** central **event bus** + **NF-issued, field-scoped, time-bound connect tokens**; PII flows instance→instance directly, never through NF ([IAM] NRT-1).
- **Consent:** central **consent *registry* of flags per PID** (network/discoverability/connect/category/outbound); **raw consent + PII stay at the instance** ([IAM] summary table).
- **PII classification:** central canonical schema; instances enforce ([IAM] NRT-2).

This is the **Beckn-style** network shape (PID registry, NF connect authority, data sovereignty at the instance).

---

## 3. What product's answers actually said (evidence)

| Question | Answer | Points to |
|---|---|---|
| 1.1 register once or per instance | **"Per instance"** — operators host their own copy | **B** |
| 1.2 discoverable network-wide | **"Yes"** | needs a federation layer (B) or shared realm (A) |
| 1.4 common core attributes | **"No. Registry per instance… NF implements their own SSO"** for the network-wide unique ID | **B** (NF/PID) |
| 9.3 duplicate accounts | one account per identity **per instance**; many across instances; many **profiles** per account | **B** |
| 5.2 PII tiers | network.json per instance/network | A or B (central-authored, per-instance vendored reconciles) |
| 6.1–6.3 cross-instance | "too technical for product" → IAM gdoc designs **NF + event bus + connect tokens** | **B** |

**Net:** product's stated model is **B**. Premises **P1 and P4 are rejected**; **P3 revised** (multi-role on one account); **P2 partly confirmed** (discovery yes, cross-instance action TBD).

---

## 4. Consequences of choosing B (the likely direction)

If we adopt the federated model, the current specs change materially:

1. **Keycloak is no longer "the single network identity."** Either:
   - **B1 — Keycloak per instance** (each instance's realm = its local accounts) **+ NF/PID as a separate central service** for the network-wide identifier, routing, and consent-flag registry; or
   - **B2 — Keycloak *is* the NF** (one realm, but treated as the central registry that mints PIDs and issues cross-instance tokens) — closer to A operationally but re-labeled.
   The honest read of QD 1.1/1.4 ("operators host their own copy", "NF implements their **own** SSO") leans **B1**: instance-local IdP + a thin central NF.
2. **Consent design must re-key.** Today it keys on global `sub` with one central DB. Under B it becomes **central flags per PID + per-instance raw consent records + ledger**. The "one consent DB keyed on sub" statement is the single biggest rewrite. (Consent records would key on `(instance, local_id)` for raw text and on **PID** for the network-visible flag.)
3. **Cross-instance trust** is designed (closes the currently-unauthenticated gap) via **NF-issued tokens / shared JWKS / domain keypairs** — not "same realm token everywhere."
4. **The migration** (Keycloak design §8) stays largely valid *within an instance* (better-auth → instance Keycloak), but the **network-level dedup step (Phase B) is removed** (product wants no dedup) and a **PID-issuance + NF-integration track is added**.
5. **`performed_by`/`on_behalf_of` attribution** (design §7) stands and **extends to account-level ops + per-action voice-bot tagging** (QD 10.2, 3.4).

## 5. Consequences of choosing A

- Simpler for us (one realm, one `sub`, consent as-designed), and 1.2 (network discovery) is trivial.
- **But it contradicts product's explicit "per instance / operators host their own copy / no dedup."** Operators wanting to **own their participants' data locally** (a stated requirement, and a DPDP data-sovereignty posture) is the core thing A gives up. Choosing A means going back to product to overturn 1.1/1.4/9.3.

---

## 6. Recommendation

**Lean B1 (instance-local Keycloak + thin central NF/PID + consent-flag registry)** — it matches product's stated model and the data-sovereignty intent, and the IAM gdoc already sketches the central services. But confirm three things with product before committing, because B is materially more build:

1. **Is the "network facilitator SSO" (QD 1.4) a product/EkStep-owned component we integrate with, or do we build it?** (Determines whether we build the PID registry or consume one. Likely Beckn-registry-shaped.)
2. **Is cross-instance *action* (not just discovery) required near-term?** (6.1) — if discovery-only first, we can defer the NF connect-token machinery and ship per-instance + a routing/discovery index.
3. **Near-term topology:** the IAM gdoc scopes **S1 (single network, single instance)** as immediate and S2/S4 (federated) as later. If S1 is the only live topology for now, we can **build instance-local Keycloak now and stub the NF/PID seam** — getting consent + auth shipped without the full federation, provided we **key consent on PID-ready identifiers from day one** so the later cut to B is not another rekey.

**Decision needed:** A vs B (and if B: B1 vs B2; build-vs-integrate the NF). Until then, the Keycloak design's §2 premises and the consent design's `sub`-keying are marked **provisional/blocked**.

---

## 7. Knock-on edits queued (once the fork is decided)

- **Keycloak design:** rewrite §2 premises (P1/P4), §3 realm topology (per-instance vs network realm), §8 Phase B (drop dedup, add PID/NF track).
- **Consent design:** re-key from global `sub` to PID-flag-central + instance-raw; add the **initiate-time consent gate** (consent issue #99 statement 4; today it's accept-only); make discovery/action gating **bidirectional** (QD 7.3).
- **Open-questions register:** F1 resolved closes the cascade (F2, F5, F6, 6.x).
