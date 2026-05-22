import { is_populated } from './profile_completion.js';

interface ActionableTagsSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, unknown>;
}

export interface ActionableTagsInput {
  payload: Record<string, unknown>;
  schema: ActionableTagsSchema;
  applications_total: number;
  applications_rejected: number;
  idle_days: number;
}

/**
 * Slugify a JSON Schema property key into a tag-safe identifier.
 *
 *   'Phone Number'        → 'phone_number'
 *   "Mother's Name"       → 'mother_s_name'
 *   'Service Looking For' → 'service_looking_for'
 *
 * Lowercase, runs of non-alphanumerics collapse to single `_`, no leading
 * or trailing `_`.
 */
const slugify = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/**
 * Combines schema-derived `missing_<required>` tags with hand-coded
 * business tags. Used by the recompute pass (Task 5) — output is upserted
 * into `participant_metrics.actionable_tags` for the aggregator dashboard.
 *
 * Order is stable for snapshot tests:
 *   1. missing_<required> tags in schema.required order
 *   2. all_applications_rejected (if applicable)
 *   3. no_recent_activity (if applicable)
 */
export const compute_actionable_tags = (i: ActionableTagsInput): string[] => {
  const tags: string[] = [];

  // 1. Schema-derived: missing_<required>
  for (const key of i.schema.required ?? []) {
    if (!is_populated(i.payload?.[key])) {
      tags.push(`missing_${slugify(key)}`);
    }
  }

  // 2. Business: all submitted applications were rejected
  if (i.applications_total > 0 && i.applications_rejected === i.applications_total) {
    tags.push('all_applications_rejected');
  }

  // 3. Business: idle for too long
  if (i.idle_days > 30) {
    tags.push('no_recent_activity');
  }

  return tags;
};
