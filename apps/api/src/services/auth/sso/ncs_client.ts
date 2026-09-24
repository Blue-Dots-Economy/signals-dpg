import z from '@dpg/schemas';
import { CallGuard } from '@/utils/call_guard';
import { hmacSha256Hex } from '@/utils/secure_crypto';
import type { SsoResult } from '@/services/auth/sso/types';

/**
 * Client for the NCS partner API's token validation
 * (`POST {base}/api/integration/validate-token`).
 *
 * NCS requires an HMAC-SHA256 of the token keyed with our Client Secret, sent
 * as lowercase hex beside the token and our Client ID. A clean "no" from NCS
 * (`status: FAILURE`) is `link-invalid`; anything that is not a well-formed
 * answer — timeout, 5xx, network error, an unexpected body — is
 * `provider-unavailable` and counts toward the circuit breaker, so a flapping
 * NCS is not hammered with every login attempt.
 */

export interface NcsClientConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  timeoutMs: number;
  maxConcurrent?: number;
  failureThreshold?: number;
  openMs?: number;
}

const NcsUserSchema = z.object({
  userId: z.string().min(1),
  fullName: z.string().nullish(),
  mobileNumber: z.string().nullish(),
  role: z.string().nullish(),
  email: z.string().nullish(),
  isEmailVerified: z.boolean().nullish(),
  isMobileVerified: z.boolean().nullish(),
  status: z.string().nullish(),
});

export type NcsUser = z.infer<typeof NcsUserSchema>;

const ValidateResponseSchema = z.object({
  status: z.string(),
  data: z.unknown().optional(),
});

/** Thrown inside the guard only for upstream faults, so they trip the breaker. */
class NcsUnavailableError extends Error {}

export interface NcsClient {
  validateToken(token: string): Promise<SsoResult<NcsUser>>;
}

export function createNcsClient(
  config: NcsClientConfig,
  fetchImpl: typeof fetch = fetch
): NcsClient {
  const guard = new CallGuard({
    maxConcurrent: config.maxConcurrent ?? 20,
    failureThreshold: config.failureThreshold ?? 5,
    openMs: config.openMs ?? 30_000,
  });
  const url = `${config.baseUrl}/api/integration/validate-token`;

  async function call(token: string): Promise<SsoResult<NcsUser>> {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        token,
        hmac: hmacSha256Hex(config.clientSecret, token),
        clientId: config.clientId,
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (res.status >= 500) throw new NcsUnavailableError(`NCS returned ${res.status}`);

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new NcsUnavailableError('NCS returned a non-JSON body');
    }

    const envelope = ValidateResponseSchema.safeParse(body);
    if (!envelope.success) throw new NcsUnavailableError('NCS returned an unexpected body');

    if (envelope.data.status !== 'SUCCESS') {
      return { ok: false, reason: 'link-invalid', detail: `NCS status ${envelope.data.status}` };
    }

    const user = NcsUserSchema.safeParse(envelope.data.data);
    if (!user.success) throw new NcsUnavailableError('NCS SUCCESS body has no usable user');
    return { ok: true, value: user.data };
  }

  return {
    async validateToken(token) {
      const outcome = await guard.run(() => call(token));
      if (outcome.ok) return outcome.value;
      const detail =
        outcome.reason === 'failed'
          ? outcome.error instanceof Error
            ? outcome.error.message
            : 'NCS call failed'
          : `NCS call refused (${outcome.reason})`;
      return { ok: false, reason: 'provider-unavailable', detail };
    },
  };
}
