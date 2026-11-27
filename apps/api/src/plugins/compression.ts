import compress from '@fastify/compress';
import type { FastifyInstance } from 'fastify';

/** Compresses responses with brotli or gzip, as the client's `Accept-Encoding` allows. */
export async function registerCompression(app: FastifyInstance): Promise<void> {
  await app.register(compress, {
    encodings: ['br', 'gzip'],
    // Unpacking request bodies would change the bytes the peer HMAC is checked against.
    globalDecompression: false,
  });
}
