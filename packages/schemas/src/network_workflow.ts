import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import { z } from 'zod';
import { applyUriPatterns, isUriField } from './uri_fields';

const JsonSchemaDocumentSchema = z.record(z.string(), z.unknown());

// Go-live gate tokens (not field names), shared by the config schema and the
// apps/api classifier. `schema_required` is the baseline; `consent_required`
// and `owner_required` are opt-in per domain, except that a guardian-gated
// domain always enforces `consent_required`.
// `owner_required` (the owner has an owning aggregator) is not a pure function
// of the item's state; see `GO_LIVE_GATE_CHECKS.owner_required` in apps/api.
export const PROFILE_GO_LIVE_GATES = [
  'schema_required',
  'consent_required',
  'owner_required',
] as const;
export type GoLiveGate = (typeof PROFILE_GO_LIVE_GATES)[number];

// Duplicated from apps/api/src/services/metrics/buckets.ts because this
// package cannot import from apps/api. Keep the two in sync.
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

// A dashboard tile names a precomputed rollup key (e.g. total_items,
// total_users) and its label; the aggregator reads the value, never computes it.
const DashboardTileSchema = z.object({
  field: z.string().min(1),
  label: z.string().min(1),
}).strict();
const DashboardTilesSchema = z.object({
  profile: z.array(DashboardTileSchema).optional(),
  user: z.array(DashboardTileSchema).optional(),
}).strict();

// Per-domain UI item card config: default fields, heading and avatar; other
// fields go behind "view more". Without it the UI guesses.
const CardConfigSchema = z.object({
  title_field: z.string().min(1).optional(),
  subtitle_field: z.string().min(1).optional(),
  avatar_from: z.string().min(1).optional(),
  default_fields: z.array(z.string().min(1)).optional().default([]),
  // Ordered, exhaustive list of fields shown behind "view more". When present,
  // only these appear as extra rows; any other schema field is omitted.
  extra_fields: z.array(z.string().min(1)).optional(),
}).strict();

/**
 * Maps canonical name/email/phone to the domain's item_state field names (e.g.
 * `mobile_number`), used by participant/decrypt field resolution. `name`
 * falls back to display_name_field / card.title_field when unset.
 */
const ContactFieldsSchema = z
  .object({
    // No `.min(1)`: an empty mapping must not fail the network parse; it
    // resolves to the account fallback like an absent one.
    name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
  })
  // `.strip()`, not `.strict()`: a typo'd key in any domain, served or not,
  // would otherwise fail the network-config parse and boot. A dropped key falls
  // back to the account value at resolve time with a `contact_map_missing` warn.
  .strip();

const NetworkDomainSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  // Display label for the domain (e.g. `provider` shown as "Service
  // Provider"), so the id can stay stable. Must be declared because Zod strips
  // unknown keys; the UI title-cases the id without it. Presentational only.
  label: z.string().min(1).optional(),
  // Overrides the sidebar "My Profile(s)" heading (e.g. "My Jobs").
  my_items_label: z.string().min(1).optional(),
  // "Why complete your profile" prompt on the profile create/edit page; the UI
  // falls back to a generic message. Presentational only.
  profile_completion_prompt: z
    .object({ heading: z.string().min(1), body: z.string().min(1) })
    .optional(),
  minimum_cache_ttl_seconds: z.number().int().positive().optional().default(300),
  // When true, minors' consent in this domain goes through a guardian.
  // Server-read only; never trusted from the client.
  guardian_consent_required: z.boolean().optional().default(false),
  // Gates a profile must clear to go `live` in this domain (see
  // `PROFILE_GO_LIVE_GATES`). Omitted means `schema_required`. An empty array
  // is rejected: a profile with no gates would go live instantly.
  go_live_required: z.array(z.enum(PROFILE_GO_LIVE_GATES)).min(1).optional(),
  // Per-domain cap on profiles one user may own; overrides MAX_PROFILES_PER_USER.
  max_profiles_per_user: z.number().int().positive().optional(),
  item_schemas: z
    .record(z.string(), JsonSchemaDocumentSchema)
    .optional()
    .default({}),
  default_item_schemas: z
    .record(z.string(), JsonSchemaDocumentSchema)
    .optional()
    .default({}),
  status_rules: z.array(StatusRuleSchema).min(1),
  dashboard_tiles: DashboardTilesSchema.optional(),
  card: CardConfigSchema.optional(),
  contact_fields: ContactFieldsSchema.optional(),
}).superRefine((domain, ctx) => {
  const last = domain.status_rules[domain.status_rules.length - 1];
  if (last.when !== 'default') {
    ctx.addIssue({
      code: 'custom',
      message: 'status_rules must end with a `{ when: "default" }` tail rule',
      path: ['status_rules', domain.status_rules.length - 1, 'when'],
    });
  }
  // The U18 guardian gate lives inside `consent_required`, so dropping it from a
  // guardian-gated domain would silently disable the age control.
  if (
    domain.guardian_consent_required &&
    domain.go_live_required &&
    !domain.go_live_required.includes('consent_required')
  ) {
    ctx.addIssue({
      code: 'custom',
      message:
        'a guardian_consent_required domain must keep "consent_required" in go_live_required',
      path: ['go_live_required'],
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
    // Bulk-export eligibility. Absent means not exportable (fail-closed).
    // `requester_domains` names which side(s) may export their counterparty; the
    // per-row reveal is still gated by `reveals_pii_on_status`.
    export: z
      .object({ requester_domains: z.array(z.string().min(1)).min(1) })
      .strict()
      .optional(),
    // Fields of each side's item shown to the other side in the My Actions
    // list: `from` lists fields of the from item, `to` of the to item. Private
    // or undeclared fields are dropped server-side, so this never shows
    // personal data before the reveal.
    column_fields: z
      .object({
        from: z.array(z.string().min(1)).optional().default([]),
        to: z.array(z.string().min(1)).optional().default([]),
      })
      .strict()
      .optional(),
  })
  .superRefine((interaction, ctx) => {
    // A requester must be a party to the interaction.
    for (const [idx, domain] of (interaction.export?.requester_domains ?? []).entries()) {
      if (domain === interaction.from_domain || domain === interaction.to_domain) continue;
      ctx.addIssue({
        code: 'custom',
        message: `export.requester_domains value "${domain}" is not a party to this interaction (from_domain "${interaction.from_domain}", to_domain "${interaction.to_domain}")`,
        path: ['export', 'requester_domains', idx],
      });
    }

    if (interaction.reveals_pii_on_status.length === 0) return;

    if (!interaction.event_schema) {
      ctx.addIssue({
        code: 'custom',
        message:
          'reveals_pii_on_status requires event_schema with a status.enum to validate against',
        path: ['reveals_pii_on_status'],
      });
      return;
    }

    const statusEnum = extractStatusEnum(interaction.event_schema);
    if (!statusEnum) {
      ctx.addIssue({
        code: 'custom',
        message:
          'reveals_pii_on_status requires event_schema.properties.status.enum to be defined',
        path: ['reveals_pii_on_status'],
      });
      return;
    }

    for (const status of interaction.reveals_pii_on_status) {
      if (!statusEnum.includes(status)) {
        ctx.addIssue({
          code: 'custom',
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

const ActionBucketLabelsSchema = z.object({
  create: z.string().min(1).optional(),
  accept: z.string().min(1).optional(),
  reject: z.string().min(1).optional(),
  cancel: z.string().min(1).optional(),
}).strict();

const DashboardBucketsSchema = z.object({
  by_status: z.object({
    new: z.string().min(1).optional(),
    active: z.string().min(1).optional(),
    at_risk: z.string().min(1).optional(),
    inactive: z.string().min(1).optional(),
  }).strict().optional(),
  by_initiated_action_status: ActionBucketLabelsSchema.optional(),
  by_received_action_status: ActionBucketLabelsSchema.optional(),
}).strict();

export const NetworkConfigSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().optional(),
  description: z.string().optional(),
  schema_standard: z.string().optional(),
  source_url: z.url().optional(),
  // When false, owners cannot pause profiles. Unpause stays allowed so a
  // profile paused earlier can still be recovered.
  pause_enabled: z.boolean().optional().default(true),
  // Max concurrent open actions between any two items, counted in both
  // directions and across action types.
  max_actions_per_pair: z.number().int().positive().optional().default(1),
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
          code: 'custom',
          message: `display_name_field must be a string`,
          path: ['domains', domainIdx, 'item_schemas', schemaName, 'display_name_field'],
        });
        continue;
      }
      const props = (doc.properties as Record<string, unknown> | undefined) ?? {};
      const target = props[field];
      if (!target || typeof target !== 'object') {
        ctx.addIssue({
          code: 'custom',
          message: `display_name_field "${field}" does not exist in properties`,
          path: ['domains', domainIdx, 'item_schemas', schemaName, 'display_name_field'],
        });
        continue;
      }
      const t = target as Record<string, unknown>;
      if (t.private === true) {
        ctx.addIssue({
          code: 'custom',
          message: `display_name_field "${field}" points at a private property; pick a non-private field`,
          path: ['domains', domainIdx, 'item_schemas', schemaName, 'display_name_field'],
        });
      } else if (t.type !== 'string') {
        ctx.addIssue({
          code: 'custom',
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

/** A directional edge (network/domain → network/domain) of an interaction. */
export interface MetricCategoryEdge {
  from_network: string;
  from_domain: string;
  to_network: string;
  to_domain: string;
}

/**
 * One asymmetry: a tracked interaction whose mirror-direction interaction
 * exists in the same action but is NOT tracked. The recompute pipeline
 * silently drops actions performed in the untracked direction (their
 * counts never reach item_metrics), so this is almost always a config bug.
 */
export interface MetricCategoryAsymmetry {
  action_type: string;
  tracked: MetricCategoryEdge;
  untracked: MetricCategoryEdge;
}

/**
 * An interaction is "tracked" iff its metric_categories is present AND at
 * least one canonical bucket has entries. Mirrors the runtime contract in
 * apps/api/.../metric_categories.ts (`normalize` returns null when empty),
 * so this lint matches exactly which interactions the recompute aggregates.
 */
function isMetricTracked(
  metric_categories: NetworkActionInteraction['metric_categories'],
): boolean {
  if (!metric_categories) return false;
  return CANONICAL_BUCKETS.some(
    (bucket) => (metric_categories[bucket]?.length ?? 0) > 0,
  );
}

const edgeOf = (
  networkId: string,
  interaction: NetworkActionInteraction,
): MetricCategoryEdge => ({
  from_network: interaction.from_network ?? networkId,
  from_domain: interaction.from_domain,
  to_network: interaction.to_network ?? networkId,
  to_domain: interaction.to_domain,
});

const isReverseEdge = (a: MetricCategoryEdge, b: MetricCategoryEdge): boolean =>
  a.from_network === b.to_network &&
  a.from_domain === b.to_domain &&
  a.to_network === b.from_network &&
  a.to_domain === b.from_domain;

/**
 * Detects metric_categories asymmetries: within a single action, a tracked
 * interaction whose reverse-direction interaction exists but is untracked.
 *
 * Returns one entry per offending (tracked, untracked) pair. An empty array
 * means every tracked interaction either has no reverse edge (one-directional
 * by design) or a reverse edge that is also tracked.
 */
export function findMetricCategoryAsymmetries(
  config: NetworkConfigDocument,
): MetricCategoryAsymmetry[] {
  const out: MetricCategoryAsymmetry[] = [];
  for (const [action_type, action] of Object.entries(config.actions)) {
    for (const tracked of action.interactions) {
      if (!isMetricTracked(tracked.metric_categories)) continue;
      const trackedEdge = edgeOf(config.id, tracked);

      for (const reverse of action.interactions) {
        if (reverse === tracked) continue;
        const reverseEdge = edgeOf(config.id, reverse);
        if (!isReverseEdge(trackedEdge, reverseEdge)) continue;
        if (isMetricTracked(reverse.metric_categories)) continue;
        out.push({
          action_type,
          tracked: trackedEdge,
          untracked: reverseEdge,
        });
      }
    }
  }
  return out;
}

export function parseNetworkConfigDocument(
  input: unknown
): NetworkConfigDocument {
  return NetworkConfigSchema.parse(input);
}

/** Which interaction of a network an action is: its type and both sides. */
export interface ActionInteractionInput {
  actionType: string;
  fromNetwork: string;
  fromDomain: string;
  fromItemType?: string;
  toNetwork: string;
  toDomain: string;
  toItemType?: string;
}

/** The sides of a stored `item_actions` row, as the interaction lookups read them. */
export interface ActionRowSides {
  action_type: string;
  source_item_network: string;
  source_item_domain: string;
  source_item_type: string;
  target_item_network: string;
  target_item_domain: string;
  target_item_type: string;
}

/** The interaction lookup input for a stored action row. */
export function interactionInputOf(row: ActionRowSides): ActionInteractionInput {
  return {
    actionType: row.action_type,
    fromNetwork: row.source_item_network,
    fromDomain: row.source_item_domain,
    fromItemType: row.source_item_type,
    toNetwork: row.target_item_network,
    toDomain: row.target_item_domain,
    toItemType: row.target_item_type,
  };
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

/**
 * Domains allowed to bulk-export the counterparty of this interaction's
 * actions. Empty when the interaction declares no `export` block.
 *
 * @throws Error when the network does not declare the interaction — same
 *   contract as {@link getInteractionPiiRevealStatuses}.
 */
export function getInteractionExportRequesterDomains(
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
  return interaction.export?.requester_domains ?? [];
}

/**
 * The counterparty fields to summarise for a viewer on one side of this
 * interaction: the viewer owning the `to` item sees `column_fields.from`, the
 * viewer owning the `from` item sees `column_fields.to`. Field names only —
 * the caller must still drop private/undeclared fields for the item's schema.
 *
 * @throws Error when the network does not declare the interaction — same
 *   contract as {@link getInteractionPiiRevealStatuses}.
 */
export function getInteractionColumnFields(
  networkConfig: NetworkConfigDocument,
  input: {
    actionType: string;
    fromNetwork: string;
    fromDomain: string;
    fromItemType?: string;
    toNetwork: string;
    toDomain: string;
    toItemType?: string;
  },
  counterpartySide: 'from' | 'to'
): readonly string[] {
  const interaction = getActionInteraction(networkConfig, input);
  return interaction.column_fields?.[counterpartySide] ?? [];
}

// Lives in a dependency-free module so the UI can import it too.
export {
  getExportableCounterparties,
  getExportableStatuses,
  type ExportableCounterparty,
} from './export_eligibility';

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

/**
 * A payload that failed its JSON Schema, with one readable message per field.
 *
 * `message` has the shape `Invalid <label>: field: msg, …`. `fields` holds the
 * same information keyed by field path, for pointing at the offending input.
 */
export class JsonSchemaValidationError extends Error {
  readonly fields: Record<string, string>;
  constructor(label: string, fields: Record<string, string>, rootMessages: string[]) {
    const parts = [
      ...Object.entries(fields).map(([field, msg]) => `${field}: ${msg}`),
      ...rootMessages,
    ];
    super(`Invalid ${label}: ${parts.join(', ') || 'unknown validation error'}`);
    this.name = 'JsonSchemaValidationError';
    this.fields = fields;
  }
}

/** Per-field copy for a failed `pattern`, authored in network.json (mirrors the UI marker). */
const FIELD_ERROR_MESSAGE_MARKER = 'x-error-message';

/** `/address/city` → `address.city`; array indices stay as segments (`tags.0`). */
function toFieldPath(instancePath: string, child?: string): string {
  const segments = instancePath.split('/').filter(Boolean);
  if (child) segments.push(child);
  return segments.join('.');
}

/**
 * One ajv error → `[field, message]`, worded the way the profile form words it
 * (apps/ui/src/components/forms/field-error-message.ts). A failed `pattern`
 * never surfaces the raw regex: the field's `x-error-message` wins, then the
 * URL copy for an `x-uri` field, then a generic naming the field.
 */
function describeAjvError(error: ErrorObject): [string, string] {
  const params = error.params as Record<string, unknown>;
  const parent = (error.parentSchema ?? {}) as Record<string, unknown>;
  switch (error.keyword) {
    case 'required':
      return [toFieldPath(error.instancePath, String(params.missingProperty)), 'is required'];
    case 'additionalProperties':
      return [
        toFieldPath(error.instancePath, String(params.additionalProperty)),
        'is not an allowed field',
      ];
    case 'unevaluatedProperties':
      return [
        toFieldPath(error.instancePath, String(params.unevaluatedProperty)),
        'is not an allowed field',
      ];
    case 'minLength':
      // `minLength: 1` is how a schema says "required and not blank".
      if (params.limit === 1) return [toFieldPath(error.instancePath), 'is required'];
      return [toFieldPath(error.instancePath), error.message ?? 'is invalid'];
    case 'enum': {
      const allowed = Array.isArray(params.allowedValues) ? params.allowedValues : [];
      const shown = allowed.slice(0, 10).map(String).join(', ');
      return [
        toFieldPath(error.instancePath),
        `must be one of: ${shown}${allowed.length > 10 ? ', …' : ''}`,
      ];
    }
    case 'pattern': {
      const authored = parent[FIELD_ERROR_MESSAGE_MARKER];
      if (typeof authored === 'string' && authored.trim()) {
        return [toFieldPath(error.instancePath), authored];
      }
      if (isUriField(parent)) {
        return [toFieldPath(error.instancePath), 'Please enter a valid web address.'];
      }
      const title = typeof parent.title === 'string' && parent.title.trim() ? parent.title : 'value';
      return [toFieldPath(error.instancePath), `Please enter a valid ${title}.`];
    }
    default:
      return [toFieldPath(error.instancePath), error.message ?? 'is invalid'];
  }
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
  // `x-uri` fields get the shared URL `pattern` (the same one the profile form
  // uses). `format` would be ignored: this ajv registers no `ajv-formats`.
  const schemaWithUriPatterns = applyUriPatterns(schema);
  const schemaForValidation = options.allowAdditionalProperties
    ? allowAdditionalProperties(schemaWithUriPatterns)
    : schemaWithUriPatterns;
  const finalSchema =
    ignoredKeys.length > 0
      ? relaxIgnoredProperties(omitRequiredSchemaKeys(schemaForValidation, ignoredKeys), ignoredKeys)
      : schemaForValidation;
  // Ignored keys stay in the payload so an `if` condition can read them; their
  // own property schemas are relaxed to `{}`, so the values are not validated.
  const finalPayload = payload;

  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    // Puts each failing keyword's own schema on the error (`parentSchema`), so a
    // failed pattern can use the field's `x-error-message` instead of the regex.
    verbose: true,
  });

  const validate = ajv.compile(finalSchema);
  const valid = validate(finalPayload);

  if (valid) {
    return;
  }

  // Keep the first message per field; allErrors can report a field more than
  // once. Root-level errors are kept as plain messages.
  const fields: Record<string, string> = {};
  const rootMessages: string[] = [];
  for (const error of validate.errors ?? []) {
    // An `if` error only summarises its branch ("must match \"then\" schema");
    // the branch's own errors are already in the list and name their fields.
    if (error.keyword === 'if') continue;
    const [field, message] = describeAjvError(error);
    if (!field) {
      if (!rootMessages.includes(message)) rootMessages.push(message);
    } else if (!(field in fields)) {
      fields[field] = message;
    }
  }

  throw new JsonSchemaValidationError(label, fields, rootMessages);
}

/** JSON Schema keyword whose subtree `omitRequiredSchemaKeys` leaves untouched. */
const IF_KEYWORD = new Set(['if']);

/**
 * Replaces each ignored key's own top-level property schema with `{}` (accept
 * anything), keeping the key declared so `additionalProperties: false` still
 * allows it.
 */
function relaxIgnoredProperties(
  schema: Record<string, unknown>,
  ignoredKeys: readonly string[]
): Record<string, unknown> {
  const properties = schema.properties;
  if (!isPlainObject(properties)) return schema;
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, ignoredKeys.includes(key) ? {} : value])
    ),
  };
}

/**
 * Drops `ignoredKeys` from every `required` list except inside an `if`
 * subschema, where `required` is part of a test; stripping it there would make
 * the test vacuously true and apply its `then` to every payload.
 */
function omitRequiredSchemaKeys(
  schema: Record<string, unknown>,
  ignoredKeys: readonly string[]
): Record<string, unknown> {
  return rewriteJsonSchema(schema, IF_KEYWORD, (value) => {
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
  return rewriteJsonSchema(schema, NO_SKIP, (value) => {
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

/**
 * Rewrites every object in a schema, bottom-up. Subtrees under a key in
 * `skipKeys` are copied unchanged (used to leave `if` conditions alone).
 */
function rewriteJsonSchema(
  schema: Record<string, unknown>,
  skipKeys: ReadonlySet<string>,
  rewriteObject: (value: Record<string, unknown>) => Record<string, unknown>
): Record<string, unknown> {
  return rewriteObject(
    Object.fromEntries(
      Object.entries(schema).map(([key, value]) => [
        key,
        skipKeys.has(key) ? value : rewriteJsonValue(value, skipKeys, rewriteObject),
      ])
    )
  );
}

function rewriteJsonValue(
  value: unknown,
  skipKeys: ReadonlySet<string>,
  rewriteObject: (value: Record<string, unknown>) => Record<string, unknown>
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteJsonValue(entry, skipKeys, rewriteObject));
  }

  if (isPlainObject(value)) {
    return rewriteJsonSchema(value, skipKeys, rewriteObject);
  }

  return value;
}

const NO_SKIP: ReadonlySet<string> = new Set();

function isPlainObject(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
