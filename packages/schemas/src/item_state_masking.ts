type JsonRecord = Record<string, unknown>;

interface MaskingRule {
  test: (key: string, propSchema: JsonRecord) => boolean;
  apply: (value: string) => string;
}

function lastN(s: string, n: number): string {
  return s.length <= n ? s : s.slice(-n);
}

function format(propSchema: JsonRecord): string | undefined {
  const f = propSchema.format;
  return typeof f === 'string' ? f : undefined;
}

const MASKING_RULES: MaskingRule[] = [
  {
    // email: a***@domain
    test: (_k, p) => format(p) === 'email',
    apply: (v) => {
      const [local = '', domain = ''] = v.split('@');
      const head = local.charAt(0) || 'X';
      return `${head}***@${domain}`;
    },
  },
  {
    // phone / tel: +XX-XX-XXXX-X{last4}; preserve country code if present
    test: (_k, p) => format(p) === 'phone' || format(p) === 'tel',
    apply: (v) => {
      const digits = v.replace(/\D/g, '');
      const tail = lastN(digits, 4).padStart(4, 'X');
      // Extract country code: most are 1-2 digits, up to 3
      const plusIdx = v.indexOf('+');
      if (plusIdx === 0 && digits.length > 0) {
        // Use heuristic: country codes are usually 1-2 digits, default to 2 if enough digits
        const ccLength = digits.length > 10 ? 2 : Math.min(3, digits.length - 4);
        const cc = '+' + digits.slice(0, ccLength);
        return `${cc}-XX-XXXX-X${tail}`;
      }
      return `+XX-XX-XXXX-X${tail}`;
    },
  },
  {
    // date / date-time
    test: (_k, p) => format(p) === 'date' || format(p) === 'date-time',
    apply: () => 'XXXX-XX-XX',
  },
  {
    // uri / url: scheme://***
    test: (_k, p) => format(p) === 'uri' || format(p) === 'url',
    apply: (v) => {
      const m = /^([a-z][a-z0-9+.-]*):/i.exec(v);
      return `${m?.[1] ?? 'https'}://***`;
    },
  },
  {
    // dob / birth key
    test: (k) => /(^|_)(dob|birth)/i.test(k),
    apply: () => 'XXXX-XX-XX',
  },
  {
    // name-like keys: first letter + ***
    test: (k) => /(^|_)(name|first_name|last_name|full_name)$/i.test(k),
    apply: (v) => (v.length === 0 ? '' : `${v.charAt(0)}***`),
  },
  {
    // government ID: last 4 visible
    test: (k) => /(aadhaar|pan|ssn|national_id|passport)/i.test(k),
    apply: (v) => {
      const digits = v.replace(/\D/g, '');
      const tail = lastN(digits, 4);
      return 'X'.repeat(Math.max(v.length - tail.length, 0)) + tail;
    },
  },
];

function maskLeaf(key: string, propSchema: JsonRecord, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const str = typeof value === 'string' ? value : String(value);
  for (const rule of MASKING_RULES) {
    if (rule.test(key, propSchema)) return rule.apply(str);
  }
  // Fallback: length-preserving X.
  return 'X'.repeat(str.length);
}

function isPlainObject(input: unknown): input is JsonRecord {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function getProperties(schema: JsonRecord): Record<string, JsonRecord> {
  return isPlainObject(schema.properties)
    ? (schema.properties as Record<string, JsonRecord>)
    : {};
}

export function maskPrivateState(
  itemSchema: JsonRecord,
  privateState: JsonRecord
): JsonRecord {
  return maskObject(itemSchema, privateState);
}

function maskObject(schema: JsonRecord, state: JsonRecord): JsonRecord {
  const out: JsonRecord = {};
  const props = getProperties(schema);

  for (const [key, value] of Object.entries(state)) {
    const propSchema = props[key] ?? {};
    if (value === null || value === undefined) {
      out[key] = value;
      continue;
    }
    if (isPlainObject(propSchema) && isPlainObject(value)) {
      out[key] = maskObject(propSchema, value);
      continue;
    }
    if (isPlainObject(propSchema) && Array.isArray(value)) {
      const itemSchema = isPlainObject(propSchema.items) ? propSchema.items : null;
      out[key] = value.map((entry) => {
        if (isPlainObject(entry) && itemSchema) return maskObject(itemSchema, entry);
        if (entry === null || entry === undefined) return entry;
        return maskLeaf(key, propSchema, entry);
      });
      continue;
    }
    out[key] = maskLeaf(key, propSchema, value);
  }
  return out;
}
