import type { FastifyReply, FastifyRequest } from 'fastify';
import { peerConfig } from '@/config';
import {
  INSTANCE_TOKEN_HEADER,
  INSTANCE_TIMESTAMP_HEADER,
  verifyInstanceToken,
} from '@/utils/instance_token';

/**
 * preHandler for the peer-only *_local routes. Verifies the HMAC instance
 * token (bound to path + body) so only network peers reach raw local item
 * data. Returns a reply, never throws.
 *
 * PEER_AUTH_MODE=permissive (default) allows a missing token, for peers
 * without inter-instance auth, but rejects an invalid one. 'enforced' requires
 * a valid token on every call.
 */
export async function peer_instance_guard(
  request: FastifyRequest,
  reply: FastifyReply
) {
  return verifyPeerRequest(request, reply, { allowUnsigned: peerConfig.auth_mode === 'permissive' });
}

/**
 * Peer guard that never accepts an unsigned request, whatever `PEER_AUTH_MODE`
 * says. Used by `/network/action/perform`, whose body asserts identity
 * (`source_item_owner`, `performed_by_*`) and which has no legitimate unsigned
 * caller, so the permissive read-route allowance must not apply.
 */
export async function peer_instance_guard_strict(
  request: FastifyRequest,
  reply: FastifyReply
) {
  return verifyPeerRequest(request, reply, { allowUnsigned: false });
}

async function verifyPeerRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: { allowUnsigned: boolean }
) {
  const token = request.headers[INSTANCE_TOKEN_HEADER];
  const timestamp = request.headers[INSTANCE_TIMESTAMP_HEADER];
  const targetPath = request.url.split('?')[0];
  // Verify the raw request bytes (captured by plugins/raw_body.ts), not a
  // re-serialization of `request.body`: Zod has already stripped undeclared
  // keys and added defaults, which would change the hash. The fallback only
  // applies to non-JSON bodies, which peer routes never send.
  const body =
    (request as { rawBody?: string }).rawBody ?? JSON.stringify(request.body ?? {});

  const result = verifyInstanceToken({
    targetPath,
    body,
    token: typeof token === 'string' ? token : undefined,
    timestamp: typeof timestamp === 'string' ? timestamp : undefined,
  });

  if (result.ok) {
    return;
  }

  // Only a missing token is allowed; a half-formed attempt (`incomplete`) is
  // still rejected.
  if (opts.allowUnsigned && result.reason === 'missing') {
    request.log.warn(
      { path: targetPath },
      'Peer request without instance token allowed (PEER_AUTH_MODE=permissive)'
    );
    return;
  }

  request.log.warn(
    { path: targetPath, reason: result.reason },
    'Rejected peer request: invalid instance token'
  );
  return reply.code(401).send({
    code: 'PEER_AUTH_FAILED',
    error: 'Unauthorized',
    message: 'Invalid or missing instance token',
  });
}
