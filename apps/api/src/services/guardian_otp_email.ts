import type { GuardianOtpScenario, GuardianOtpVariables } from '@/services/guardian_otp';

/**
 * In-repo guardian-OTP email bodies (#294). Email follows the same convention as
 * the login OTP (`packages/auth/src/templates/otp_email.ts`) and action emails:
 * render the HTML HERE and ship it via the generic `basic_email` template — the
 * copy lives in signals, not the notification service. (SMS is the exception:
 * its body is a DLT-approved template owned by the notification service, so SMS
 * still goes out via a per-scenario `template_id`.)
 *
 * Variables are best-effort — `parentName` / `domain` / `providerOrgName` may be
 * absent, so every branch has a graceful fallback.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Email copy differentiates account / profile / action. Every action (connect,
// apply, and their accepts) shares the same "share your ward's details" body per
// #294 — so the specific action type doesn't change the email, only the SMS
// template id + the providerOrgName variable.
function bodyLine(scenario: GuardianOtpScenario, vars: GuardianOtpVariables): string {
  const domain = vars.domain ? esc(vars.domain) : null;
  const org = vars.providerOrgName ? esc(vars.providerOrgName) : 'the organisation';
  switch (scenario.kind) {
    case 'account':
      return `Your ward has requested registration${domain ? ` on <b>${domain}</b>` : ''}. This website shows services and opportunities relevant to your ward. Use the given OTP to agree to create their account.`;
    case 'profile':
      return `Your ward has requested to create a profile${domain ? ` on <b>${domain}</b>` : ''}. This profile will help your ward in discovering, and matching to relevant services and opportunities. Use the given OTP to agree to create their profile.`;
    case 'action':
      return `Your ward has requested to connect to <b>${org}</b>. This will share your ward's profile details, along with name, phone, and email with the organisation. Use the given OTP to allow <b>${org}</b> to access your ward's details.`;
    case 'action_bulk': {
      // Numbered list of every provider org in the batch; the trailing sentence
      // matches #294's single-action wording ("share ... name, phone, email").
      const noun = scenario.jobs ? 'jobs' : 'opportunities';
      const list = scenario.providerOrgNames.length
        ? `<ol>${scenario.providerOrgNames.map((n) => `<li>${esc(n)}</li>`).join('')}</ol>`
        : '<p>the selected organisations</p>';
      const tail =
        "This application will share your ward's profile details, along with name, phone, and email with the organisations. Use the given OTP to allow provider organisations to access your ward's details.";
      return `Your ward has requested to apply to ${noun} provided by:${list}<p>${tail}</p>`;
    }
  }
}

function subjectFor(scenario: GuardianOtpScenario): string {
  switch (scenario.kind) {
    case 'account':
      return "Approve your ward's account — OTP";
    case 'profile':
      return "Approve your ward's profile — OTP";
    case 'action':
      return "Approve your ward's request — OTP";
    case 'action_bulk':
      return "Approve your ward's requests — OTP";
  }
}

export function renderGuardianOtpEmail(args: {
  scenario: GuardianOtpScenario;
  otp: string;
  variables: GuardianOtpVariables;
  teamName: string;
}): { subject: string; html: string } {
  const { scenario, otp, variables, teamName } = args;
  const parentName = variables.parentName ? esc(variables.parentName) : 'there';
  const html = `
  <div style="font-family: Arial, sans-serif; font-size: 15px; color: #333;">
    <p>Hi ${parentName},</p>

    <p>${bodyLine(scenario, variables)}</p>

    <div style="
      font-size: 20px;
      font-weight: bold;
      background-color: #f4f4f4;
      padding: 10px 15px;
      border-radius: 6px;
      display: inline-block;
      font-family: 'Courier New', monospace;
      margin: 10px 0;
    ">
      ${esc(otp)}
    </div>

    <p style="font-size: 13px; color: #555;">This OTP is valid for 10 minutes. Do not share it with anyone.</p>

    <p>Team ${esc(teamName)}</p>
  </div>
`;
  return { subject: subjectFor(scenario), html };
}
