/**
 * Correlation-id (`x-request-id`) plumbing, so one request can be traced
 * across Kong, aggregator, Signals and search. An inbound id is honoured
 * (length-capped), one is minted when absent, logged as `reqId`, and echoed
 * on the response.
 *
 * @module @api/request_id
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Fastify server options that take the id from `x-request-id`.
 * `requestIdHeader: false` forces `genReqId` on every request; otherwise
 * Fastify would use the header verbatim, with no length cap.
 */
export const requestIdOptions: Pick<
  FastifyServerOptions,
  'requestIdHeader' | 'requestIdLogLabel' | 'genReqId'
> = {
  requestIdHeader: false,
  requestIdLogLabel: 'reqId',
  genReqId: (req) => {
    const incoming = req.headers[REQUEST_ID_HEADER];
    if (typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 200) {
      return incoming;
    }
    return `req-${randomUUID()}`;
  },
};

/**
 * Registers an `onRequest` hook that echoes the correlation id on the response.
 */
export function registerRequestIdEcho(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    void reply.header(REQUEST_ID_HEADER, req.id);
  });
}
