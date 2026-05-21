import type { RJSFSchema } from '@rjsf/utils';
import { filterDataBySchema } from '@/engine/schema/schema-privacy';

interface CardFieldProps {
  label: string;
  value: unknown;
  type?: string;
}

function CardField({ label, value, type }: CardFieldProps) {
  let displayValue: string;

  if (Array.isArray(value)) {
    displayValue = value
      .map((item) => {
        if (item === null || item === undefined) return '—';
        if (typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          const nameField = obj.name ?? obj.title ?? obj.label ?? obj.credential_type ?? obj.type;
          return nameField != null ? String(nameField) : Object.values(obj).join(' · ');
        }
        return String(item);
      })
      .join(', ');
  } else if (type === 'boolean') {
    displayValue = value ? 'Yes' : 'No';
  } else {
    displayValue = String(value);
  }

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium">{displayValue}</span>
    </div>
  );
}

interface CardFieldsFromSchemaProps {
  schema: RJSFSchema;
  data: Record<string, unknown>;
}

/**
 * `isEmptyValue` decides which fields the card hides.
 *
 * The browse card has no obligation to advertise what a user did NOT fill —
 * empty rows just add visual noise and break the grid. Boolean false stays
 * visible because "Open to remote: No" is meaningful information; treating
 * it the same as null would hide a legitimate user answer.
 */
function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Fallback label when a property has no `title` in the schema. Splits
 * camelCase and snake_case into a single space-separated, title-cased
 * phrase — `workExperienceYearsConditional` becomes
 * "Work Experience Years Conditional", `preferred_city` becomes
 * "Preferred City". Schemas with proper `title` fields always win.
 */
function humaniseFieldKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function CardFieldsFromSchema({
  schema,
  data,
}: CardFieldsFromSchemaProps) {
  const publicSchema = {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(schema.properties ?? {}).filter(([_, prop]) => {
        const typed = prop as RJSFSchema & { private?: boolean };
        return typed.private !== true;
      })
    ),
  };

  const publicData = filterDataBySchema(data, publicSchema);

  return (
    <div className="grid grid-cols-2 gap-3">
      {Object.entries(publicSchema.properties ?? {}).flatMap(([key, prop]) => {
        const typed = prop as RJSFSchema;
        const value = publicData[key];
        if (isEmptyValue(value)) return [];
        const label = typed.title ?? humaniseFieldKey(key);
        return [
          <CardField
            key={key}
            label={label}
            value={value}
            type={typed.type as string}
          />,
        ];
      })}
    </div>
  );
}
