import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { peerConfig } from '@/config';

export const INSTANCE_TOKEN_HEADER = 'x-instance-token';
export const INSTANCE_TIMESTAMP_HEADER = 'x-instance-timestamp';

export type VerifyFailureReason =
  /** Neither header sent — an unsigned caller. The only reason permissive forgives. */
  | 'missing'
  /** One header sent without the other — a failed attempt, never forgiven. */
  | 'incomplete'
  | 'malformed_timestamp'
  | 'expired'
  | 'bad_signature';

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: VerifyFailureReason };

function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

// Binds timestamp + path + a hash of the exact request body, so a captured
// token cannot be replayed against another path or body.
function computeToken(
  secret: string,
  timestamp: number,
  targetPath: string,
  body: string
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${targetPath}.${hashBody(body)}`)
    .digest('hex');
}

/** Sender side. Returns the HMAC token + unix-second timestamp to send. */
export function signInstanceToken(input: {
  targetPath: string;
  body: string;
  secret?: string;
  nowSeconds?: number;
}): { token: string; timestamp: number } {
  const secret = input.secret ?? peerConfig.shared_secret;
  const timestamp = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  return {
    token: computeToken(secret, timestamp, input.targetPath, input.body),
    timestamp,
  };
}

/** Convenience for outbound peer fetches: the two headers to spread in. */
export function buildPeerHeaders(
  targetPath: string,
  body: string
): Record<string, string> {
  const { token, timestamp } = signInstanceToken({ targetPath, body });
  return {
    [INSTANCE_TOKEN_HEADER]: token,
    [INSTANCE_TIMESTAMP_HEADER]: String(timestamp),
  };
}

/** Receiver side. Constant-time verify within `windowSeconds` (default 300). */
export function verifyInstanceToken(input: {
  targetPath: string;
  body: string;
  token: string | undefined;
  timestamp: string | number | undefined;
  secret?: string;
  nowSeconds?: number;
  windowSeconds?: number;
}): VerifyResult {
  const secret = input.secret ?? peerConfig.shared_secret;
  const windowSeconds = input.windowSeconds ?? peerConfig.token_window_seconds;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);

  // `missing` (neither header) is the only reason permissive mode forgives, so
  // a half-formed attempt (one header only) must be `incomplete` instead.
  if (!input.token && input.timestamp === undefined) {
    return { ok: false, reason: 'missing' };
  }
  if (!input.token || input.timestamp === undefined) {
    return { ok: false, reason: 'incomplete' };
  }

  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts) || !Number.isInteger(ts)) {
    return { ok: false, reason: 'malformed_timestamp' };
  }

  // Reject stale and future-dated tokens (replay + clock-skew guard).
  if (Math.abs(now - ts) > windowSeconds) {
    return { ok: false, reason: 'expired' };
  }

  const expected = computeToken(secret, ts, input.targetPath, input.body);
  const provided = input.token;

  // timingSafeEqual throws on unequal lengths; length is not secret.
  if (provided.length !== expected.length) {
    return { ok: false, reason: 'bad_signature' };
  }

  const equal = timingSafeEqual(
    Buffer.from(provided, 'utf8'),
    Buffer.from(expected, 'utf8')
  );
  return equal ? { ok: true } : { ok: false, reason: 'bad_signature' };
}
