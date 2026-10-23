/**
 * Marker-driven URL fields.
 *
 *   "x-uri": true   — this field holds a URL. The UI renders its value as a
 *                     clickable link in profile/item cards, and both the form
 *                     and the API validate the value against URL_PATTERN.
 *
 * Valid on a string property, or on an array-of-strings property (the pattern
 * is then injected into `items`). Shared by the UI and the API so both enforce
 * identical rules.
 *
 * This module must stay dependency-free: the UI imports it through the deep
 * alias `@dpg/schemas/uri_fields`, because the `@dpg/schemas` barrel re-exports
 * DB-bound modules and breaks the browser build.
 */

type JsonRecord = Record<string, unknown>;

/** The `network.json` field-level marker. */
export const URI_FIELD_MARKER = 'x-uri' as const;

/**
 * The one URL rule, enforced by the profile form AND the API.
 *
 *  - The scheme is optional: `example.com` is accepted and stored as typed;
 *    the card prefixes `https://` when it builds the href. When present it is
 *    matched case-insensitively, as the render-side href builder is; the two
 *    must agree.
 *  - A query string or fragment may follow the host with no path in between:
 *    `example.com?q=1` and `example.com#top` are accepted.
 *  - Surrounding whitespace is tolerated (users paste with a trailing space);
 *    the href builder trims.
 *  - The empty string is accepted — presence is `required[]`'s job, not the
 *    pattern's. A required link field should also carry `minLength: 1`.
 *  - A host must contain a dot and end in letters, so `companyabc`,
 *    `http://localhost:3000` and bare IPs are rejected, as are non-http(s)
 *    schemes such as `javascript:` and `data:`.
 *
 * `pattern` is used rather than `format: "uri"`: `format` is ignored by the
 * API's ajv (no `ajv-formats` registered), and ajv's `uri` format would
 * reject the scheme-less input users type.
 */
export const URL_PATTERN = String.raw`^\s*$|^\s*([hH][tT][tT][pP][sS]?:\/\/)?([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(:\d{1,5})?([\/?#][^\s]*)?\s*$`;

function isPlainObject(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when a property schema carries the marker with the exact boolean `true`. */
export function isUriField(propSchema: unknown): boolean {
  return isPlainObject(propSchema) && propSchema[URI_FIELD_MARKER] === true;
}

/**
 * Return a copy of `schema` with `pattern: URL_PATTERN` injected on every
 * marked field that does not already define its own `pattern`. For a marked
 * array property the pattern goes on `items` (patterns apply to strings, not
 * arrays). Recurses through `properties` and `items` so nested objects are
 * covered. The marker is left in place: the UI's `normalizeSchemaForRjsf`
 * strips it, and the API's ajv runs with `strict: false`.
 */
export function applyUriPatterns<T>(schema: T): T {
  if (!isPlainObject(schema)) return schema;
  return transform(schema) as T;
}

function transform(node: JsonRecord): JsonRecord {
  const out: JsonRecord = { ...node };

  if (isPlainObject(node.properties)) {
    const props: JsonRecord = {};
    for (const [key, prop] of Object.entries(node.properties)) {
      props[key] = isPlainObject(prop) ? withPattern(transform(prop)) : prop;
    }
    out.properties = props;
  }

  if (isPlainObject(node.items)) {
    out.items = transform(node.items);
  }

  return out;
}

/** Apply the pattern to a single (already recursed) property schema. */
function withPattern(prop: JsonRecord): JsonRecord {
  if (!isUriField(prop)) return prop;

  if (prop.type === 'array') {
    if (!isPlainObject(prop.items) || prop.items.pattern !== undefined) return prop;
    return { ...prop, items: { ...prop.items, pattern: URL_PATTERN } };
  }

  if (prop.pattern !== undefined) return prop;
  return { ...prop, pattern: URL_PATTERN };
}

/**
 * The top-level property names carrying the marker, so the form can reword an
 * ajv `pattern` error on a link field.
 */
export function collectUriFieldKeys(schema: unknown): string[] {
  if (!isPlainObject(schema) || !isPlainObject(schema.properties)) return [];
  return Object.entries(schema.properties)
    .filter(([, prop]) => isUriField(prop))
    .map(([key]) => key);
}
