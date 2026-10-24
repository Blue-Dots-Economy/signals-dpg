import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Keeps the exact JSON bytes of a request as `request.rawBody`.
 *
 * `peer_instance_guard` verifies the peer HMAC over these raw bytes. Hashing
 * `JSON.stringify(request.body)` instead would hash the Zod-validated body
 * (undeclared keys stripped, defaults injected) and reject legitimate peers.
 */
export function registerRawBodyCapture(app: FastifyInstance): void {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request, raw: string, done) => {
      (request as FastifyRequest & { rawBody?: string }).rawBody = raw;
      // An empty body parses to `undefined`, so only the route's body schema can
      // reject it. A route without a body schema (e.g. `POST /refetch_schemas`)
      // receives an empty body unchallenged.
      if (raw.length === 0) return done(null, undefined);
      try {
        done(null, JSON.parse(raw));
      } catch (err) {
        // Preserve Fastify's own 400 for malformed JSON.
        (err as Error & { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    }
  );
}
