import { describe, expect, it, vi } from 'vitest';
import type { SignalsUserRow } from '../user_to_keycloak.js';
import {
  runMigration,
  runReconcile,
  runProbe,
  runPasswordAudit,
  type Logger,
  type MigrationClient,
  type MigrationData,
  type MigrationOptions,
} from '../migrate_core.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

function makeUser(over: Partial<SignalsUserRow> = {}): SignalsUserRow {
  // Spread overrides last so an explicit `null` actually nulls the field
  // (a `??`-based merge would silently fall back to the default on null).
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Test User',
    email: 'user@example.com',
    emailVerified: true,
    phoneNumber: null,
    phoneNumberVerified: null,
    role: null,
    banned: null,
    banReason: null,
    banExpires: null,
    ...over,
  };
}

const silent: Logger = { log: () => {}, error: () => {} };
const OPTS: MigrationOptions = { strategy: 'create', batch: 100, limit: undefined };

type CreateOutcome = Awaited<ReturnType<MigrationClient['createUser']>>;

/** A programmable fake covering exactly the MigrationClient slice. */
class FakeClient implements MigrationClient {
  attributesPersist = true;
  createOutcomes: CreateOutcome[] = [];
  byId = new Map<string, { id: string; attributes?: Record<string, string[]> }>();
  byEmail = new Map<string, Array<{ id: string }>>();
  byPhone = new Map<string, Array<{ id: string }>>();
  importResult = { added: 0, skipped: 0, overwritten: 0 };
  importThrows = false;
  createUser = vi.fn(async (): Promise<CreateOutcome> => {
    return this.createOutcomes.shift() ?? { kind: 'created' };
  });
  getUserById = vi.fn(async (id: string) => this.byId.get(id) ?? null);
  deleteUser = vi.fn(async () => {});
  findByEmail = vi.fn(async (email: string) => this.byEmail.get(email) ?? []);
  findByPhone = vi.fn(async (phone: string) => this.byPhone.get(phone) ?? []);
  partialImportUsers = vi.fn(async () => {
    if (this.importThrows) throw new Error('partialImport failed');
    return this.importResult;
  });
  attributesWillPersist = vi.fn(async () => this.attributesPersist);
}

function fakeData(over: Partial<MigrationData> = {}): MigrationData {
  return {
    fetchHumanUsers: over.fetchHumanUsers ?? vi.fn(async () => []),
    countServiceUsers: over.countServiceUsers ?? vi.fn(async () => 0),
    fetchPasswordAccountRows: over.fetchPasswordAccountRows ?? vi.fn(async () => []),
  };
}

// ── runMigration (apply, create) ─────────────────────────────────────────────

describe('runMigration — apply / create', () => {
  it('ABORTS on created_with_different_id and processes no further rows (the linchpin)', async () => {
    const client = new FakeClient();
    client.createOutcomes = [{ kind: 'created_with_different_id', assignedId: 'kc-generated' }];
    const users = [makeUser({ id: 'aaaaaaaa-1111-4111-8111-111111111111' }), makeUser({ id: 'bbbbbbbb-2222-4222-8222-222222222222' })];
    const data = fakeData({ fetchHumanUsers: vi.fn(async () => users) });

    const { code, tally } = await runMigration(client, data, OPTS, true, silent);

    expect(code).toBe(1);
    expect(tally.idNotHonoured).toBe(1);
    // The second user must NOT be attempted — continuing would write a
    // population whose subs don't match the local ids.
    expect(client.createUser).toHaveBeenCalledTimes(1);
  });

  it('treats already_exists as an idempotent skip (re-run safe), exit 0', async () => {
    const client = new FakeClient();
    client.createOutcomes = [{ kind: 'already_exists' }, { kind: 'already_exists' }];
    const users = [makeUser({ id: 'aaaaaaaa-1111-4111-8111-111111111111' }), makeUser({ id: 'bbbbbbbb-2222-4222-8222-222222222222' })];
    const data = fakeData({ fetchHumanUsers: vi.fn(async () => users) });

    const { code, tally } = await runMigration(client, data, OPTS, true, silent);

    expect(code).toBe(0);
    expect(tally.skipped).toBe(2);
    expect(tally.created).toBe(0);
  });

  it('counts a conflict and exits non-zero', async () => {
    const client = new FakeClient();
    client.createOutcomes = [{ kind: 'conflict', detail: 'foreign identifier holder' }];
    const data = fakeData({ fetchHumanUsers: vi.fn(async () => [makeUser()]) });

    const { code, tally } = await runMigration(client, data, OPTS, true, silent);

    expect(code).toBe(1);
    expect(tally.conflicts).toBe(1);
  });

  it('refuses to run (exit 2) and never reads users when phone attrs would be dropped', async () => {
    const client = new FakeClient();
    client.attributesPersist = false;
    const fetchHumanUsers = vi.fn(async () => [makeUser()]);
    const data = fakeData({ fetchHumanUsers });

    const { code } = await runMigration(client, data, OPTS, true, silent);

    expect(code).toBe(2);
    expect(fetchHumanUsers).not.toHaveBeenCalled();
    expect(client.createUser).not.toHaveBeenCalled();
  });

  it('reports the excluded service-user count from countServiceUsers', async () => {
    const client = new FakeClient();
    client.createOutcomes = [{ kind: 'created' }];
    const lines: string[] = [];
    const logger: Logger = { log: (m = '') => lines.push(m), error: () => {} };
    const data = fakeData({
      fetchHumanUsers: vi.fn(async () => [makeUser()]),
      countServiceUsers: vi.fn(async () => 3),
    });

    await runMigration(client, data, OPTS, true, logger);

    expect(lines.some((l) => l.includes('service users excluded') && l.includes('3'))).toBe(true);
  });
});

// ── runMigration (dry-run) ───────────────────────────────────────────────────

describe('runMigration — dry-run', () => {
  it('flags the §6.3 spike-2 collision: identifiers held by a foreign Keycloak id', async () => {
    const client = new FakeClient();
    // user not present by id, but its email is already held by a different id
    client.byEmail.set('user@example.com', [{ id: 'someone-else' }]);
    const data = fakeData({ fetchHumanUsers: vi.fn(async () => [makeUser()]) });

    const { code, tally } = await runMigration(client, data, OPTS, false, silent);

    expect(code).toBe(1);
    expect(tally.conflicts).toBe(1);
    expect(client.createUser).not.toHaveBeenCalled(); // dry run writes nothing
  });

  it('counts a clean would-create and exits 0', async () => {
    const client = new FakeClient(); // no byId, no clash
    const data = fakeData({ fetchHumanUsers: vi.fn(async () => [makeUser()]) });

    const { code, tally } = await runMigration(client, data, OPTS, false, silent);

    expect(code).toBe(0);
    expect(tally.created).toBe(1);
    expect(tally.conflicts).toBe(0);
  });

  it('tallies an unmappable row (no email and no phone) without writing', async () => {
    const client = new FakeClient();
    const bad = makeUser({ email: null, phoneNumber: null });
    const data = fakeData({ fetchHumanUsers: vi.fn(async () => [bad]) });

    const { tally } = await runMigration(client, data, OPTS, false, silent);

    expect(tally.unmappable).toBe(1);
  });
});

// ── runMigration (apply, import) ─────────────────────────────────────────────

describe('runMigration — apply / import', () => {
  it('tallies partialImport added/skipped', async () => {
    const client = new FakeClient();
    client.importResult = { added: 2, skipped: 1, overwritten: 0 };
    const users = [makeUser({ id: 'a1111111-1111-4111-8111-111111111111' }), makeUser({ id: 'b2222222-2222-4222-8222-222222222222' }), makeUser({ id: 'c3333333-3333-4333-8333-333333333333' })];
    const data = fakeData({ fetchHumanUsers: vi.fn(async () => users) });

    const { code, tally } = await runMigration(
      client,
      data,
      { strategy: 'import', batch: 100 },
      true,
      silent
    );

    expect(code).toBe(0);
    expect(tally.created).toBe(2);
    expect(tally.skipped).toBe(1);
  });

  it('counts the whole batch as failed and exits non-zero when partialImport throws', async () => {
    const client = new FakeClient();
    client.importThrows = true;
    const data = fakeData({ fetchHumanUsers: vi.fn(async () => [makeUser()]) });

    const { code, tally } = await runMigration(client, data, { strategy: 'import', batch: 100 }, true, silent);

    expect(code).toBe(1);
    expect(tally.failed).toBe(1);
  });
});

// ── runReconcile ─────────────────────────────────────────────────────────────

describe('runReconcile', () => {
  it('is green when every id matches and phone attrs are intact', async () => {
    const client = new FakeClient();
    client.byId.set('p1111111-1111-4111-8111-111111111111', {
      id: 'p1111111-1111-4111-8111-111111111111',
      attributes: { phoneNumber: ['+919999999999'] },
    });
    const data = fakeData({
      fetchHumanUsers: vi.fn(async () => [
        makeUser({ id: 'p1111111-1111-4111-8111-111111111111', email: null, phoneNumber: '+919999999999' }),
      ]),
    });

    const { code, missing, missingPhoneAttr } = await runReconcile(client, data, {}, silent);

    expect(code).toBe(0);
    expect(missing).toEqual([]);
    expect(missingPhoneAttr).toEqual([]);
  });

  it('catches the FALSE GREEN: id present but phone attribute dropped → exit 1', async () => {
    const client = new FakeClient();
    // present by id, but attributes has no phoneNumber
    client.byId.set('p1111111-1111-4111-8111-111111111111', {
      id: 'p1111111-1111-4111-8111-111111111111',
      attributes: {},
    });
    const data = fakeData({
      fetchHumanUsers: vi.fn(async () => [
        makeUser({ id: 'p1111111-1111-4111-8111-111111111111', email: null, phoneNumber: '+919999999999' }),
      ]),
    });

    const { code, matched, missingPhoneAttr } = await runReconcile(client, data, {}, silent);

    expect(code).toBe(1);
    expect(matched).toBe(1);
    expect(missingPhoneAttr).toEqual(['p1111111-1111-4111-8111-111111111111']);
  });

  it('reports a missing user and does not advance (exit 1)', async () => {
    const client = new FakeClient(); // byId empty → not found
    const data = fakeData({
      fetchHumanUsers: vi.fn(async () => [makeUser({ id: 'missing-1' })]),
    });

    const { code, missing } = await runReconcile(client, data, {}, silent);

    expect(code).toBe(1);
    expect(missing).toEqual(['missing-1']);
  });
});

// ── runProbe ─────────────────────────────────────────────────────────────────

describe('runProbe', () => {
  it('reports HONOURED (exit 0) when the supplied id reads back', async () => {
    const client = new FakeClient();
    client.createOutcomes = [{ kind: 'created' }];
    const fixedId = 'probe-fixed-id';
    client.byId.set(fixedId, { id: fixedId });

    const { code, verdict } = await runProbe(client, silent, () => fixedId);

    expect(code).toBe(0);
    expect(verdict).toBe('honoured');
    expect(client.deleteUser).toHaveBeenCalled(); // cleans up
  });

  it('reports IGNORED (exit 1) on created_with_different_id', async () => {
    const client = new FakeClient();
    client.createOutcomes = [{ kind: 'created_with_different_id', assignedId: 'kc-generated' }];

    const { code, verdict, assignedId } = await runProbe(client, silent, () => 'probe-x');

    expect(code).toBe(1);
    expect(verdict).toBe('ignored');
    expect(assignedId).toBe('kc-generated');
  });
});

// ── runPasswordAudit ─────────────────────────────────────────────────────────

describe('runPasswordAudit', () => {
  it('is clear (exit 0) when no password rows exist', async () => {
    const data = fakeData({ fetchPasswordAccountRows: vi.fn(async () => []) });
    const { code, total } = await runPasswordAudit(data, silent);
    expect(code).toBe(0);
    expect(total).toBe(0);
  });

  it('flags password accounts (exit 1) with the summed total', async () => {
    const data = fakeData({
      fetchPasswordAccountRows: vi.fn(async () => [
        { providerId: 'credential', n: 2 },
        { providerId: 'email', n: 1 },
      ]),
    });
    const { code, total } = await runPasswordAudit(data, silent);
    expect(code).toBe(1);
    expect(total).toBe(3);
  });
});
