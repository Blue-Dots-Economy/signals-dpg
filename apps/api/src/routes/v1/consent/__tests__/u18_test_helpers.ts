/**
 * Shared integration-test harness for the U18 DOB + guardian capture routes.
 *
 * Mirrors the auth seeding + Fastify app-build in `consent.integration.test.ts`
 * verbatim: real auth via a seeded `x-api-key` resolved by the auth middleware
 * (no bearer stub). `buildU18TestApp()` builds the app, seeds a user + apikey,
 * and returns everything a test needs to exercise `/api/v1/consent/u18/*`.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { eq } from 'drizzle-orm';
import { randomUUID, randomBytes, createHash } from 'node:crypto';

export interface U18TestAppContext {
  app: FastifyInstance;
  userId: string;
  rawKey: string;
  network: string;
  close: () => Promise<void>;
}

export async function buildU18TestApp(): Promise<U18TestAppContext> {
  const { db } = await import('@api/db/postgres/drizzle_config');
  const { user, apikey } = await import('../../../../../db/postgres/schema/auth.js');
  const { apiConfig } = await import('@/config');
  const consent_routes_mod = await import('../consent_routes.js');

  if (apiConfig.served_domains.length === 0) {
    throw new Error(
      'U18 test harness requires SERVED_DOMAINS to have at least one entry',
    );
  }
  const network = apiConfig.served_domains[0].network;

  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(consent_routes_mod.default, {
    prefix: '/api/v1/consent',
  });

  const listen_port = Number(process.env.U18_TEST_API_PORT ?? 2745);
  try {
    await app.listen({ port: listen_port, host: '127.0.0.1' });
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e?.code === 'EADDRINUSE') {
      throw new Error(
        `integration test requires port ${listen_port} to be free ` +
          `(set U18_TEST_API_PORT). Is the dev server already running?`,
      );
    }
    throw err;
  }

  const userId = `test-u18-${randomUUID()}`;
  const rawKey = `sk_signals_${randomBytes(24).toString('hex')}`;
  const now = new Date();

  await db.insert(user).values({
    id: userId,
    email: `u18-int-${Date.now()}@signals.local`,
    name: `u18-int-user-${Date.now()}`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });

  const hashed_key = createHash('sha256').update(rawKey).digest('base64url');
  await db.insert(apikey).values({
    id: `key_${randomUUID()}`,
    name: `u18-int-key-${Date.now()}`,
    key: hashed_key,
    userId,
    referenceId: userId,
    configId: 'default',
    start: rawKey.slice(0, 6),
    prefix: 'sk_signals_',
    enabled: true,
    rateLimitEnabled: false,
    createdAt: now,
    updatedAt: now,
  });

  const close = async () => {
    await db.delete(apikey).where(eq(apikey.userId, userId));
    await db.delete(user).where(eq(user.id, userId));
    await app.close();
  };

  return { app, userId, rawKey, network, close };
}
