import { authInstance } from '../../src/routes/auth/create_auth';
import { FastifyReply, FastifyRequest } from 'fastify';
import { authConfig } from '../../src/config';
import { db } from '../../db/postgres/drizzle_config';
import { user as userTable } from '../../db/postgres/schema/auth';
import { eq } from 'drizzle-orm';

export async function auth_middleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  /**
   * API KEY AUTH (highest priority)
   */
  const apiKey = request.headers['x-api-key'];

  if (typeof apiKey === 'string') {
    const verified = await authInstance.api.verifyApiKey({
      body: {
        key: apiKey,
        permissions: request.permissions || undefined,
      },
    });

    if (verified.error || !verified.valid) {
      return reply.status(403).send({
        code: 'INVALID_API_KEY',
        error: 'Forbidden',
        message: 'Invalid API key provided',
      });
    }

    const key = verified.key as
      | { userId?: string | null; referenceId?: string | null }
      | null;
    const keyUserId = key?.userId ?? key?.referenceId;

    if (keyUserId) {
      const [owner] = await db
        .select({
          id: userTable.id,
          email: userTable.email,
          name: userTable.name,
          role: userTable.role,
        })
        .from(userTable)
        .where(eq(userTable.id, keyUserId))
        .limit(1);

      request.user = owner
        ? {
            id: owner.id,
            email: owner.email ?? '',
            name: owner.name,
            role: owner.role,
          }
        : ({ id: keyUserId } as typeof request.user);
    }

    return;
  }

  /**
   *  SESSION AUTH (fallback)
   */
  const session = await authInstance.api.getSession({
    headers: new Headers(request.headers as Record<string, string>),
  });

  if (!session?.user) {
    return reply.status(401).send({
      code: 'UNAUTHORIZED',
      error: 'Unauthorized',
      message: 'Missing or invalid authentication',
    });
  }

  request.user = session.user;
}

export async function auth_middleware_if_enabled(
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (!authConfig.middleware_enabled) {
    return;
  }

  return auth_middleware(request, reply);
}
