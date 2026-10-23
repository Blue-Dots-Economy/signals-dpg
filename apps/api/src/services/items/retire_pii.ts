/**
 * Identity keys scrubbed on retire at any nesting depth, even when the schema
 * does not mark them `private:true`. A backstop for the schema-driven removal.
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
 * Recursively keep only schema-declared, non-private, non-identity fields.
 * Undeclared keys (allowed in by `allow_extra_schema_data`) are dropped too, so
 * they cannot survive an erasure.
 */
function scrub(schema: unknown, state: Record<string, unknown>): Record<string, unknown> {
  const props = schemaProperties(schema);
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(state)) {
    if (ALWAYS_SCRUB_KEYS.has(key)) continue;
    const propSchema = props[key];
    if (propSchema === undefined) continue;
    if (isPrivate(propSchema)) continue;

    if (isPlainObject(propSchema) && isPlainObject(propSchema.items) === false && isPlainObject(value)) {
      out[key] = scrub(propSchema, value);
      continue;
    }

    // Array of objects: scrub each element against the `items` schema.
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
 * Build the PII-stripped `item_state` for a retired profile. The stored state
 * holds public fields plus masked placeholders for private ones; only
 * schema-declared, non-private, non-identity fields are kept. The caller also
 * clears `item_private_state` and `item_locations`. Action-embedded data
 * (requirements_snapshot / event_payload) is not handled here.
 */
export function buildRetiredItemState(
  itemSchema: Record<string, unknown> | null | undefined,
  storedItemState: Record<string, unknown>,
): Record<string, unknown> {
  // Without a schema public and private are indistinguishable, so keep nothing.
  if (!itemSchema) return {};
  return scrub(itemSchema, storedItemState);
}
