import Ajv2020 from 'ajv/dist/2020.js';
import { z } from 'zod';

const JsonSchemaDocumentSchema = z.record(z.string(), z.unknown());

// Canonical bucket + status enums. Duplicated here from
// apps/api/src/services/metrics/buckets.ts because @dpg/schemas is upstream
// of apps/api — the package can't import down the tree. Both must be updated
// in lockstep if a bucket or status is added.
const CANONICAL_BUCKETS = ['create', 'accept', 'reject', 'cancel'] as const;
const CANONICAL_STATUSES = ['new', 'active', 'at_risk', 'inactive'] as const;
const CanonicalBucketSchema = z.enum(CANONICAL_BUCKETS);
const CanonicalStatusSchema = z.enum(CANONICAL_STATUSES);

const ComparisonSchema = z.union([
  z.object({ lt: z.number() }).strict(),
  z.object({ lte: z.number() }).strict(),
  z.object({ gt: z.number() }).strict(),
  z.object({ gte: z.number() }).strict(),
  z.object({ eq: z.number() }).strict(),
  z.object({ between: z.tuple([z.number(), z.number()]) }).strict(),
]);

const bucketsField = { buckets: z.array(CanonicalBucketSchema).min(1) };
const BucketScopedComparisonSchema = z.union([
  z.object({ ...bucketsField, lt:      z.number() }).strict(),
  z.object({ ...bucketsField, lte:     z.number() }).strict(),
  z.object({ ...bucketsField, gt:      z.number() }).strict(),
  z.object({ ...bucketsField, gte:     z.number() }).strict(),
  z.object({ ...bucketsField, eq:      z.number() }).strict(),
  z.object({ ...bucketsField, between: z.tuple([z.number(), z.number()]) }).strict(),
]);

const ItemAgePredicateSchema = z.object({ item_age_days: ComparisonSchema }).strict();
const DaysSinceLastPredicateSchema = z.object({ days_since_last: BucketScopedComparisonSchema }).strict();
const CountPredicateSchema = z.object({ count: BucketScopedComparisonSchema }).strict();

// Recursive predicate: leaf predicates + all/any combinators
type PredicateInput =
  | z.input<typeof ItemAgePredicateSchema>
  | z.input<typeof DaysSinceLastPredicateSchema>
  | z.input<typeof CountPredicateSchema>
  | { all: PredicateInput[] }
  | { any: PredicateInput[] };

const PredicateSchema: z.ZodType<PredicateInput> = z.lazy(() =>
  z.union([
    ItemAgePredicateSchema,
    DaysSinceLastPredicateSchema,
    CountPredicateSchema,
    z.object({ all: z.array(PredicateSchema).min(1) }).strict(),
    z.object({ any: z.array(PredicateSchema).min(1) }).strict(),
  ]),
);

const StatusRuleSchema = z.object({
  status: CanonicalStatusSchema,
  // Optional UI copy rendered on the aggregator dashboard status cards.
  label: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  when: z.union([PredicateSchema, z.literal('default')]),
}).strict();

const DashboardTileLabelsSchema = z.object({
  total_items: z.string().min(1).optional(),
  complete_profiles: z.string().min(1).optional(),
  has_applications: z.string().min(1).optional(),
}).strict();

const NetworkDomainSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  minimum_cache_ttl_seconds: z.number().int().positive().optional().default(300),
  item_schemas: z
    .record(z.string(), JsonSchemaDocumentSchema)
    .optional()
    .default({}),
  default_item_schemas: z
    .record(z.string(), JsonSchemaDocumentSchema)
    .optional()
    .default({}),
  status_rules: z.array(StatusRuleSchema).min(1),
  dashboard_tiles: DashboardTileLabelsSchema.optional(),
}).superRefine((domain, ctx) => {
  const last = domain.status_rules[domain.status_rules.length - 1];
  if (last.when !== 'default') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'status_rules must end with a `{ when: "default" }` tail rule',
      path: ['status_rules', domain.status_rules.length - 1, 'when'],
    });
  }
}).transform((domain) => ({
  ...domain,
  item_schemas: {
    ...domain.default_item_schemas,
    ...domain.item_schemas,
  },
}));

const NetworkInstanceSchema = z.object({
  domain_id: z.string().min(1),
  instance_name: z.string().optional(),
  instance_url: z.url(),
  schema_url: z.url().nullable().optional(),
  custom_item_schema_urls: z.record(z.string(), z.url()).optional().default({}),
}).transform((instance) => ({
  ...instance,
  custom_item_schema_urls: {
    ...(instance.schema_url ? { profile: instance.schema_url } : {}),
    ...instance.custom_item_schema_urls,
  },
}));

const MetricCategoriesSchema = z.object({
  create: z.array(z.string().min(1)).optional().default([]),
  accept: z.array(z.string().min(1)).optional().default([]),
  reject: z.array(z.string().min(1)).optional().default([]),
  cancel: z.array(z.string().min(1)).optional().default([]),
}).strict();

const ConsentTextSchema = z.string().trim().min(1).max(500);

export const NetworkActionInteractionSchema = z
  .object({
    from_network: z.string().min(1).optional(),
    from_domain: z.string().min(1),
    from_items: z.string().min(1).array().optional().default([]),
    to_network: z.string().min(1).optional(),
    to_domain: z.string().min(1),
    to_items: z.string().min(1).array().optional().default([]),
    requirement_schema: JsonSchemaDocumentSchema,
    event_schema: JsonSchemaDocumentSchema.optional(),
    metric_categories: MetricCategoriesSchema.nullable().optional(),
    reveals_pii_on_status: z.array(z.string().min(1)).optional().default([]),
    consent_text_initiator: ConsentTextSchema.optional(),
    consent_text_receiver: ConsentTextSchema.optional(),
  })
  .superRefine((interaction, ctx) => {
    if (interaction.reveals_pii_on_status.length === 0) return;

    if (!interaction.event_schema) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'reveals_pii_on_status requires event_schema with a status.enum to validate against',
        path: ['reveals_pii_on_status'],
      });
      return;
    }

    const statusEnum = extractStatusEnum(interaction.event_schema);
    if (!statusEnum) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'reveals_pii_on_status requires event_schema.properties.status.enum to be defined',
        path: ['reveals_pii_on_status'],
      });
      return;
    }

    for (const status of interaction.reveals_pii_on_status) {
      if (!statusEnum.includes(status)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `reveals_pii_on_status value "${status}" is not in event_schema.properties.status.enum`,
          path: ['reveals_pii_on_status'],
        });
      }
    }
  });

function extractStatusEnum(
  eventSchema: Record<string, unknown>
): string[] | null {
  const properties = eventSchema.properties;
  if (!properties || typeof properties !== 'object') return null;
  const status = (properties as Record<string, unknown>).status;
  if (!status || typeof status !== 'object') return null;
  const enumValues = (status as Record<string, unknown>).enum;
  if (!Array.isArray(enumValues)) return null;
  return enumValues.filter((v): v is string => typeof v === 'string');
}

const NetworkActionSchema = z.object({
  description: z.string().optional(),
  interactions: NetworkActionInteractionSchema.array().default([]),
});

const DashboardBucketsSchema = z.object({
  by_status: z.object({
    new: z.string().min(1).optional(),
    active: z.string().min(1).optional(),
    at_risk: z.string().min(1).optional(),
    inactive: z.string().min(1).optional(),
  }).strict().optional(),
  by_action_status: z.object({
    create: z.string().min(1).optional(),
    accept: z.string().min(1).optional(),
    reject: z.string().min(1).optional(),
    cancel: z.string().min(1).optional(),
  }).strict().optional(),
}).strict();

export const NetworkConfigSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().optional(),
  description: z.string().optional(),
  schema_standard: z.string().optional(),
  source_url: z.url().optional(),
  domains: NetworkDomainSchema.array().default([]),
  instances: NetworkInstanceSchema.array().default([]),
  cross_network_origins: z
    .object({
      id: z.string().min(1),
      display_name: z.string().optional(),
      schema_url: z.url(),
    })
    .array()
    .default([]),
  actions: z.record(z.string(), NetworkActionSchema).default({}),
  dashboard_buckets: DashboardBucketsSchema.optional(),
}).superRefine((cfg, ctx) => {
  for (const [domainIdx, domain] of cfg.domains.entries()) {
    for (const [schemaName, schemaDoc] of Object.entries(domain.item_schemas ?? {})) {
      const doc = schemaDoc as Record<string, unknown>;
      const field = doc.display_name_field;
      if (field === undefined) continue;
      if (typeof field !== 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `display_name_field must be a string`,
          path: ['domains', domainIdx, 'item_schemas', schemaName, 'display_name_field'],
        });
        continue;
      }
      const props = (doc.properties as Record<string, unknown> | undefined) ?? {};
      const target = props[field];
      if (!target || typeof target !== 'object') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `display_name_field "${field}" does not exist in properties`,
          path: ['domains', domainIdx, 'item_schemas', schemaName, 'display_name_field'],
        });
        continue;
      }
      const t = target as Record<string, unknown>;
      if (t.private === true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `display_name_field "${field}" points at a private property; pick a non-private field`,
          path: ['domains', domainIdx, 'item_schemas', schemaName, 'display_name_field'],
        });
      } else if (t.type !== 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `display_name_field "${field}" must point at a property of type "string"`,
          path: ['domains', domainIdx, 'item_schemas', schemaName, 'display_name_field'],
        });
      }
    }
  }
});

export type NetworkConfigDocument = z.infer<typeof NetworkConfigSchema>;
export type NetworkActionInteraction = z.infer<
  typeof NetworkActionInteractionSchema
>;

export function parseNetworkConfigDocument(
  input: unknown
): NetworkConfigDocument {
  return NetworkConfigSchema.parse(input);
}

export function getActionInteraction(
  networkConfig: NetworkConfigDocument,
  input: {
    actionType: string;
    fromNetwork: string;
    fromDomain: string;
    fromItemType?: string;
    toNetwork: string;
    toDomain: string;
    toItemType?: string;
  }
) {
  const action = networkConfig.actions[input.actionType];

  if (!action) {
    throw new Error(
      `Action "${input.actionType}" is not defined for network "${networkConfig.id}".`
    );
  }

  const interaction = action.interactions.find((entry) => {
    const fromNetwork = entry.from_network ?? networkConfig.id;
    const toNetwork = entry.to_network ?? networkConfig.id;

    return (
      fromNetwork === input.fromNetwork &&
      entry.from_domain === input.fromDomain &&
      matchesAllowedItemType(entry.from_items, input.fromItemType) &&
      toNetwork === input.toNetwork &&
      entry.to_domain === input.toDomain &&
      matchesAllowedItemType(entry.to_items, input.toItemType)
    );
  });

  if (!interaction) {
    throw new Error(
      `Action "${input.actionType}" is not allowed from "${input.fromNetwork}/${input.fromDomain}${formatItemType(input.fromItemType)}" to "${input.toNetwork}/${input.toDomain}${formatItemType(input.toItemType)}".`
    );
  }

  return interaction;
}

export function getInteractionPiiRevealStatuses(
  networkConfig: NetworkConfigDocument,
  input: {
    actionType: string;
    fromNetwork: string;
    fromDomain: string;
    fromItemType?: string;
    toNetwork: string;
    toDomain: string;
    toItemType?: string;
  }
): readonly string[] {
  const interaction = getActionInteraction(networkConfig, input);
  return interaction.reveals_pii_on_status;
}

function matchesAllowedItemType(
  allowedItemTypes: string[],
  itemType: string | undefined
) {
  return (
    allowedItemTypes.length === 0 ||
    Boolean(itemType && allowedItemTypes.includes(itemType))
  );
}

function formatItemType(itemType: string | undefined) {
  return itemType ? `/${itemType}` : '';
}

export function getDomainItemSchema(
  networkConfig: NetworkConfigDocument,
  domain: string,
  itemType: string
) {
  const domainConfig = networkConfig.domains.find(
    (entry) => entry.id === domain
  );

  if (!domainConfig) {
    throw new Error(
      `Domain "${domain}" is not defined for network "${networkConfig.id}".`
    );
  }

  const itemSchema = domainConfig.item_schemas[itemType];

  if (!itemSchema) {
    throw new Error(
      `Item type "${itemType}" is not defined for domain "${domain}" in network "${networkConfig.id}".`
    );
  }

  return itemSchema;
}

export function getDomainItemTypes(
  networkConfig: NetworkConfigDocument,
  domain: string
): string[] {
  const domainConfig = networkConfig.domains.find(
    (entry) => entry.id === domain
  );

  if (!domainConfig) {
    throw new Error(
      `Domain "${domain}" is not defined for network "${networkConfig.id}".`
    );
  }

  return Object.keys(domainConfig.item_schemas);
}

export function getDomainMinimumCacheTtlSeconds(
  networkConfig: NetworkConfigDocument,
  domain: string
): number {
  const domainConfig = networkConfig.domains.find(
    (entry) => entry.id === domain
  );

  if (!domainConfig) {
    throw new Error(
      `Domain "${domain}" is not defined for network "${networkConfig.id}".`
    );
  }

  return domainConfig.minimum_cache_ttl_seconds;
}

export function getInstanceCustomItemSchemaUrl(
  networkConfig: NetworkConfigDocument,
  input: {
    domain: string;
    instanceUrl: string;
    itemType: string;
  }
): string | null {
  const instanceConfig = networkConfig.instances.find(
    (entry) =>
      entry.domain_id === input.domain &&
      entry.instance_url === input.instanceUrl
  );

  if (!instanceConfig) {
    return null;
  }

  return (
    (instanceConfig.custom_item_schema_urls as Record<string, string>)[
      input.itemType
    ] ?? null
  );
}

export function validateAgainstJsonSchema(
  schema: Record<string, unknown>,
  payload: unknown,
  label: string,
  options: {
    allowAdditionalProperties?: boolean;
    ignoredKeys?: readonly string[];
  } = {}
) {
  const ignoredKeys = options.ignoredKeys ?? [];
  const schemaForValidation = options.allowAdditionalProperties
    ? allowAdditionalProperties(schema)
    : schema;
  const finalSchema =
    ignoredKeys.length > 0
      ? omitRequiredSchemaKeys(schemaForValidation, ignoredKeys)
      : schemaForValidation;
  const finalPayload =
    ignoredKeys.length > 0 ? omitObjectKeys(payload, ignoredKeys) : payload;

  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
  });

  const validate = ajv.compile(finalSchema);
  const valid = validate(finalPayload);

  if (valid) {
    return;
  }

  const message =
    validate.errors?.map((error) => error.message).filter(Boolean).join(', ') ||
    'unknown validation error';

  throw new Error(`Invalid ${label}: ${message}`);
}

function omitObjectKeys(input: unknown, ignoredKeys: readonly string[]) {
  if (!isPlainObject(input)) {
    return input;
  }

  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !ignoredKeys.includes(key))
  );
}

function omitRequiredSchemaKeys(
  schema: Record<string, unknown>,
  ignoredKeys: readonly string[]
): Record<string, unknown> {
  return rewriteJsonSchema(schema, (value) => {
    const required = value.required;

    if (!Array.isArray(required)) {
      return value;
    }

    return {
      ...value,
      required: required.filter(
        (entry) => typeof entry !== 'string' || !ignoredKeys.includes(entry)
      ),
    };
  });
}

function allowAdditionalProperties(
  schema: Record<string, unknown>
): Record<string, unknown> {
  return rewriteJsonSchema(schema, (value) => {
    const next = { ...value };

    if (next.additionalProperties === false) {
      next.additionalProperties = true;
    }

    if (next.unevaluatedProperties === false) {
      next.unevaluatedProperties = true;
    }

    return next;
  });
}

function rewriteJsonSchema(
  schema: Record<string, unknown>,
  rewriteObject: (value: Record<string, unknown>) => Record<string, unknown>
): Record<string, unknown> {
  return rewriteObject(
    Object.fromEntries(
      Object.entries(schema).map(([key, value]) => [
        key,
        rewriteJsonValue(value, rewriteObject),
      ])
    )
  );
}

function rewriteJsonValue(
  value: unknown,
  rewriteObject: (value: Record<string, unknown>) => Record<string, unknown>
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteJsonValue(entry, rewriteObject));
  }

  if (isPlainObject(value)) {
    return rewriteJsonSchema(value, rewriteObject);
  }

  return value;
}

function isPlainObject(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
