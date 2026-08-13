/**
 * Pure orchestration core for the Keycloak user migration (rollout step R4 of
 * `docs/superpowers/plans/2026-07-23-keycloak-migration-design.md`).
 *
 * The CLI wrapper (`scripts/migrate_users_to_keycloak.ts`) owns all the
 * side-effects — env loading, the pg pool, arg parsing, `process.exit` — and
 * injects everything this module needs: a Keycloak admin client, a data-access
 * object, options, and a logger. That keeps every migration *decision* (the
 * FATAL abort when a UUID is not honoured, the service-user exclusion wiring,
 * the reconcile false-green, dry-run conflict detection, idempotent re-runs)
 * unit-testable with fakes — no Keycloak and no Postgres.
 *
 * Each entry point returns a structured result **and** an exit code, and prints
 * through the injected logger, so the CLI's console output is unchanged.
 */
import { randomUUID } from 'node:crypto';
import {
  KeycloakAdminError,
  type KeycloakAdminClient,
} from './keycloak_admin.js';
import {
  mapUserToKeycloak,
  type KeycloakUserRepresentation,
  type SignalsUserRow,
} from './user_to_keycloak.js';

/** The Keycloak operations the migration needs — a narrow slice of the admin
 * client, so a fake in a test only has to implement these. */
export type MigrationClient = Pick<
  KeycloakAdminClient,
  | 'createUser'
  | 'getUserById'
  | 'deleteUser'
  | 'findByEmail'
  | 'findByPhone'
  | 'partialImportUsers'
  | 'attributesWillPersist'
>;

/** Data access the migration needs. The SQL lives in the CLI shell; the
 * decisions live here, so tests inject rows directly. */
export interface MigrationData {
  fetchHumanUsers(limit?: number): Promise<SignalsUserRow[]>;
  countServiceUsers(): Promise<number>;
  fetchPasswordAccountRows(): Promise<Array<{ providerId: string; n: number }>>;
}

export interface MigrationOptions {
  strategy: 'create' | 'import';
  batch: number;
  limit?: number;
}

export interface Logger {
  log: (msg?: string) => void;
  error: (msg?: string) => void;
}

const consoleLogger: Logger = {
  log: (m = '') => console.log(m),
  error: (m = '') => console.error(m),
};

export interface Tally {
  total: number;
  created: number;
  skipped: number;
  conflicts: number;
  unmappable: number;
  idNotHonoured: number;
  failed: number;
}

export function emptyTally(total: number): Tally {
  return {
    total,
    created: 0,
    skipped: 0,
    conflicts: 0,
    unmappable: 0,
    idNotHonoured: 0,
    failed: 0,
  };
}

export function describe(err: unknown): string {
  if (err instanceof KeycloakAdminError) {
    const status = err.status ? ` (HTTP ${err.status})` : '';
    const body = err.body ? `: ${err.body}` : '';
    return `${err.message}${status}${body}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function report(tally: Tally, apply: boolean, logger: Logger): void {
  logger.log('');
  logger.log(`${apply ? 'applied' : 'would apply'}:`);
  logger.log(`  total considered: ${tally.total}`);
  logger.log(`  ${apply ? 'created' : 'to create'}: ${tally.created}`);
  logger.log(`  already present (skipped): ${tally.skipped}`);
  logger.log(`  identifier conflicts: ${tally.conflicts}`);
  logger.log(`  unmappable rows: ${tally.unmappable}`);
  logger.log(`  id-not-honoured: ${tally.idNotHonoured}`);
  logger.log(`  errors: ${tally.failed}`);
}

export type ProbeVerdict = 'honoured' | 'ignored' | 'inconclusive';

export interface ProbeResult {
  code: number;
  verdict: ProbeVerdict;
  assignedId?: string;
}

/**
 * §6.3 spike 1, executed rather than assumed: does POST /users honour a
 * client-supplied id on THIS Keycloak? Creates and deletes a throwaway user.
 */
export async function runProbe(
  client: MigrationClient,
  logger: Logger = consoleLogger,
  ids: () => string = randomUUID
): Promise<ProbeResult> {
  const probeId = ids();
  const probeUser = {
    id: probeId,
    username: `zz-uuid-probe-${probeId}`,
    enabled: false,
    emailVerified: false,
    attributes: {},
    realmRoles: [],
    credentials: [] as never[],
    requiredActions: [] as never[],
  };

  logger.log(`probing whether POST /users honours a supplied id (${probeId})…`);

  let outcome;
  try {
    outcome = await client.createUser(probeUser);
  } catch (err) {
    logger.error(`probe failed to create a user: ${describe(err)}`);
    return { code: 1, verdict: 'inconclusive' };
  }

  let verdict: ProbeVerdict = 'inconclusive';
  let assignedId: string | undefined;
  if (outcome.kind === 'created') {
    const readBack = await client.getUserById(probeId).catch(() => null);
    verdict = readBack ? 'honoured' : 'ignored';
  } else if (outcome.kind === 'created_with_different_id') {
    verdict = 'ignored';
    assignedId = outcome.assignedId;
    logger.log(`  Keycloak assigned its own id: ${outcome.assignedId}`);
  }

  await client.deleteUser(probeId).catch(() => {});
  if (outcome.kind === 'created_with_different_id') {
    await client.deleteUser(outcome.assignedId).catch(() => {});
  }

  logger.log('');
  if (verdict === 'honoured') {
    logger.log('RESULT: this Keycloak HONOURS a client-supplied id.');
    logger.log('  -> run the migration with the default --strategy=create.');
    return { code: 0, verdict };
  }
  if (verdict === 'ignored') {
    logger.log('RESULT: this Keycloak IGNORES a client-supplied id.');
    logger.log('  -> POST /users cannot preserve UUIDs. Re-run via --strategy=import');
    logger.log('     (partialImport) and verify with --reconcile before trusting it.');
    return { code: 1, verdict, assignedId };
  }
  logger.log(`RESULT: inconclusive (create returned "${outcome.kind}").`);
  return { code: 1, verdict };
}

export interface PasswordAuditResult {
  code: number;
  total: number;
}

/** Risk R6: the "no credentials to migrate" assumption only holds if nobody
 * has a real password. */
export async function runPasswordAudit(
  data: MigrationData,
  logger: Logger = consoleLogger
): Promise<PasswordAuditResult> {
  const rows = await data.fetchPasswordAccountRows();
  const total = rows.reduce((sum, r) => sum + r.n, 0);

  logger.log(`password-bearing rows in \`account\`: ${total}`);
  for (const row of rows) logger.log(`  provider=${row.providerId}: ${row.n}`);
  logger.log('');

  if (total === 0) {
    logger.log('RESULT: no password accounts. The OTP-only migration holds (R6 clear).');
    return { code: 0, total };
  }
  logger.log('RESULT: password accounts EXIST.');
  logger.log('  These users have no OTP-only path and will not be able to sign in');
  logger.log('  after cutover. Plan a reset flow before R4.');
  return { code: 1, total };
}

/**
 * Refuse to run if `phoneNumber` writes would be silently discarded (Keycloak 26
 * drops undeclared attributes without error → a FALSE GREEN reconcile).
 */
export async function assertAttributesPersist(
  client: MigrationClient,
  logger: Logger = consoleLogger
): Promise<boolean> {
  const ok = await client.attributesWillPersist('phoneNumber');
  if (ok) return true;
  logger.error('');
  logger.error('ABORT: this realm will silently DROP the `phoneNumber` attribute.');
  logger.error('  Fix: run infra/keycloak/init/apply-user-profile.sh, then re-run.');
  return false;
}

export interface MigrationResult {
  code: number;
  tally: Tally;
}

export async function runMigration(
  client: MigrationClient,
  data: MigrationData,
  opts: MigrationOptions,
  apply: boolean,
  logger: Logger = consoleLogger
): Promise<MigrationResult> {
  if (!(await assertAttributesPersist(client, logger))) {
    return { code: 2, tally: emptyTally(0) };
  }

  const users = await data.fetchHumanUsers(opts.limit);
  const excluded = await data.countServiceUsers();
  const tally = emptyTally(users.length);

  logger.log(`${apply ? 'APPLY' : 'DRY RUN'} — strategy=${opts.strategy}`);
  logger.log(`local human users to migrate: ${users.length}`);
  logger.log(`service users excluded (they become Keycloak clients): ${excluded}`);
  if (opts.limit !== undefined) {
    logger.log(`NOTE: --limit=${opts.limit} — this is a partial run, not full coverage.`);
  }
  logger.log('');

  const ready = mapReadyUsers(users, tally, logger);

  if (!apply) {
    await dryRunPass(client, ready, tally, logger);
    report(tally, apply, logger);
    return { code: tally.conflicts > 0 || tally.failed > 0 ? 1 : 0, tally };
  }

  if (opts.strategy === 'import') {
    await importPass(client, ready, opts.batch, tally, logger);
    report(tally, apply, logger);
    return { code: tally.failed > 0 ? 1 : 0, tally };
  }

  const aborted = await createPass(client, ready, tally, logger);
  report(tally, apply, logger);
  return { code: aborted || tally.failed > 0 || tally.conflicts > 0 ? 1 : 0, tally };
}

type ReadyUser = { row: SignalsUserRow; user: KeycloakUserRepresentation };

function mapReadyUsers(users: SignalsUserRow[], tally: Tally, logger: Logger): ReadyUser[] {
  const ready: ReadyUser[] = [];
  for (const row of users) {
    const rep = mapUserToKeycloak(row);
    if (rep.ok) {
      ready.push({ row, user: rep.user });
    } else {
      tally.unmappable += 1;
      logger.log(`  SKIP  ${row.id}  unmappable: ${rep.message}`);
    }
  }
  return ready;
}

/** Users already holding this row's email/phone under a DIFFERENT Keycloak id. */
async function findIdentifierClashes(client: MigrationClient, row: SignalsUserRow) {
  let clash: Awaited<ReturnType<MigrationClient['findByEmail']>> = [];
  if (row.email) {
    clash = await client.findByEmail(row.email);
  } else if (row.phoneNumber) {
    clash = await client.findByPhone(row.phoneNumber);
  }
  return clash.filter((c) => c.id !== row.id);
}

/** Dry run: report the collision case (§6.3 spike 2) without writing. */
async function dryRunPass(
  client: MigrationClient,
  ready: ReadyUser[],
  tally: Tally,
  logger: Logger,
): Promise<void> {
  for (const { row } of ready) {
    try {
      const existing = await client.getUserById(row.id);
      if (existing) {
        tally.skipped += 1;
        continue;
      }
      const foreign = await findIdentifierClashes(client, row);
      if (foreign.length > 0) {
        tally.conflicts += 1;
        logger.log(
          `  CONFLICT ${row.id}  identifiers already held by Keycloak user ${foreign[0].id}`
        );
        continue;
      }
      tally.created += 1;
    } catch (err) {
      tally.failed += 1;
      logger.log(`  ERROR ${row.id}  ${describe(err)}`);
    }
  }
}

async function importPass(
  client: MigrationClient,
  ready: ReadyUser[],
  batchSize: number,
  tally: Tally,
  logger: Logger,
): Promise<void> {
  for (let i = 0; i < ready.length; i += batchSize) {
    const batch = ready.slice(i, i + batchSize).map((r) => r.user);
    try {
      const result = await client.partialImportUsers(batch);
      tally.created += result.added;
      tally.skipped += result.skipped;
      logger.log(
        `  batch ${i / batchSize + 1}: added=${result.added} skipped=${result.skipped}`
      );
    } catch (err) {
      tally.failed += batch.length;
      logger.log(`  ERROR batch ${i / batchSize + 1}: ${describe(err)}`);
    }
  }
}

/** Per-user create. Returns true when the run must abort (id not honoured). */
async function createPass(
  client: MigrationClient,
  ready: ReadyUser[],
  tally: Tally,
  logger: Logger,
): Promise<boolean> {
  for (const { user } of ready) {
    try {
      const outcome = await client.createUser(user);
      switch (outcome.kind) {
        case 'created':
          tally.created += 1;
          break;
        case 'already_exists':
          tally.skipped += 1;
          break;
        case 'conflict':
          tally.conflicts += 1;
          logger.log(`  CONFLICT ${user.id}  ${outcome.detail}`);
          break;
        case 'created_with_different_id':
          // Stop immediately: continuing would produce a population whose subs
          // do not match the local ids — the one thing this migration must
          // never do.
          tally.idNotHonoured += 1;
          logger.error('');
          logger.error(
            `FATAL: Keycloak assigned id ${outcome.assignedId} instead of ${user.id}.`
          );
          logger.error('  UUIDs are NOT being preserved. Aborting before more rows are');
          logger.error('  written. Delete the users created so far, then re-run with');
          logger.error('  --strategy=import. See §6.3 spike 1.');
          return true;
      }
    } catch (err) {
      tally.failed += 1;
      logger.log(`  ERROR ${user.id}  ${describe(err)}`);
    }
  }
  return false;
}

export interface ReconcileResult {
  code: number;
  matched: number;
  missing: string[];
  missingPhoneAttr: string[];
  errored: number;
}

/** The R4 go/no-go gate: every local human user must have a Keycloak user under
 * the same id, with its phone attribute intact (id-presence alone is a false
 * green — see the FALSE GREEN note in the design). */
export async function runReconcile(
  client: MigrationClient,
  data: MigrationData,
  opts: Pick<MigrationOptions, 'limit'>,
  logger: Logger = consoleLogger
): Promise<ReconcileResult> {
  const users = await data.fetchHumanUsers(opts.limit);
  const missing: string[] = [];
  const missingPhoneAttr: string[] = [];
  let matched = 0;
  let errored = 0;

  for (const row of users) {
    try {
      const found = await client.getUserById(row.id);
      if (!found) {
        missing.push(row.id);
        continue;
      }
      matched += 1;
      if (row.phoneNumber?.trim() && !found.attributes?.phoneNumber?.length) {
        missingPhoneAttr.push(row.id);
      }
    } catch (err) {
      errored += 1;
      logger.log(`  ERROR ${row.id}  ${describe(err)}`);
    }
  }

  logger.log('');
  logger.log(`local human users: ${users.length}`);
  logger.log(`matched in Keycloak by id: ${matched}`);
  logger.log(`missing: ${missing.length}`);
  logger.log(`present but missing the phoneNumber attribute: ${missingPhoneAttr.length}`);
  logger.log(`errored: ${errored}`);
  for (const id of missing.slice(0, 50)) logger.log(`  MISSING ${id}`);
  if (missing.length > 50) logger.log(`  … and ${missing.length - 50} more`);
  for (const id of missingPhoneAttr.slice(0, 50)) logger.log(`  NO_PHONE_ATTR ${id}`);
  if (missingPhoneAttr.length > 50) {
    logger.log(`  … and ${missingPhoneAttr.length - 50} more`);
  }
  logger.log('');

  const result: ReconcileResult = { code: 0, matched, missing, missingPhoneAttr, errored };
  if (missing.length === 0 && missingPhoneAttr.length === 0 && errored === 0) {
    logger.log('RESULT: reconciles 1:1, phone attributes intact. R4 gate is green.');
    return result;
  }
  if (missingPhoneAttr.length > 0) {
    logger.log('RESULT: ids reconcile but phone attributes were DROPPED.');
    logger.log('  These users cannot receive an OTP. Run apply-user-profile.sh, then');
    logger.log('  delete those rows and re-run (partialImport SKIP will not repair them).');
    return { ...result, code: 1 };
  }
  logger.log('RESULT: does NOT reconcile. Do not advance past R4.');
  return { ...result, code: 1 };
}
