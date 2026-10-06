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
  carrying only the code in `message`. NS seeds it from its vendor settings, so
  each cluster that sends guardian OTP by SMS sets it there. The scenario
  context is conveyed in the email; the SMS is just the code.

Common:

- The OTP is **valid for 10 minutes** (`GUARDIAN_OTP_TTL_SEC = 600`). The email
  states this and "Do not share it with anyone"; the SMS says whatever the DLT
  OTP template says.
- Variables are **always filled**: when the guardian name or provider title
  cannot be resolved, Signals sends `parentName` `there`, `domain` the
  `teamName`, and `org` `the organisation`.
- The "Team {name}" sign-off is `teamName`, from `INSTANCE_NAME`. The From
  address is NS deployment config.
- An NS refusal or transport failure is logged (event type, status, NS error
  code; never the OTP or the contact) and the route answers
  `503 NO_OTP_PROVIDER`.

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
