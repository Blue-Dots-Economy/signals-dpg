import { sql } from 'drizzle-orm';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DatabaseError } from 'pg';

const MAX_PARTITION_KEY_LENGTH = 120;

export async function ensureItemPartition(
  db: NodePgDatabase<any>,
  network: string,
  domain: string
) {
  assertValidPartitionKey(network, 'item_network');
  assertValidPartitionKey(domain, 'item_domain');

  try {
    await ensureNestedListPartition(
      db,
      'items',
      network,
      'item_domain',
      domain,
      'i'
    );
  } catch (err) {
    handlePartitionError(err, `item partition "${network}/${domain}"`);
  }
}

export async function ensureActionPartition(
  db: NodePgDatabase<any>,
  network: string,
  actionType: string
) {
  assertValidPartitionKey(network, 'partition_network');
  assertValidPartitionKey(actionType, 'action_type');

  try {
    await ensureNestedListPartition(
      db,
      'item_actions',
      network,
      'action_type',
      actionType,
      'a'
    );
  } catch (err) {
    handlePartitionError(err, `action partition "${network}/${actionType}"`);
  }
}

export async function ensureActionEventPartition(
  db: NodePgDatabase<any>,
  network: string,
  actionType: string
) {
  assertValidPartitionKey(network, 'partition_network');
  assertValidPartitionKey(actionType, 'action_type');

  try {
    await ensureNestedListPartition(
      db,
      'action_events',
      network,
      'action_type',
      actionType,
      'e'
    );
  } catch (err) {
    handlePartitionError(err, `event partition "${network}/${actionType}"`);
  }
}

async function ensureNestedListPartition(
  db: NodePgDatabase<any>,
  rootTableName: 'items' | 'item_actions' | 'action_events',
  network: string,
  childPartitionKey: 'item_domain' | 'action_type',
  childValue: string,
  kind: 'i' | 'a' | 'e'
) {
  const networkPartitionTableName = buildPartitionTableName([network], kind);
  const leafPartitionTableName = buildPartitionTableName(
    [network, childValue],
    kind
  );

  await ensureListPartition(
    db,
    rootTableName,
    networkPartitionTableName,
    network,
    `PARTITION BY LIST (${childPartitionKey})`
  );
  await assertPartitionAttachedForValue(
    db,
    rootTableName,
    networkPartitionTableName,
    network
  );

  await ensureListPartition(
    db,
    networkPartitionTableName,
    leafPartitionTableName,
    childValue
  );
  await assertPartitionAttachedForValue(
    db,
    networkPartitionTableName,
    leafPartitionTableName,
    childValue
  );
}

async function ensureListPartition(
  db: NodePgDatabase<any>,
  parentTableName: string,
  childTableName: string,
  partitionValue: string,
  suffix = ''
) {
  const partitionBound = buildPartitionBoundExpression(partitionValue);

  try {
    await db.execute(
      sql.raw(`
        CREATE TABLE IF NOT EXISTS ${quoteIdentifier(childTableName)}
        PARTITION OF ${quoteIdentifier(parentTableName)}
        ${partitionBound}
        ${suffix};
      `)
    );
  } catch (err) {
    if (
      err instanceof DrizzleQueryError &&
      err.cause instanceof DatabaseError &&
      err.cause.code === '42P07'
    ) {
      return;
    }

    throw err;
  }
}

async function assertPartitionAttachedForValue(
  db: NodePgDatabase<any>,
  parentTableName: string,
  childTableName: string,
  partitionValue: string
) {
  const result = (await db.execute(
    sql.raw(`
      SELECT
        EXISTS (
          SELECT 1
          FROM pg_inherits i
          JOIN pg_class child ON child.oid = i.inhrelid
          JOIN pg_class parent ON parent.oid = i.inhparent
          JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
          JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
          WHERE child_ns.nspname = current_schema()
            AND parent_ns.nspname = current_schema()
            AND child.relname = '${escapeSqlLiteral(childTableName)}'
            AND parent.relname = '${escapeSqlLiteral(parentTableName)}'
        ) AS attached,
        (
          SELECT pg_get_expr(child.relpartbound, child.oid)
          FROM pg_inherits i
          JOIN pg_class child ON child.oid = i.inhrelid
          JOIN pg_class parent ON parent.oid = i.inhparent
          JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
          JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
          WHERE child_ns.nspname = current_schema()
            AND parent_ns.nspname = current_schema()
            AND child.relname = '${escapeSqlLiteral(childTableName)}'
            AND parent.relname = '${escapeSqlLiteral(parentTableName)}'
          LIMIT 1
        ) AS partition_bound;
    `)
  )) as { rows?: Array<{ attached: boolean; partition_bound: string | null }> };

  if (!result.rows?.[0]?.attached) {
    throw new Error(
      `Partition table "${childTableName}" exists but is not attached to parent "${parentTableName}". Drop or rename the stale table and retry.`
    );
  }

  const expectedPartitionBound = buildPartitionBoundExpression(partitionValue);
  if (result.rows[0].partition_bound !== expectedPartitionBound) {
    throw new Error(
      `Partition table "${childTableName}" is attached to parent "${parentTableName}" but uses bound "${result.rows[0].partition_bound ?? 'unknown'}" instead of "${expectedPartitionBound}". Rename or drop the conflicting partition and retry.`
    );
  }
}

function handlePartitionError(err: unknown, label: string) {
  if (err instanceof DrizzleQueryError && err.cause instanceof DatabaseError) {
    if (err.cause.code === '42P07') {
      return;
    }

    if (err.cause.code === '23514') {
      throw new Error(`Partition constraint mismatch for ${label}`);
    }
  }

  throw err;
}

function assertValidPartitionKey(value: string, label: string) {
  if (!value.trim()) {
    throw new Error(`Invalid ${label} partition key: empty value`);
  }

  if (value.length > MAX_PARTITION_KEY_LENGTH) {
    throw new Error(`Invalid ${label} partition key: exceeds ${MAX_PARTITION_KEY_LENGTH} characters`);
  }
}

function buildPartitionTableName(values: string[], kind: 'i' | 'a' | 'e') {
  const normalizedParts = values
    .map((v) => v.toLowerCase().replace(/[^a-z0-9]+/g, ''))
    .filter(Boolean);

  const base = normalizedParts.join('_') || 'value';
  const prefix = `${kind}_p_`;
  const maxBaseLength = 63 - prefix.length;
  const truncated = base.slice(0, Math.max(1, maxBaseLength));

  return `${prefix}${truncated}`;
}

function buildPartitionBoundExpression(value: string) {
  return `FOR VALUES IN ('${escapeSqlLiteral(value)}')`;
}

function escapeSqlLiteral(value: string) {
  return value.replace(/'/g, "''");
}

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}
