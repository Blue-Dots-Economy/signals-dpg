/**
 * Correlation-id (`x-request-id`) plumbing for the API.
 *
 * Shared so the Fastify bootstrap and its unit test build the request-id
 * behaviour from one definition. The id lets a single request be traced across
 * the platform (Kong → aggregator → Signals → search): an inbound
 * `x-request-id` is honoured (length-capped), one is minted when absent, it is
 * logged as `reqId`, and it is echoed back on the response.
 *
 * @module @api/request_id
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Fastify server options that make the id come from `x-request-id`.
 *
 * `requestIdHeader: false` forces `genReqId` to run on every request (Fastify
 * would otherwise use the header value verbatim, uncapped), so we can both read
 * the inbound header and bound its length before it lands in every log line.
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
 * Registers an `onRequest` hook that echoes the resolved correlation id back on
 * the response, so Kong and upstream callers can stitch the trace.
 *
 * @param app - The Fastify instance to attach the hook to.
 */
export function registerRequestIdEcho(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    void reply.header(REQUEST_ID_HEADER, req.id);
  });
}
