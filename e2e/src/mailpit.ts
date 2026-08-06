import type { APIRequestContext } from '@playwright/test';

/**
 * Mailpit inbox client — the suite's inspectable notification sink.
 *
 * Under `AUTH_PROVIDER=keycloak` the login OTP is minted by Keycloak's OTP
 * authenticator SPI, NOT by signals, so `CREATE_TEST_OTP` no longer fixes it to
 * "000000" (that flag only reaches the signals process; the Keycloak container
 * never sees it and still generates a random code). The email channel therefore
 * needs a real inbox to read the code back out of — that is what Mailpit is for,
 * and it doubles as the oracle for every other message signals renders and
 * dispatches (guardian OTP email, retire-cancel notice, support email).
 *
 * Local-only by nature: a shared dev target has no inspectable inbox, so tests
 * that need this are capability-gated (`mailpit`) and skip-and-report there.
 */

export interface MailpitMessageSummary {
  ID: string;
  Subject: string;
  To: Array<{ Address: string; Name?: string }>;
  Created: string;
}

export interface MailpitMessage {
  ID: string;
  Subject: string;
  Text?: string;
  HTML?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Mailpit {
  constructor(
    private readonly request: APIRequestContext,
    private readonly baseUrl: string,
  ) {}

  /** Delete every message in the inbox. Call before a flow to avoid reading a stale code. */
  async clear(): Promise<void> {
    await this.request.delete(`${this.baseUrl}/api/v1/messages`).catch(() => undefined);
  }

  /** Messages addressed to `recipient`, newest first. */
  async search(recipient: string): Promise<MailpitMessageSummary[]> {
    const res = await this.request.get(
      `${this.baseUrl}/api/v1/search?query=${encodeURIComponent(`to:${recipient}`)}`,
    );
    if (!res.ok()) return [];
    const body = (await res.json()) as { messages?: MailpitMessageSummary[] };
    return body.messages ?? [];
  }

  async message(id: string): Promise<MailpitMessage | undefined> {
    const res = await this.request.get(`${this.baseUrl}/api/v1/message/${id}`);
    if (!res.ok()) return undefined;
    return (await res.json()) as MailpitMessage;
  }

  /**
   * Poll for the newest message to `recipient` and return its full body.
   * Returns undefined if nothing arrives inside `timeoutMs`.
   */
  async waitForMessage(
    recipient: string,
    opts: { timeoutMs?: number; subjectMatch?: RegExp } = {},
  ): Promise<MailpitMessage | undefined> {
    const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
    while (Date.now() < deadline) {
      const found = await this.search(recipient);
      const candidate = opts.subjectMatch
        ? found.find((m) => opts.subjectMatch!.test(m.Subject))
        : found[0];
      if (candidate) {
        const full = await this.message(candidate.ID);
        if (full) return full;
      }
      await sleep(600);
    }
    return undefined;
  }

  /**
   * Wait for a message to `recipient` and pull the numeric OTP out of it.
   *
   * Deliberately permissive about the template: it takes the first standalone
   * 4-8 digit run in subject/text/html. Anchoring on exact copy would make the
   * suite fail on a wording change that broke nothing.
   */
  async waitForOtp(recipient: string, opts: { timeoutMs?: number } = {}): Promise<string | undefined> {
    const msg = await this.waitForMessage(recipient, opts);
    if (!msg) return undefined;
    return extractOtp(`${msg.Subject ?? ''} ${msg.Text ?? ''} ${stripTags(msg.HTML ?? '')}`);
  }
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

/**
 * Pull a delivered OTP out of arbitrary message text.
 *
 * Deliberately tries a labelled match first. "First standalone 4-8 digit run"
 * on its own is wrong in practice: real messages carry years ("2026"), ports,
 * and log timestamps, and a log line like
 *   `2026-08-06 08:03:55,661 … SMS to +9199…: Your verification code is: 921732`
 * yields "2026". Anchoring on the label and only then falling back keeps the
 * matcher tolerant of copy changes without letting a date win.
 */
export function extractOtp(haystack: string): string | undefined {
  const labelled =
    /(?:code|otp|pin)\D{0,20}?(?<!\d)(\d{4,8})(?!\d)/i.exec(haystack)?.[1];
  if (labelled) return labelled;
  // Fallback: the LAST standalone run, which in a code-bearing message is the
  // code far more often than the first one is.
  const all = [...haystack.matchAll(/(?<!\d)(\d{4,8})(?!\d)/g)].map((m) => m[1]);
  return all.length ? all[all.length - 1] : undefined;
}
