import {
  NotifyTransportError,
  type NotifyEvent,
  type NotifyResult,
} from './notify_event';
import type { TokenSource } from './token_source';

export interface NotificationClientConfig {
  /** The notification service's base URL. Any path on it is replaced by `/v1/notify`. */
  baseUrl: string;
  /** Supplies the `Authorization: Bearer` token. */
  tokens: TokenSource;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Defaults to 10 s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Client for the notification service's `POST /v1/notify`.
 *
 * `send` resolves with the service's verdict — accepted (`ok: true`) or refused
 * (`ok: false`, with the service's `error` code) — and rejects with
 * `NotifyTransportError` only when no verdict was reached (network failure,
 * timeout, no token). Whether a refusal is fatal is the caller's decision.
 */
export class NotificationClient {
  private readonly url: string;
  private readonly tokens: TokenSource;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(cfg: NotificationClientConfig) {
    this.url = new URL('/v1/notify', cfg.baseUrl).toString();
    this.tokens = cfg.tokens;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async send(event: NotifyEvent): Promise<NotifyResult> {
    // The service reads an absent `domain` as "no recipient domain"; it does
    // not accept `null`, so a domain-less event leaves the field out.
    const { domain, ...rest } = event;
    const body = JSON.stringify({
      ...rest,
      ...(domain != null ? { domain } : {}),
      priority: event.priority ?? 'normal',
    });

    let res = await this.post(body, event.correlation_id);
    if (res.status === 401) {
      // The cached token can die before its stated expiry (secret rotated,
      // session revoked, Keycloak restarted). Refresh once and retry once; a
      // second 401 is a real refusal and is returned as one.
      await res.body?.cancel().catch(() => undefined);
      this.tokens.invalidate();
      res = await this.post(body, event.correlation_id);
    }

    const parsed = await readJson(res);

    if (res.ok) {
      return {
        ok: true,
        status: res.status as 200 | 202,
        body: parsed as { notification_event_id: string; correlation_id: string },
      };
    }

    const error =
      typeof parsed?.error === 'string' && parsed.error !== ''
        ? parsed.error
        : `http_${res.status}`;
    const kind =
      parsed?.kind === 'caller' || parsed?.kind === 'configuration'
        ? parsed.kind
        : undefined;
    return { ok: false, status: res.status, error, ...(kind ? { kind } : {}) };
  }

  private async post(body: string, correlationId?: string): Promise<Response> {
    let token: string;
    try {
      token = await this.tokens.token();
    } catch (err) {
      throw new NotifyTransportError(
        `notification service: could not obtain an access token (${describe(err)})`,
        { cause: err }
      );
    }

    try {
      return await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new NotifyTransportError(
        `notification service: request failed (${describe(err)})`,
        { cause: err }
      );
    }
  }
}

/**
 * Names the failure without echoing anything that could carry a secret: the
 * error's class (`TimeoutError`, `TypeError`, `TokenSourceError`, …) and, for
 * a token-endpoint refusal, its status.
 */
function describe(err: unknown): string {
  if (err instanceof Error) {
    const status = (err as { status?: unknown }).status;
    return typeof status === 'number' ? `${err.name}, status ${status}` : err.name;
  }
  return 'unknown error';
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await res.json();
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
