import Ajv2020 from 'ajv/dist/2020.js';
import { z } from 'zod';

const JsonSchemaDocumentSchema = z.record(z.string(), z.unknown());

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

const NetworkActionInteractionSchema = z.object({
  from_network: z.string().min(1).optional(),
  from_domain: z.string().min(1),
  from_items: z.string().min(1).array().optional().default([]),
  to_network: z.string().min(1).optional(),
  to_domain: z.string().min(1),
  to_items: z.string().min(1).array().optional().default([]),
  requirement_schema: JsonSchemaDocumentSchema,
  event_schema: JsonSchemaDocumentSchema.optional(),
});

const NetworkActionSchema = z.object({
  description: z.string().optional(),
  interactions: NetworkActionInteractionSchema.array().default([]),
});

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
