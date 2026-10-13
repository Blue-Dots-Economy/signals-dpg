import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { Writable } from 'node:stream';
import { redactUrlForLog, reqLogSerializer } from '../log_redaction.js';

describe('redactUrlForLog', () => {
  it('drops the query string on auth routes, keeping the path', () => {
    expect(redactUrlForLog('/api/v1/auth/sso/login?userName=eyJhbGci.x.y&sig=abc&expiry=1')).toBe(
      '/api/v1/auth/sso/login?[redacted]'
    );
    expect(redactUrlForLog('/api/v1/auth/session/callback?code=c&state=s')).toBe(
      '/api/v1/auth/session/callback?[redacted]'
    );
  });

  it('leaves other routes and query-less URLs alone', () => {
    expect(redactUrlForLog('/api/v1/network/item/discover?q=plumber')).toBe(
      '/api/v1/network/item/discover?q=plumber'
    );
    expect(redactUrlForLog('/api/v1/auth/sso/login')).toBe('/api/v1/auth/sso/login');
  });
});

describe('reqLogSerializer in a real Fastify logger', () => {
  it('never writes the partner token to the request log', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const app = Fastify({ logger: { stream, serializers: { req: reqLogSerializer } } });
    app.get('/api/v1/auth/sso/login', async () => 'ok');
    await app.inject({ method: 'GET', url: '/api/v1/auth/sso/login?userName=SECRETJWT&sig=SECRETSIG' });
    await app.close();

    const log = lines.join('');
    expect(log).toContain('/api/v1/auth/sso/login?[redacted]');
    expect(log).not.toContain('SECRETJWT');
    expect(log).not.toContain('SECRETSIG');
  });
});
