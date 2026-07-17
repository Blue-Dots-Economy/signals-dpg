# Guardian OTP notification templates (U18, #294)

The API selects a **template id** per scenario and passes **variables**; the
notification service owns the actual subject/body keyed by that id. This is the
contract between `apps/api/src/services/guardian_otp.ts`
(`SCENARIO_TEMPLATE_ID`) and the notification-service template config.

- Every template also receives `otp` and must state the code is **valid for 10
  minutes** (the API TTL is `GUARDIAN_OTP_TTL_SEC = 600`) and "Do not share it
  with anyone."
- Variables are **best-effort**: `parentName` / `domain` / `providerOrgName` may
  be absent (e.g. a guardian name not yet decryptable, or a provider title that
  didn't resolve). Templates must render gracefully without them.
- Channels: `email` and `sms`. Ids follow `guardian_otp_<scenario>_<channel>`.
- If a scenario is not supplied, the API falls back to the generic
  `guardian_otp_sms` / `guardian_otp_email`.

## Template ids + variables

| Scenario | Trigger | Template ids | Variables (besides `otp`) |
|----------|---------|--------------|---------------------------|
| `account` | Ward creates an account (pre-auth signup) + guardian designation | `guardian_otp_account_{email,sms}` | `parentName`, `domain` |
| `profile` | Ward creates a profile | `guardian_otp_profile_{email,sms}` | `parentName`, `domain` |
| `connect` | Ward initiates a connect | `guardian_otp_connect_{email,sms}` | `parentName`, `providerOrgName` |
| `connect_accept` | Ward accepts a connect request | `guardian_otp_connect_accept_{email,sms}` | `parentName`, `providerOrgName` |
| `apply` | Ward applies | `guardian_otp_apply_{email,sms}` | `parentName`, `providerOrgName` |
| `apply_accept` | Ward accepts a pre-select / pre-shortlist | `guardian_otp_apply_accept_{email,sms}` | `parentName`, `providerOrgName` |

## Copy (from #294)

**account** — Hi `{parentName}`, Your ward has requested registration on
`{domain}`. This website shows services and opportunities relevant to your ward.
Use the given OTP to agree to create their account. Team EkStep. `{otp}`. This
OTP is valid for 10 minutes. Do not share it with anyone.

**profile** — Hi `{parentName}`, Your ward has requested to create a profile on
`{domain}`. This profile will help your ward in discovering, and matching to
relevant services and opportunities. Use the given OTP to agree to create their
profile. Team EkStep. `{otp}`. This OTP is valid for 10 minutes. Do not share it
with anyone.

**connect / connect_accept / apply / apply_accept** — Hi `{parentName}`, Your
ward has requested to connect to `{providerOrgName}`. This will share your ward's
profile details, along with name, phone, and email with the organisation. Use
the given OTP to allow `{providerOrgName}` to access your ward's details. Team
EkStep. `{otp}`. This OTP is valid for 10 minutes. Do not share it with anyone.

> Note (#294 scope): "what they offer" is intentionally **not** sent as a
> variable — there is no canonical schema field for it across networks. If a
> template needs it later, add the resolution in `guardian_action_gate.ts` and a
> new variable here.
