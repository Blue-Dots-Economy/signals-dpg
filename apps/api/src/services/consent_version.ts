/**
 * Server-side resolver for the CURRENT consent document version.
 *
 * Consent version integers are never trusted from the client. Every ledger
 * write derives the version here from the loaded consent config for the
 * `(network, brand, category[, actionType, stage])` tuple, so the recorded
 * version always matches what the config actually served — a client cannot
 * record acceptance of a version the user never saw. Reads the already-cached
 * `consent_config` entries (no per-request disk/network I/O).
 *
 * Belongs to `@dpg/api`.
 *
 * @module apps/api/services/consent_version
 */
import { getConfiguredNetworkSchemas } from '@/network_schema_cache';

/** User-level + item-level document categories with a versioned document. */
export type ConsentDocumentCategory = 'terms' | 'privacy' | 'profile_creation';
/** Stage of an action-consent statement. */
export type ActionStage = 'initiate' | 'accept';

interface DocLike {
  current_version?: number;
}
interface ConsentConfigLike {
  documents?: Partial<Record<ConsentDocumentCategory, DocLike>>;
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
}

/**
 * Resolves the current version for a consent document, applying the brand
 * override (when present) over the network default — mirroring how the UI
 * merges the two.
 *
 * @param input - Network, optional brand, category, and (for actions) type/stage.
 * @returns The `current_version` integer, or `null` when the tuple is not
 *   configured (caller decides whether that is a hard error).
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

  const doc = brand?.documents?.[input.category] ?? def?.documents?.[input.category];
  return typeof doc?.current_version === 'number' ? doc.current_version : null;
}
