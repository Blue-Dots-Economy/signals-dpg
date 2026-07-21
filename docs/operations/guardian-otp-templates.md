# Guardian OTP notification templates (U18, #294)

Email and SMS are handled differently — matching how the rest of signals already
does OTP/notification:

- **Email — body rendered IN-REPO.** `apps/api/src/services/guardian_otp_email.ts`
  (`renderGuardianOtpEmail`) builds the subject + HTML from the scenario + the
  #294 copy, and it ships via the generic **`basic_email`** template (same
  convention as the login OTP `packages/auth/src/templates/otp_email.ts` and
  action emails). **No notification-service email template to author** — the copy
  lives here.
- **SMS — same as the login OTP.** SMS bodies are DLT-registered and can't be
  composed in-app, and the instance has a single generic OTP template. So the
  guardian SMS reuses exactly what the login OTP uses: `template_id =
  SMS_TEMPLATE_ID` (default `login_otp`) with `variables: { message: otp }`. It
  carries **only the code** — no per-scenario SMS templates, no parent-facing SMS
  copy. The scenario context is conveyed in the **email**; the SMS is just the
  code (identical to how a user's own login OTP arrives).

Common:
- The OTP is **valid for 10 minutes** (`GUARDIAN_OTP_TTL_SEC = 600`). The email states this + "Do not share it with anyone"; the SMS says whatever the existing DLT OTP template says.
- Email variables are **best-effort**: `parentName` / `domain` / `providerOrgName` may be absent (guardian name not decryptable yet, provider title unresolved) — the template falls back gracefully.
- The email "Team {name}" sign-off uses `INSTANCE_NAME` (via `supportConfig.teamName`), and `from`/`replyTo` use `NOTIFICATION_FROM_EMAIL` — deploy-configurable, no hardcoded brand.

## SMS

No new DLT templates needed — the guardian SMS uses the instance's existing OTP
template (`SMS_TEMPLATE_ID`, default `login_otp`), code only, exactly like the
login OTP. All the #294 per-scenario copy lives in the **email**.

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
