import { is_populated } from '../metrics/profile_completion.js';

export type LifecycleStatus = 'draft' | 'live' | 'paused';

export interface ClassifierInput {
  /**
   * The JSON schema for the item. Only `required` is read; pass any
   * superset (the full `Record<string, unknown>` from getOrFetchSchemaByUrl
   * is fine).
   */
  schema: ({ required?: string[] } & Record<string, unknown>) | null | undefined;
  merged_state: Record<string, unknown> | null | undefined;
  /**
   * Stored lifecycle_status BEFORE this write. `paused` is sticky — the
   * classifier never flips out of it. For brand-new items pass `'draft'`.
   */
  current_status: LifecycleStatus;
}

export interface ClassifierResult {
  lifecycle_status: LifecycleStatus;
  completion_pct: number;
}

/**
 * Pure synchronous classifier. Runs inside the item-write transaction over
 * the merged post-write state. See
 * docs/superpowers/specs/2026-06-03-participant-onboarding-lifecycle-design.md §5.
 *
 * - completion_pct: required-only (optional fields = 0 weight).
 * - lifecycle_status: paused is sticky; otherwise required_complete ? live : draft.
 */
export const classify_item = (input: ClassifierInput): ClassifierResult => {
  const required = input.schema?.required ?? [];
  const state = input.merged_state ?? {};

  if (required.length === 0) {
    return {
      lifecycle_status: input.current_status === 'paused' ? 'paused' : 'live',
      completion_pct: 100,
    };
  }

  const filled = required.filter((k) => is_populated(state[k]));
  const completion_pct = Math.round((filled.length / required.length) * 100);
  const required_complete = filled.length === required.length;

  if (input.current_status === 'paused') {
    return { lifecycle_status: 'paused', completion_pct };
  }
  return {
    lifecycle_status: required_complete ? 'live' : 'draft',
    completion_pct,
  };
};
