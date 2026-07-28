/**
 * Keys always scrubbed on retire (at ANY nesting depth), even when a network's
 * schema does not mark them `private:true`. The schema-driven private-field
 * removal covers the general case (PII is expected to be `private:true`); this
 * is a backstop for the standard profile identity fields named in #347 (Q9).
 */
const ALWAYS_SCRUB_KEYS = new Set([
  'name',
  'full_name',
  'email',
  'phone',
  'phone_number',
  'mobile',
  'mobile_number',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function schemaProperties(schema: unknown): Record<string, unknown> {
  return isPlainObject(schema) && isPlainObject(schema.properties) ? schema.properties : {};
}

function isPrivate(schema: unknown): boolean {
  return isPlainObject(schema) && schema.private === true;
}

/**
 * Recursively keep ONLY schema-declared, non-private, non-identity fields.
 * Drops (at every level): `private:true` fields, the identity keys above, and
 * any key not present in the schema's `properties` (unknown/extra data allowed
 * by `allow_extra_schema_data` must not survive an erasure).
 */
function scrub(schema: unknown, state: Record<string, unknown>): Record<string, unknown> {
  const props = schemaProperties(schema);
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(state)) {
    if (ALWAYS_SCRUB_KEYS.has(key)) continue;
    const propSchema = props[key];
    if (propSchema === undefined) continue; // unknown/extra key — drop
    if (isPrivate(propSchema)) continue; // private:true — drop

    // Nested object with its own properties → recurse.
    if (isPlainObject(propSchema) && isPlainObject(propSchema.items) === false && isPlainObject(value)) {
      out[key] = scrub(propSchema, value);
      continue;
    }

    // Array of objects → scrub each element against the item schema.
    if (isPlainObject(propSchema) && isPlainObject(propSchema.items) && Array.isArray(value)) {
      out[key] = value.map((entry) =>
        isPlainObject(entry) ? scrub(propSchema.items, entry) : entry,
      );
      continue;
    }

    out[key] = value;
  }

  return out;
}

/**
 * Build the PII-stripped `item_state` for a retired profile (#347, Q9).
 *
 * The stored `item_state` holds public fields plus MASKED placeholders for every
 * `private:true` field (real values live encrypted in `item_private_state`).
 * Retire keeps only schema-declared, non-private, non-identity fields (see
 * `scrub`) — dropping private fields, the identity keys at any nesting, and any
 * unknown/extra keys. The caller also clears `item_private_state` and
 * `item_locations`. Action-embedded data (requirements_snapshot /
 * event_payload) is handled separately via #392, not here.
 */
export function buildRetiredItemState(
  itemSchema: Record<string, unknown> | null | undefined,
  storedItemState: Record<string, unknown>,
): Record<string, unknown> {
  // Without a schema we can't tell public from private — fail safe: keep nothing
  // rather than risk leaking an unclassified PII field.
  if (!itemSchema) return {};
  return scrub(itemSchema, storedItemState);
}
