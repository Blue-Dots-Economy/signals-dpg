# Guardian OTP notification templates (U18, #294)

Email and SMS are handled differently — matching how the rest of signals already
does OTP/notification:

- **Email — body rendered IN-REPO.** `apps/api/src/services/guardian_otp_email.ts`
  (`renderGuardianOtpEmail`) builds the subject + HTML from the scenario + the
  #294 copy, and it ships via the generic **`basic_email`** template (same
  convention as the login OTP `packages/auth/src/templates/otp_email.ts` and
  action emails). **No notification-service email template to author** — the copy
  lives here.
- **SMS — DLT-approved body owned by the notification service.** SMS text must be
  DLT-registered, so we can't compose it in-app; the API selects a per-scenario
  **`template_id`** (`guardian_otp_<scenario>_sms`, generic fallback
  `guardian_otp_sms`) and passes variables. The notification service maps each id
  to its DLT-approved template.

Common:
- The OTP is **valid for 10 minutes** (`GUARDIAN_OTP_TTL_SEC = 600`); both channels state this + "Do not share it with anyone."
- Variables are **best-effort**: `parentName` / `domain` / `providerOrgName` may be absent (guardian name not decryptable yet, provider title unresolved). The email template falls back gracefully; SMS templates should too.
- The "Team {name}" sign-off uses `INSTANCE_NAME` (via `supportConfig.teamName`), and email `from`/`replyTo` use `NOTIFICATION_FROM_EMAIL` — deploy-configurable, no hardcoded brand.

## SMS template ids the notification service must register (DLT)

| Scenario | Trigger | SMS template id | Variables (besides `otp`) |
|----------|---------|-----------------|---------------------------|
| `account` | Ward creates an account (pre-auth signup) + guardian designation | `guardian_otp_account_sms` | `parentName`, `domain` |
| `profile` | Ward creates a profile | `guardian_otp_profile_sms` | `parentName`, `domain` |
| `connect` | Ward initiates a connect | `guardian_otp_connect_sms` | `parentName`, `providerOrgName` |
| `connect_accept` | Ward accepts a connect request | `guardian_otp_connect_accept_sms` | `parentName`, `providerOrgName` |
| `apply` | Ward applies | `guardian_otp_apply_sms` | `parentName`, `providerOrgName` |
| `apply_accept` | Ward accepts a pre-select / pre-shortlist | `guardian_otp_apply_accept_sms` | `parentName`, `providerOrgName` |

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
