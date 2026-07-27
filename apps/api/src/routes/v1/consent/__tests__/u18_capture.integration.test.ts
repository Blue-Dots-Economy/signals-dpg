import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// Guardian OTP send → no-op (no real notifier). Mocked before app import.
vi.mock('@/utils/notificationClient', () => ({ getNotificationClient: () => ({ notify: async () => {} }) }));

import { db } from '@api/db/postgres/drizzle_config';
import { minor_guardian, consent_record } from '@api/db/postgres/schema';
import { redis } from '@api/db/secondary/redis';
import { buildU18TestApp, seedU18TestUser } from './u18_test_helpers';

let ctx: Awaited<ReturnType<typeof buildU18TestApp>>;

beforeAll(async () => {
  ctx = await buildU18TestApp();
});
afterAll(async () => {
  await db.delete(consent_record).where(eq(consent_record.userId, ctx.userId));
  await db.delete(minor_guardian).where(eq(minor_guardian.userId, ctx.userId));
  await redis.del(`guardian_otp:code:${ctx.userId}:guardian`);
  await redis.del(`guardian_otp:rl:${ctx.userId}:guardian`);
  await redis.del(`guardian_otp:vrl:${ctx.userId}:guardian`);
  await ctx.close();
});

describe('U18 capture (integration)', () => {
  it('age for a minor returns isMinor:true and persists', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/consent/u18/dob',
      headers: { 'x-api-key': ctx.rawKey },
      payload: { network: ctx.network, age: 14 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isMinor).toBe(true);
  });

  it('guardian submit stores encrypted details, writes guardian_declaration, sends OTP', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/consent/u18/guardian',
      headers: { 'x-api-key': ctx.rawKey },
      payload: {
        network: ctx.network, guardianName: 'Parent', guardianEmail: 'p@x.co',
        guardianDeclarationAccepted: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().otpSent).toBe(true);

    const [g] = await db.select().from(minor_guardian).where(eq(minor_guardian.userId, ctx.userId));
    expect(g.guardianContact).not.toBe('p@x.co'); // encrypted at rest
    const decl = (await db.select().from(consent_record).where(eq(consent_record.userId, ctx.userId)))
      .find((r) => r.consentCategory === 'guardian_declaration');
    expect(decl?.source).toBe('self');
  });

  it('verify with the correct OTP writes guardian terms/privacy and flips verified', async () => {
    const otp = await redis.get(`guardian_otp:code:${ctx.userId}:guardian`);
    expect(otp).toMatch(/^\d{6}$/);

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/consent/u18/guardian/verify',
      headers: { 'x-api-key': ctx.rawKey },
      payload: { network: ctx.network, otp },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().verified).toBe(true);

    const cats = (await db.select({ c: consent_record.consentCategory, s: consent_record.source })
      .from(consent_record).where(eq(consent_record.userId, ctx.userId)))
      .filter((r) => r.s === 'guardian').map((r) => r.c).sort();
    expect(cats).toEqual(['privacy', 'terms']);

    const [g] = await db.select().from(minor_guardian).where(eq(minor_guardian.userId, ctx.userId));
    expect(g.guardianVerified).toBe(true);
  });

  it('rejects a wrong OTP with 400', async () => {
    // Nonce was consumed by the previous (successful) verify → no valid code.
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/consent/u18/guardian/verify',
      headers: { 'x-api-key': ctx.rawKey },
      payload: { network: ctx.network, otp: '000000' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('U18 guardian same-contact warn-and-acknowledge (integration)', () => {
  // Reuses ctx.app (already listening) with a freshly seeded ward user —
  // a second buildU18TestApp() would race ctx.app for the same fixed port.
  let sameUser: Awaited<ReturnType<typeof seedU18TestUser>>;

  beforeAll(async () => {
    sameUser = await seedU18TestUser();
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/consent/u18/dob',
      headers: { 'x-api-key': sameUser.rawKey },
      payload: { network: ctx.network, age: 14 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isMinor).toBe(true);
  });

  afterAll(async () => {
    await db.delete(consent_record).where(eq(consent_record.userId, sameUser.userId));
    await db.delete(minor_guardian).where(eq(minor_guardian.userId, sameUser.userId));
    await redis.del(`guardian_otp:code:${sameUser.userId}:guardian`);
    await redis.del(`guardian_otp:rl:${sameUser.userId}:guardian`);
    await redis.del(`guardian_otp:vrl:${sameUser.userId}:guardian`);
    await sameUser.close();
  });

  it('hard-rejects guardianContact matching the ward\'s own email with 409 SAME_CONTACT_NOT_ALLOWED', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/consent/u18/guardian',
      headers: { 'x-api-key': sameUser.rawKey },
      payload: {
        network: ctx.network, guardianName: 'Parent', guardianEmail: sameUser.wardEmail,
        guardianDeclarationAccepted: true,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('SAME_CONTACT_NOT_ALLOWED');
  });

  it('still hard-rejects even with sameContactAcknowledged (no ack bypass — future use case)', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/consent/u18/guardian',
      headers: { 'x-api-key': sameUser.rawKey },
      payload: {
        network: ctx.network, guardianName: 'Parent', guardianEmail: sameUser.wardEmail,
        guardianDeclarationAccepted: true, sameContactAcknowledged: true,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('SAME_CONTACT_NOT_ALLOWED');
  });
});
