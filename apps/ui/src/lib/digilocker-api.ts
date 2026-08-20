import { extractImportCandidates } from './import-mapping';

const AGENT_URL = import.meta.env.VITE_AGENT_URL?.trim();
const AGENT_TOKEN = import.meta.env.VITE_AGENT_TOKEN?.trim();

type JsonRecord = Record<string, unknown>;

interface DigiLockerResponse {
  data: {
    credentialSubject: JsonRecord;
  };
}

interface DigiLockerRequestResponse {
  url: string;
}

class DigiLockerApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...(options.headers as Record<string, string> | undefined),
      },
      credentials: 'include',
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(
        (errorData as { message?: string }).message ?? `HTTP error ${response.status}`
      );
    }

    return response.json() as Promise<T>;
  }

  async initiateRequest(): Promise<DigiLockerRequestResponse> {
    return this.request('/api/v1/discover/digilocker-request', { method: 'GET' });
  }

  async completeAuth(code: string, doctype = 'aadhaar'): Promise<DigiLockerResponse> {
    return this.request('/api/v1/discover/digilocker-auth', {
      method: 'POST',
      body: JSON.stringify({ code, doctype }),
    });
  }

  transformCredentialSubject(subject: JsonRecord): {
    data: Record<string, unknown>;
    candidates: Record<string, unknown>;
    rawPayload: JsonRecord;
  } {
    return {
      data: {},
      candidates: extractImportCandidates(subject),
      rawPayload: subject,
    };
  }
}

export const digiLockerApi = AGENT_URL && AGENT_TOKEN ? new DigiLockerApi(AGENT_URL, AGENT_TOKEN) : null;

export function isDigiLockerConfigured(): boolean {
  return Boolean(AGENT_URL && AGENT_TOKEN);
}

/**
 * A usable, comparable origin: never empty and never the opaque `"null"` that
 * `URL.origin` yields for schemes such as `data:`/`mailto:` and that a
 * sandboxed frame reports as its `MessageEvent.origin`. Allowlisting `"null"`
 * would hand the trust back to exactly the senders the check exists to block.
 */
function isUsableOrigin(value: string | null | undefined): value is string {
  return Boolean(value) && value !== 'null';
}

/** Origin of an absolute URL, or null when it can't be parsed as one. */
function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const { origin } = new URL(value);
    return isUsableOrigin(origin) ? origin : null;
  } catch {
    return null;
  }
}

/**
 * The only origins a DigiLocker callback `postMessage` may be trusted from:
 *
 * - this app's own origin — where the callback bridge page ships
 *   (`public/digilocker-bridge.html`) and where the popup lands on the
 *   `wallet-redirect?code=` URL the polling path reads; and
 * - the origin of `VITE_AGENT_URL`, the agent service that mints the launch
 *   URL, for deployments that host the bridge alongside the agent.
 *
 * A relative `VITE_AGENT_URL` contributes nothing beyond the app origin, which
 * is already covered. Any other window posting to us is ignored.
 */
export function getDigiLockerCallbackOrigins(): string[] {
  const origins = new Set<string>();
  const appOrigin = typeof window === 'undefined' ? null : window.location?.origin;
  if (isUsableOrigin(appOrigin)) {
    origins.add(appOrigin);
  }
  const agentOrigin = originOf(AGENT_URL);
  if (agentOrigin) origins.add(agentOrigin);
  return [...origins];
}
