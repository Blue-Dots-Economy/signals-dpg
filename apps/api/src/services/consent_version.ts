/**
 * Server-side resolver for the current consent document version.
 *
 * Version integers are never trusted from the client: every ledger write
 * derives the version here from the consent config for the
 * `(network, brand, category[, actionType, stage])` tuple, so a client cannot
 * record acceptance of a version the user never saw. Reads `consent_config`
 * entries from the network schema cache.
 *
 * @module apps/api/services/consent_version
 */
import { getConfiguredNetworkSchemas } from '@/network_schema_cache';

/** User-level + item-level document categories with a versioned document. */
export type ConsentDocumentCategory =
  | 'terms'
  | 'privacy'
  | 'profile_creation'
  | 'guardian_declaration';
/** Stage of an action-consent statement. */
export type ActionStage = 'initiate' | 'accept';

interface DocLike {
  current_version?: number;
}
interface ConsentConfigLike {
  documents?: Partial<Record<ConsentDocumentCategory, DocLike>>;
  u18_documents?: Partial<Record<ConsentDocumentCategory, DocLike>>;
  actions?: Record<string, Partial<Record<ActionStage, DocLike>>>;
}

/** Input tuple for {@link resolveConsentVersion}. */
export interface ResolveConsentVersionInput {
  /** Network id (e.g. `blue_dot`). */
  network: string;
  /** Optional brand variant; the network default is used when absent. */
  brand?: string | null;
  /** Document category, or `'action'` when resolving an action statement. */
  category: ConsentDocumentCategory | 'action';
  /** Action type (e.g. `connect`) — required when `category === 'action'`. */
  actionType?: string;
  /** Action stage — required when `category === 'action'`. */
  stage?: ActionStage;
  /** Which document set applies. Defaults to the adult set. */
  variant?: 'adult' | 'u18';
}

/**
 * Resolves the current version for a consent document, with the brand override
 * (when present) over the network default, as the UI merges them.
 *
 * @returns The `current_version` integer, or `null` when the tuple is not
 *   configured (the caller decides whether that is an error).
 */
export async function resolveConsentVersion(
  input: ResolveConsentVersionInput,
): Promise<number | null> {
  const schemas = await getConfiguredNetworkSchemas();
  const entries = schemas.filter(
    (e) => e.kind === 'consent_config' && e.network === input.network,
  );
  const def = entries.find((e) => !e.brand)?.schema as ConsentConfigLike | undefined;
  const brand = input.brand
    ? (entries.find((e) => e.brand === input.brand)?.schema as ConsentConfigLike | undefined)
    : undefined;

  if (input.category === 'action') {
    if (!input.actionType || !input.stage) return null;
    const v =
      brand?.actions?.[input.actionType]?.[input.stage]?.current_version ??
      def?.actions?.[input.actionType]?.[input.stage]?.current_version;
    return typeof v === 'number' ? v : null;
  }

  const variant = input.variant ?? 'adult';

  // guardian_declaration exists only in the U18 set.
  if (input.category === 'guardian_declaration' && variant !== 'u18') {
    return null;
  }

  const pick = (cfg: ConsentConfigLike | undefined) =>
    variant === 'u18' ? cfg?.u18_documents : cfg?.documents;

  const doc =
    pick(brand)?.[input.category] ?? pick(def)?.[input.category];
  return typeof doc?.current_version === 'number' ? doc.current_version : null;
}
