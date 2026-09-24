import type { FastifyRequest } from 'fastify';

/**
 * Query strings the request log must never carry.
 *
 * Fastify logs every request's full URL. On the auth routes the query string
 * is a credential: a partner-portal SSO link (`/sso/login?userName=<JWT>&sig=…`),
 * an OIDC `state` / `code` (`/session/callback`, `/sso/oidc/authorize`). Logged,
 * anyone with log access could replay a still-live one, and the partner JWT
 * carries the user's details. The path is kept — it is what an operator reads.
 */
const REDACTED_PREFIXES = ['/api/v1/auth/'];

export function redactUrlForLog(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const path = url.slice(0, q);
  return REDACTED_PREFIXES.some((p) => path.startsWith(p)) ? `${path}?[redacted]` : url;
}

/**
 * Fastify's default `req` log serializer, with the URL passed through
 * `redactUrlForLog`. Same fields as the default, so log consumers see no change
 * outside the redacted routes.
 */
export function reqLogSerializer(req: FastifyRequest) {
  const version = req.headers?.['accept-version'];
  return {
    method: req.method,
    url: redactUrlForLog(req.url),
    version: Array.isArray(version) ? version[0] : version,
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}
