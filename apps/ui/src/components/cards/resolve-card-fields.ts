import type { RJSFSchema } from '@rjsf/utils';
import type { DotCardConfig } from '@/engine/types';
import { isUriField } from '@dpg/schemas/uri_fields';
import { isFieldVisible } from '@/lib/show-if';

/**
 * A single resolved card row. `isEmpty` is true when the item has no value for
 * the field — default rows still render (with a `—` placeholder) so every card
 * for a domain shows identical rows; empty extra rows are dropped instead.
 */
export interface CardRow {
  key: string;
  label: string;
  value: unknown;
  type?: string;
  /** Field is flagged `"x-uri": true` in network.json — render as a hyperlink. */
  isUri: boolean;
  isEmpty: boolean;
}

export interface ResolvedCard {
  title: string;
  initials: string;
  subtitle?: string;
  /** Rows shown collapsed (network.json `default_fields`, or a fallback). */
  defaultRows: CardRow[];
  /** Remaining non-empty fields, revealed by "view more". */
  extraRows: CardRow[];
}

const HIDDEN_KEYS = new Set(['item_latitude', 'item_longitude', 'item_domain']);
const FALLBACK_DEFAULT_COUNT = 4;
const TITLE_CANDIDATES = ['name', 'full_name', 'title', 'provider_id', 'learner_id', 'student_id'];

function isHidden(key: string): boolean {
  return key.startsWith('_') || HIDDEN_KEYS.has(key);
}

/** Empty string, empty array and nullish are empty; boolean `false` is not. */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** camelCase / snake_case to a Title Cased phrase. A schema `title` wins over this. */
export function humaniseFieldKey(key: string): string {
  return key
    .replaceAll('_', ' ')
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .replaceAll(/\b\w/g, (c) => c.toUpperCase());
}

/** Human-readable value for a card row (arrays joined, booleans Yes/No). */
export function formatCardValue(value: unknown, type?: string): string {
  if (isEmptyValue(value)) return '—';
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item === null || item === undefined) return '—';
        if (typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          const named = obj.name ?? obj.title ?? obj.label ?? obj.credential_type ?? obj.type;
          return named != null ? String(named) : Object.values(obj).join(' · ');
        }
        return String(item);
      })
      .join(', ');
  }
  if (type === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

export function getInitials(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return '?';
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * A field whose `x-show-if` the item does not satisfy is not on the card, as
 * in the form. This also hides stale values: the API merges edits onto stored
 * state, so a field hidden later keeps its old value.
 */
function isShown(key: string, props: Record<string, RJSFSchema>, data: Record<string, unknown>): boolean {
  return !isHidden(key) && isFieldVisible((props[key] ?? {}) as Record<string, unknown>, data);
}

function schemaProperties(schema?: RJSFSchema | null): Record<string, RJSFSchema> {
  return (schema?.properties as Record<string, RJSFSchema> | undefined) ?? {};
}

function bestGuessTitleKey(
  props: Record<string, RJSFSchema>,
  data: Record<string, unknown>
): string | undefined {
  const propKeys = Object.keys(props);
  for (const candidate of TITLE_CANDIDATES) {
    if (candidate in props || candidate in data) return candidate;
  }
  return propKeys[0] ?? Object.keys(data).find((k) => !isHidden(k));
}

function stringValue(value: unknown): string | undefined {
  if (isEmptyValue(value)) return undefined;
  return String(value);
}

function makeRow(
  key: string,
  props: Record<string, RJSFSchema>,
  data: Record<string, unknown>
): CardRow {
  const prop = props[key];
  const value = data[key];
  return {
    key,
    label: prop?.title ?? humaniseFieldKey(key),
    value,
    type: prop?.type as string | undefined,
    isUri: isUriField(prop),
    isEmpty: isEmptyValue(value),
  };
}

/**
 * Turns an item's schema, data and `card` config into ItemCard rows. Never
 * throws, so any network's schemas render:
 *
 *  - `default_fields` keys absent from this schema are skipped.
 *  - A present but empty default field renders as `—`.
 *  - With no `card` config, or none of its fields resolving, the first few
 *    non-empty fields are used.
 */
export function resolveCardFields(
  schema: RJSFSchema | null | undefined,
  data: Record<string, unknown>,
  cardConfig?: DotCardConfig | null
): ResolvedCard {
  const props = schemaProperties(schema);
  const hasSchemaProps = Object.keys(props).length > 0;

  const titleKey = cardConfig?.title_field ?? bestGuessTitleKey(props, data);
  const title = (titleKey ? stringValue(data[titleKey]) : undefined) ?? 'Untitled';

  const avatarKey = cardConfig?.avatar_from ?? titleKey;
  const initials = getInitials((avatarKey ? stringValue(data[avatarKey]) : undefined) ?? title);

  const subtitle = cardConfig?.subtitle_field
    ? stringValue(data[cardConfig.subtitle_field])
    : undefined;

  const configured = (cardConfig?.default_fields ?? []).filter(
    (key) => key in props && isShown(key, props, data)
  );

  let defaultKeys = configured;
  if (defaultKeys.length === 0) {
    // Fallback: the first N shown, non-empty fields.
    const source = hasSchemaProps ? Object.keys(props) : Object.keys(data);
    defaultKeys = source
      .filter((key) => isShown(key, props, data) && !isEmptyValue(data[key]))
      .slice(0, FALLBACK_DEFAULT_COUNT);
  }

  const defaultSet = new Set(defaultKeys);

  // A configured `extra_fields` is the exhaustive, ordered extra list; otherwise
  // every remaining non-empty field, in schema order.
  let extraKeys: string[];
  if (cardConfig?.extra_fields && cardConfig.extra_fields.length > 0) {
    extraKeys = cardConfig.extra_fields.filter(
      (key) =>
        (key in props || key in data) &&
        isShown(key, props, data) &&
        !defaultSet.has(key) &&
        !isEmptyValue(data[key])
    );
  } else {
    const extraSource = hasSchemaProps ? Object.keys(props) : Object.keys(data);
    extraKeys = extraSource.filter(
      (key) => isShown(key, props, data) && !defaultSet.has(key) && !isEmptyValue(data[key])
    );
  }

  return {
    title,
    initials,
    subtitle,
    defaultRows: defaultKeys.map((key) => makeRow(key, props, data)),
    extraRows: extraKeys.map((key) => makeRow(key, props, data)),
  };
}
