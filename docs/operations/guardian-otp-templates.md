# Guardian OTP notification templates (U18, #294)

Signals generates, stores (sha256 in Redis) and verifies every guardian OTP.
notification-service (NS) only carries it. Each send is one `/v1/notify` event:

- `guardian.otp.account`, `guardian.otp.profile`, `guardian.otp.action` and
  `guardian.otp.action_bulk` for the #294 scenarios, and `guardian.otp.generic`
  for a code with no scenario.
- No `domain` (the null-domain policy applies), priority `urgent`, and no
  idempotency key: every challenge is its own send.
- `to` holds the guardian contact point Signals has: an email address, or an
  E.164 phone (guardian phones are normalised to E.164 at capture).
- Variables: `message` (the OTP), `parentName`, `domain`, `org` and `teamName`;
  the bulk scenario adds `noun` and `orgList` (organisation names joined as
  `A, B and C`). `guardian.otp.generic` sends `message` only.

The policy for each event is `first_available`: the email template
`guardian.<kind>` (or `otp.generic`) when the contact is an email, the SMS
`login_otp` template when it is a phone.

- **Email** — the per-scenario copy below is an NS template, edited through the
  NS admin API (see `docs/operations/email-copy-overrides.md`).
- **SMS** — the same DLT-registered `login_otp` template the login OTP uses,
  carrying only the code in `message`. NS seeds it from its vendor settings.
  The scenario context is conveyed in the email; the SMS is just the code.

Every guardian policy names both templates, so NS publishes it only once
`login_otp` is active. Every cluster that sends guardian OTP, by email or SMS,
configures `login_otp` in NS (`SMS_LOGIN_OTP_TEMPLATE_ID` for msg91;
`PINNACLE_LOGIN_OTP_TEMPLATE_ID` with `SMS_LOGIN_OTP_BODY` for pinnacle)
**before the first NS boot that loads `NS_SEED_FILE`**. On a cluster where it
was configured later, publish the guardian policy drafts through
`/v1/admin/policies` (`POST /v1/admin/policies/:id/publish`).

Common:

- The OTP is **valid for 10 minutes** (`GUARDIAN_OTP_TTL_SEC = 600`). The email
  states this and "Do not share it with anyone"; the SMS says whatever the DLT
  OTP template says.
- Variables are **always filled**: when the guardian name or provider title
  cannot be resolved, Signals sends `parentName` `there`, `domain` the
  `teamName`, and `org` `the organisation`.
- The "Team {name}" sign-off comes from the network's copy. In blue_dot and
  purple_dot (and their brands) the `guardian.account`, `guardian.profile` and
  `guardian.action` templates carry fixed text (`Team EkStep`, `Team ALIMCO`);
  `guardian.action_bulk`, and every guardian template in orange_dot and
  yellow_dot, use the `teamName` variable, from `INSTANCE_NAME`.
  `otp.generic` has no sign-off. The From address is NS deployment config.
- An NS refusal or transport failure is logged (event type, status, NS error
  code; never the OTP or the contact). The consent routes answer `503`
  (`NO_OTP_PROVIDER` on `/u18/signup/guardian`, `OTP_PROVIDER_UNAVAILABLE` on
  the other guardian consent routes). Action routes, single or bulk, report it
  per item as `OTP_PROVIDER_UNAVAILABLE` (`guardianGateFailure` in
  `apps/api/src/services/guardian_action_gate.ts`).

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
