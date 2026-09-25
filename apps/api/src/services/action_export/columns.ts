/**
 * Profile columns of an engagement export (#770), derived from the
 * counterparty item schema — never a hardcoded list, so a network's schema
 * change reaches the file without a deploy.
 */

export interface ProfileColumn {
  /** CSV header: the field key, nested objects as `parent.child`. */
  header: string;
  /** Path into item_state. */
  path: string[];
}

export type ProfileColumnsResult =
  | { ok: true; columns: ProfileColumn[] }
  | { ok: false; unknown: string[] };

type SchemaNode = { type?: unknown; properties?: Record<string, SchemaNode> };

function flatten(properties: Record<string, SchemaNode>, prefix: string[]): ProfileColumn[] {
  const out: ProfileColumn[] = [];
  for (const [key, node] of Object.entries(properties)) {
    const path = [...prefix, key];
    const nested = node?.properties;
    if (node?.type === 'object' && nested && Object.keys(nested).length > 0) {
      out.push(...flatten(nested, path));
    } else {
      out.push({ header: path.join('.'), path });
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
  const all = flatten((schema.properties as Record<string, SchemaNode>) ?? {}, []);
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
