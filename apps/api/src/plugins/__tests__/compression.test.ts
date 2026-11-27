import { brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { registerCompression } from '@/plugins/compression';
import { registerRawBodyCapture } from '@/plugins/raw_body';
import { EXPORT_EXPOSED_HEADERS } from '@/services/action_export/headers';
import { XLSX_CONTENT_TYPE } from '@/services/action_export/xlsx';

const ORIGIN = 'http://ui.test';
const LARGE = {
  markers: Array.from({ length: 200 }, (_, i) => ({
    item_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    item_domain: 'provider',
    item_locations: [{ lat: 28.6 + i / 1000, lng: 77.5 + i / 1000 }],
  })),
};
const XLSX_BYTES = Buffer.alloc(4096, 7);

let app: FastifyInstance;

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify();
  registerRawBodyCapture(instance);
  await registerCompression(instance);
  await instance.register(cors, { origin: ORIGIN, exposedHeaders: [...EXPORT_EXPOSED_HEADERS] });
  instance.get('/large', async () => LARGE);
  instance.get('/small', async () => ({ ok: true }));
  instance.post('/export', async (_request, reply) =>
    reply
      .header('Content-Type', XLSX_CONTENT_TYPE)
      .header('Content-Disposition', 'attachment; filename="export.xlsx"')
      .header('X-Export-Row-Count', '3')
      .send(XLSX_BYTES),
  );
  instance.post('/echo', async (request) => ({
    rawBody: (request as FastifyRequest & { rawBody?: string }).rawBody,
  }));
  await instance.ready();
  return instance;
}

afterEach(async () => {
  await app?.close();
});

describe('response compression', () => {
  it('sends a large JSON answer as brotli when the browser accepts it', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/large', headers: { 'accept-encoding': 'gzip, deflate, br' } });
    expect(res.headers['content-encoding']).toBe('br');
    expect(res.headers.vary).toMatch(/accept-encoding/i);
    expect(res.rawPayload.length).toBeLessThan(JSON.stringify(LARGE).length / 3);
    expect(JSON.parse(brotliDecompressSync(res.rawPayload).toString())).toEqual(LARGE);
  });

  it('falls back to gzip when brotli is not accepted', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/large', headers: { 'accept-encoding': 'gzip' } });
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(gunzipSync(res.rawPayload).toString())).toEqual(LARGE);
  });

  it('sends the answer unchanged when the client accepts no encoding', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/large', headers: { 'accept-encoding': '' } });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body).toBe(JSON.stringify(LARGE));
  });

  it('leaves an answer under 1 KB uncompressed', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/small', headers: { 'accept-encoding': 'br' } });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.json()).toEqual({ ok: true });
  });

  it('leaves the xlsx export untouched and its headers readable cross-origin', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/export',
      headers: { 'accept-encoding': 'gzip, br', origin: ORIGIN },
    });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.rawPayload.equals(XLSX_BYTES)).toBe(true);
    expect(res.headers['content-disposition']).toBe('attachment; filename="export.xlsx"');
    expect(String(res.headers['access-control-expose-headers'])).toContain('X-Export-Row-Count');
  });
});

describe('request bodies', () => {
  it('keeps the exact JSON bytes for the peer signature check', async () => {
    app = await buildApp();
    const raw = '{"b":1,  "a":[2,3]}';
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: raw,
    });
    expect(res.json()).toEqual({ rawBody: raw });
  });

  it('does not unpack a compressed request body', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      payload: gzipSync('{"a":1}'),
    });
    expect(res.statusCode).toBe(400);
  });
});
