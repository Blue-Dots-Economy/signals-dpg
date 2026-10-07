/**
 * Profile columns of an engagement export (#770), derived from the
 * counterparty item schema — never a hardcoded list, so a network's schema
 * change reaches the file without a deploy.
 */

export interface ProfileColumn {
  /** The field key, nested objects as `parent.child` (what `fields` names). */
  header: string;
  /**
   * Heading shown in the file: the schema `title` the UI shows for the field
   * (a humanised key when there is none), nested as `Parent – Child`.
   */
  label: string;
  /** Path into item_state. */
  path: string[];
}

export type ProfileColumnsResult =
  | { ok: true; columns: ProfileColumn[] }
  | { ok: false; unknown: string[] };

type SchemaNode = { type?: unknown; title?: unknown; properties?: Record<string, SchemaNode> };

/** `nameOfLastRoleHeld` / `service_cities` → `Name Of Last Role Held` / `Service Cities`. */
export function humanizeKey(key: string): string {
  return key
    .replaceAll('_', ' ')
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .replaceAll(/\b\w/g, (c) => c.toUpperCase());
}

function titleOf(key: string, node: SchemaNode | undefined): string {
  const title = typeof node?.title === 'string' ? node.title.trim() : '';
  return title || humanizeKey(key);
}

function flatten(
  properties: Record<string, SchemaNode>,
  prefix: string[],
  labelPrefix: string[]
): ProfileColumn[] {
  const out: ProfileColumn[] = [];
  for (const [key, node] of Object.entries(properties)) {
    const path = [...prefix, key];
    const labels = [...labelPrefix, titleOf(key, node)];
    const nested = node?.properties;
    if (node?.type === 'object' && nested && Object.keys(nested).length > 0) {
      out.push(...flatten(nested, path, labels));
    } else {
      out.push({ header: path.join('.'), label: labels.join(' – '), path });
    }
  }
  return out;
}

/**
 * Columns for `fields`: `"*"` = every schema property; a list keeps schema
 * order and may name a top-level key (an object expands to all its
 * sub-columns) or a flattened `parent.child` column.
 *
 * @returns the columns, or every requested field the schema does not declare.
 */
export function resolveProfileColumns(
  schema: Record<string, unknown>,
  fields: '*' | readonly string[]
): ProfileColumnsResult {
  const all = flatten((schema.properties as Record<string, SchemaNode>) ?? {}, [], []);
  if (fields === '*') return { ok: true, columns: all };

  const matches = (col: ProfileColumn, field: string) =>
    col.header === field || col.path[0] === field;
  const unknown = fields.filter((f) => !all.some((c) => matches(c, f)));
  if (unknown.length > 0) return { ok: false, unknown };

  return { ok: true, columns: all.filter((c) => fields.some((f) => matches(c, f))) };
}

/** The value at `path` in `state`, or undefined when any segment is missing. */
export function valueAtPath(state: Record<string, unknown>, path: readonly string[]): unknown {
  let cur: unknown = state;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
