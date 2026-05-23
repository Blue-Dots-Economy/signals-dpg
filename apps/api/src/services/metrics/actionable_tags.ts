import { is_populated } from './profile_completion.js';

interface ActionableTagsSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, unknown>;
}

export type ActionableDomain = 'seeker' | 'provider';

export interface ActionableTagsInput {
  domain: ActionableDomain;
  payload: Record<string, unknown>;
  schema: ActionableTagsSchema;
  applications_total: number;
  applications_rejected: number;
  /** For provider tag `no_applications_yet`; recompute passes 0 for seekers. */
  job_post_age_days: number;
  /** Seeker-only; null for providers. */
  last_applied_age_days: number | null;
  /** Provider-only; null for seekers. */
  min_decision_age_days: number | null;
}

const slugify = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/**
 * Schema-derived `missing_<required>` tags + domain-aware business tags.
 *
 * Seeker business tags:
 *   - `all_applications_rejected` when total > 0 AND rejected == total
 *   - `no_recent_activity` when last_applied_age_days > 30
 *
 * Provider business tags:
 *   - `no_applications_yet` when applications_total == 0 AND job_post_age_days > 7
 *   - `decisions_overdue` when min_decision_age_days > 30
 */
export const compute_actionable_tags = (i: ActionableTagsInput): string[] => {
  const tags: string[] = [];

  for (const key of i.schema.required ?? []) {
    if (!is_populated(i.payload?.[key])) {
      tags.push(`missing_${slugify(key)}`);
    }
  }

  if (i.domain === 'seeker') {
    if (i.applications_total > 0 && i.applications_rejected === i.applications_total) {
      tags.push('all_applications_rejected');
    }
    if (i.last_applied_age_days !== null && i.last_applied_age_days > 30) {
      tags.push('no_recent_activity');
    }
  } else {
    if (i.applications_total === 0 && i.job_post_age_days > 7) {
      tags.push('no_applications_yet');
    }
    if (i.min_decision_age_days !== null && i.min_decision_age_days > 30) {
      tags.push('decisions_overdue');
    }
  }

  return tags;
};
