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

/** Trimmed by index rather than /^_+|_+$/g, which backtracks quadratically on a long run. */
const trimUnderscores = (s: string): string => {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === '_') start++;
  while (end > start && s[end - 1] === '_') end--;
  return s.slice(start, end);
};

const slugify = (s: string): string =>
  trimUnderscores(s.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, '_'));

/**
 * Schema-derived `missing_<required_field>` tags only. Network-specific
 * business tags do not belong here; they would need config-driven rules so no
 * network's vocabulary is baked into Signals.
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
