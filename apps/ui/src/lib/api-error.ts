import axios from 'axios';
import type { TFunction } from 'i18next';
import { getCsrfToken } from '@/lib/bff-session';

/** What a failed request told us, read off an axios error (or a BulkSingleError). */
export interface ApiErrorInfo {
  /** HTTP status; undefined when the request never got a response. */
  status?: number;
  /** The API's machine-readable `error` code. */
  code?: string;
  /** The API's `message`, untouched. Show only through `apiErrorMessage`. */
  message?: string;
  /** Per-field messages (`INVALID_ITEM_STATE`'s `fields`), keyed by dotted path. */
  fields?: Record<string, string>;
  /** True when the server was never reached (offline, DNS, CORS, timeout). */
  network: boolean;
  /** The API's `x-request-id`, quoted to support for a server fault. */
  requestId?: string;
}

export function readApiError(err: unknown): ApiErrorInfo {
  const response = (
    err as { response?: { status?: number; data?: unknown; headers?: Record<string, unknown> } } | null
  )?.response;
  if (!response) {
    // A cancelled request (closed dialog, aborted query) is not a connection problem.
    const cancelled = axios.isCancel(err) || (axios.isAxiosError(err) && err.code === 'ERR_CANCELED');
    const network =
      !cancelled && (axios.isAxiosError(err) || (err instanceof TypeError && /fetch|network/i.test(err.message)));
    return { network };
  }
  const data = (response.data ?? {}) as Record<string, unknown>;
  const rawFields = data.fields;
  let fields: Record<string, string> | undefined;
  if (rawFields && typeof rawFields === 'object' && !Array.isArray(rawFields)) {
    fields = Object.fromEntries(
      Object.entries(rawFields as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    if (Object.keys(fields).length === 0) fields = undefined;
  }
  // Fastify's request-schema 400: "body/guardianEmail Invalid email, body/name …".
  if (!fields && typeof data.message === 'string') {
    for (const m of data.message.matchAll(/(?:^|, )body\/([\w./]+) ([^,]+)/g)) {
      fields ??= {};
      fields[m[1]!.replaceAll('/', '.')] = m[2]!.trim();
    }
  }
  return {
    status: response.status,
    code: typeof data.error === 'string' ? data.error : undefined,
    message: typeof data.message === 'string' ? data.message : undefined,
    fields,
    network: false,
    ...(typeof response.headers?.['x-request-id'] === 'string'
      ? { requestId: response.headers['x-request-id'] }
      : {}),
  };
}

/**
 * True when a server `message` is a sentence a person can read: not JSON, not
 * axios/HTTP text, not a machine code, not raw validator output.
 */
export function isReadableServerMessage(message: string | undefined): message is string {
  if (!message) return false;
  const m = message.trim();
  if (m.length === 0 || m.length > 200) return false;
  if (/[{}[\]<>]/.test(m) || /^(body|querystring|params|headers)\//.test(m)) return false;
  if (/^[A-Za-z0-9]+(_[A-Za-z0-9]+)+$/.test(m)) return false;
  if (/request failed|status code|network error|http error|^invalid [\w ]+:|\bmust (match|have|be|not|NOT)\b/i.test(m)) {
    return false;
  }
  return true;
}

/**
 * One short, human message for a failed request that is not about a specific
 * field. Status-level failures get shared copy; a 4xx keeps the server's own
 * sentence when it is readable, else `fallback`.
 */
export function apiErrorMessage(err: unknown, t: TFunction, fallback?: string): string {
  const info = readApiError(err);
  const generic = fallback ?? t('errors.generic', 'Something went wrong. Please try again.');
  if (info.network) {
    return t('errors.network', "Couldn't reach the server. Check your connection and try again.");
  }
  const { status } = info;
  if (status === undefined) return generic;
  // "Session ended" only makes sense if this browser held a session; a sign-in
  // screen's 401 (e.g. send-OTP) falls through to the server's own message.
  if (status === 401 && getCsrfToken() !== null) {
    return t('errors.session', 'Your session has ended. Please sign in again.');
  }
  if (status === 403) return t('errors.forbidden', "You don't have permission to do this.");
  if (status === 429) return t('errors.rate_limited', 'Too many attempts. Please wait a moment and try again.');
  if (status >= 500) {
    const server = t('errors.server', 'Something went wrong on our side. Please try again in a moment.');
    // A server fault names its request, so support can find it.
    return info.requestId
      ? `${server} ${t('errors.reference', 'Reference: {{id}}', { id: info.requestId })}`
      : server;
  }
  return isReadableServerMessage(info.message) ? info.message : generic;
}
