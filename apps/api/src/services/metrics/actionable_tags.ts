import { is_populated } from './profile_completion.js';

interface ActionableTagsSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, unknown>;
}

export interface ActionableTagsInput {
  payload: Record<string, unknown>;
  schema: ActionableTagsSchema;
}

const slugify = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/**
 * Schema-derived `missing_<required_field>` tags only.
 *
 * Network-specific business tags (`all_applications_rejected`,
 * `no_recent_activity`, `no_applications_yet`, `decisions_overdue`) are
 * removed — those names baked Jobs vocabulary into Signals. If a future
 * product need calls for business tags, add them via a config-driven
 * `tag_rules` array reusing the status-rule DSL.
 */
export const compute_actionable_tags = (i: ActionableTagsInput): string[] => {
  const tags: string[] = [];
  for (const key of i.schema.required ?? []) {
    if (!is_populated(i.payload?.[key])) {
      tags.push(`missing_${slugify(key)}`);
    }
  }
  return tags;
};
