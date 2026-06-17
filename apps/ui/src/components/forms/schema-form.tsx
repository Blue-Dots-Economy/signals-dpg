import * as React from 'react';
import Form from '@rjsf/shadcn';
import validator from '@rjsf/validator-ajv8';
import type { RJSFSchema, UiSchema, RegistryWidgetsType, ObjectFieldTemplateProps } from '@rjsf/utils';
import { DatePickerWidget } from './custom-widgets/date-picker-widget';
import { LocationAutocompleteWidget } from './custom-widgets/location-autocomplete-widget';
import { MultiLocationAutocompleteWidget } from './custom-widgets/multi-location-autocomplete-widget';
import { formLayouts } from '@/theme/form-layouts';
import { resolveVisibleSchema } from '@/lib/show-if';

interface RjsfError {
  property?: string;
  name?: string;
  params?: { missingProperty?: string };
}

/**
 * Map an RJSF validation error to the DOM id RJSF assigns the offending field.
 * RJSF defaults to idPrefix "root" + idSeparator "_", so a property like
 * ".trip_window_start" becomes "root_trip_window_start" and ".items.0.name"
 * becomes "root_items_0_name". (RJSF v6 already points `property` at the field
 * for `required` errors, so no special-casing is needed.)
 */
function fieldIdFromError(error: RjsfError): string {
  const segments = (error.property ?? '')
    .replace(/\[(\w+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  return ['root', ...segments].join('_');
}

/**
 * `focusOnFirstError` handler: on a blocked submit RJSF passes us the first
 * error; we smooth-scroll its field to the centre of the viewport and focus it,
 * so the user is taken to the problem instead of nothing happening. Resolution
 * mirrors RJSF's own (exact id, then a prefix match) because some shadcn widgets
 * put the field id on a wrapping button rather than a native input.
 */
function focusErrorField(container: HTMLElement | null, error: RjsfError): void {
  if (!container) return;
  const elementId = fieldIdFromError(error);
  const form = container.querySelector('form');

  // Resolve like RJSF does: the form's elements collection matches by id OR
  // name, with a prefix fallback for widgets (e.g. shadcn radios/selects) that
  // put the id on a wrapping button rather than a native input.
  const named = form?.elements.namedItem(elementId) ?? null;
  let candidate: Element | null =
    named instanceof RadioNodeList ? (named.item(0) as Element | null) : named;
  if (!candidate) {
    try {
      candidate = container.querySelector(`#${CSS.escape(elementId)}`);
    } catch {
      candidate = null;
    }
  }
  if (!candidate) {
    candidate = container.querySelector(
      `input[id^="${elementId}"], button[id^="${elementId}"], [id^="${elementId}"]`
    );
  }
  if (!(candidate instanceof HTMLElement)) return;
  const field = candidate;

  field.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const focusable = field.matches('input, select, textarea, button, [tabindex]')
    ? field
    : field.querySelector<HTMLElement>('input, select, textarea, button, [tabindex]');
  (focusable ?? field).focus({ preventScroll: true });
}

interface SchemaFormProps {
  schema: RJSFSchema;
  formData?: Record<string, unknown>;
  onSubmit: (data: Record<string, unknown>) => void;
  onError?: (errors: unknown[]) => void;
  mode?: 'full' | 'compact';
  disabled?: boolean;
  className?: string;
  submitButtonText?: string;
  id?: string;
  hideSubmit?: boolean;
  domainId?: string;
  formContext?: Record<string, unknown>;
}

// Root-only ObjectFieldTemplate that renders section headers + two-column grid.
// For nested objects (non-root) it falls back to the default RJSF column layout.
function SectionedObjectFieldTemplate(domainId: string) {
  const layout = formLayouts[domainId];

  return function ObjectFieldTemplate(props: ObjectFieldTemplateProps) {
    if (!layout) {
      // No layout config — render properties in a simple column
      return (
        <div className="space-y-4">
          {props.properties.map((element) => (
            <div key={element.name}>{element.content}</div>
          ))}
        </div>
      );
    }

    // Build a lookup of name → element
    const elementMap = new Map(props.properties.map((el) => [el.name, el]));
    const rendered = new Set<string>();

    // Track which section is being rendered so we can number them and show
    // the divider only between sections (not above the first one).
    let visibleSectionIndex = 0;

    return (
      <div className="space-y-10">
        {layout.sections.map((section) => {
          const sectionElements = section.fields
            .map((f) => elementMap.get(f))
            .filter((el): el is NonNullable<typeof el> => !!el);

          if (sectionElements.length === 0) return null;

          // Group into rows: pairs from twoColumn list go side-by-side, rest go full-width
          const rows: Array<typeof sectionElements> = [];
          let i = 0;
          while (i < sectionElements.length) {
            const curr = sectionElements[i];
            const next = sectionElements[i + 1];
            const currIsTwo = layout.twoColumn.includes(curr.name);
            const nextIsTwo = next && layout.twoColumn.includes(next.name);
            if (currIsTwo && nextIsTwo) {
              rows.push([curr, next]);
              i += 2;
            } else {
              rows.push([curr]);
              i += 1;
            }
            rendered.add(curr.name);
            if (next && currIsTwo && nextIsTwo) rendered.add(next.name);
          }

          const sectionNum = ++visibleSectionIndex;

          return (
            <section key={section.title}>
              {/* Section header: numbered badge + title + accent bar + divider line below */}
              <div className="mb-5">
                <div className="flex items-center gap-3">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-xs font-bold text-primary">
                    {sectionNum}
                  </div>
                  <h3 className="text-base font-semibold text-foreground tracking-tight">{section.title}</h3>
                </div>
                <div className="mt-3 h-px bg-gradient-to-r from-border via-border/60 to-transparent" />
              </div>
              <div className="space-y-3">
                {rows.map((row, ri) =>
                  row.length === 2 ? (
                    <div key={ri} className="grid grid-cols-2 gap-3">
                      {row.map((el) => <div key={el.name}>{el.content}</div>)}
                    </div>
                  ) : (
                    <div key={ri}>{row[0].content}</div>
                  )
                )}
              </div>
            </section>
          );
        })}

        {/* Render any fields not covered by sections */}
        {props.properties
          .filter((el) => !rendered.has(el.name))
          .map((el) => (
            <div key={el.name}>{el.content}</div>
          ))}
      </div>
    );
  };
}

// Walks a local JSON pointer like "#/$defs/support_category" against the
// root schema. Returns the referenced subschema or undefined if not found.
function resolveLocalRef(schema: RJSFSchema, ref: string): RJSFSchema | undefined {
  if (!ref.startsWith('#/')) return undefined;
  const parts = ref.slice(2).split('/');
  let curr: unknown = schema;
  for (const p of parts) {
    if (curr && typeof curr === 'object' && p in (curr as Record<string, unknown>)) {
      curr = (curr as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return curr as RJSFSchema;
}

function generateUiSchema(
  schema: RJSFSchema,
  mode: 'full' | 'compact',
  submitButtonText?: string
): UiSchema {
  const uiSchema: Record<string, unknown> = {};

  // Suppress the JSON-Schema-supplied root title/description. Surrounding
  // page chrome (CardTitle / CardDescription) already announces the form;
  // the inline duplicate adds noise. Section headers come from SectionedObjectFieldTemplate.
  uiSchema['ui:title'] = '';
  uiSchema['ui:description'] = '';

  uiSchema['ui:submitButtonOptions'] = {
    ...(submitButtonText ? { submitText: submitButtonText } : {}),
    props: {
      className: 'mt-8 h-12 w-full text-base font-semibold bg-brand-cta hover:brightness-110 transition-all active:scale-95 shadow-md',
    },
  };

  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const typed = prop as RJSFSchema & { private?: boolean; format?: string };

    if (mode === 'compact' && typed.private === true) {
      uiSchema[key] = { 'ui:widget': 'hidden' };
      continue;
    }

    if (typed.format === 'date') {
      uiSchema[key] = { 'ui:widget': 'date' };
    }

    if (typed.format === 'email') {
      uiSchema[key] = { 'ui:placeholder': 'email@example.com' };
    }

    if (typed.enum && typed.type === 'string') {
      uiSchema[key] = { 'ui:placeholder': 'Select...' };
    }

    // Render array-of-enums as a single multi-select (FancyMultiSelect:
    // Popover + cmdk Command + Badge chips) instead of RJSF's default stack
    // of single-selects with up/down/delete buttons per index.
    if (typed.type === 'array' && typed.items) {
      const items = typed.items as RJSFSchema & { $ref?: string };
      let itemEnum = items.enum;
      if (!itemEnum && items.$ref) {
        itemEnum = resolveLocalRef(schema, items.$ref)?.enum;
      }
      if (itemEnum && itemEnum.length > 0) {
        uiSchema[key] = {
          ...(uiSchema[key] as object),
          'ui:widget': 'select',
          'ui:placeholder': 'Select...',
        };
      }
    }

    const locationRole = (typed as { location?: unknown }).location;
    if (locationRole === 'primary' || locationRole === 'secondary') {
      const isArray = typed.type === 'array';
      const existing = (uiSchema[key] as Record<string, unknown>) ?? {};
      const existingOptions = (existing['ui:options'] as Record<string, unknown>) ?? {};
      uiSchema[key] = {
        ...existing,
        'ui:widget': isArray ? 'location-multi' : 'location-autocomplete',
        // Only the primary field's picked coordinate feeds item_locations;
        // secondary fields are autocomplete-only.
        'ui:options': { ...existingOptions, isPrimaryLocation: locationRole === 'primary' },
      };
    }
  }

  return uiSchema;
}

const widgets: RegistryWidgetsType = {
  date: DatePickerWidget,
  'location-autocomplete': LocationAutocompleteWidget,
  'location-multi': MultiLocationAutocompleteWidget,
};

function stripMetaSchema(schema: RJSFSchema): RJSFSchema {
  const { $schema, ...rest } = schema as RJSFSchema & { $schema?: string };
  return rest as RJSFSchema;
}

// Walks the schema tree, replacing local `{ $ref: "#/..." }` nodes with the
// referenced subschema and ensuring array-of-enum fields have `uniqueItems:
// true`. RJSF's `multiple=true` (which routes SelectWidget to FancyMultiSelect)
// requires the items enum to be visible at the field level AND uniqueItems
// set — without these, an `ui:widget: 'select'` array renders as a non-functional
// single-select with no options.
function normalizeSchemaForRjsf(schema: RJSFSchema, rootSchema?: RJSFSchema): RJSFSchema {
  const root = rootSchema ?? schema;
  if (typeof schema !== 'object' || schema === null) return schema;
  if (Array.isArray(schema)) {
    return (schema as unknown[]).map((s) => normalizeSchemaForRjsf(s as RJSFSchema, root)) as unknown as RJSFSchema;
  }

  const schemaAny = schema as RJSFSchema & { $ref?: string };
  if (typeof schemaAny.$ref === 'string' && schemaAny.$ref.startsWith('#/')) {
    const resolved = resolveLocalRef(root, schemaAny.$ref);
    if (resolved) {
      const { $ref: _, ...rest } = schemaAny;
      return normalizeSchemaForRjsf({ ...resolved, ...rest } as RJSFSchema, root);
    }
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    // Strip the custom `location` MARKER (value "primary" | "secondary"), which is consumed
    // by generateUiSchema, not real JSON Schema. Must NOT strip a property whose
    // NAME is "location" (its value is the field's schema object, not a string).
    if (key === 'location' && (value === 'primary' || value === 'secondary')) continue;
    // Strip the custom `x-show-if` keyword — consumed by resolveVisibleSchema before
    // this point; ajv must never see it.
    if (key === 'x-show-if') continue;
    result[key] = normalizeSchemaForRjsf(value as RJSFSchema, root);
  }

  // After children are normalized, force uniqueItems on array-of-enum fields.
  const normalized = result as RJSFSchema & { type?: string; items?: RJSFSchema; uniqueItems?: boolean };
  if (
    normalized.type === 'array' &&
    normalized.items &&
    typeof normalized.items === 'object' &&
    Array.isArray((normalized.items as RJSFSchema).enum) &&
    normalized.uniqueItems !== true
  ) {
    normalized.uniqueItems = true;
  }

  return normalized as RJSFSchema;
}

export function SchemaForm({
  schema,
  formData,
  onSubmit,
  onError,
  mode = 'full',
  disabled = false,
  className,
  submitButtonText,
  id,
  hideSubmit = false,
  domainId,
  formContext,
}: SchemaFormProps) {
  // Base schema (meta stripped) still carries `x-show-if` so the evaluator can read it.
  const baseSchema = React.useMemo(() => stripMetaSchema(schema), [schema]);

  // Controlled form data. Seeded from the prop, with hidden values pre-cleared so
  // an edit-mode load whose stored control no longer matches starts clean.
  const [data, setData] = React.useState<Record<string, unknown>>(
    () => resolveVisibleSchema(baseSchema, formData ?? {}).formData,
  );

  // Re-seed when the incoming formData identity changes (edit mode loads async).
  // Parents pass a stable formData identity except on (re)load, so this does not
  // fire while the user is typing.
  React.useEffect(() => {
    setData(resolveVisibleSchema(baseSchema, formData ?? {}).formData);
  }, [baseSchema, formData]);

  const resolved = resolveVisibleSchema(baseSchema, data);
  // Signature of the visible set. The normalized schema + uiSchema are memoized on
  // this so their object identity is stable while the visible set is unchanged —
  // otherwise RJSF remounts fields and text inputs lose focus on every keystroke.
  const hiddenKey = resolved.hidden.join('|');

  const rjsfSchema = React.useMemo(
    () => normalizeSchemaForRjsf(resolved.schema),
    // resolved.schema depends only on (schema, visible set); key on hiddenKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [schema, hiddenKey],
  );

  const uiSchema = React.useMemo(() => {
    const ui = generateUiSchema(resolved.schema, mode, hideSubmit ? undefined : submitButtonText);
    if (hideSubmit) ui['ui:submitButtonOptions'] = { norender: true };
    return ui;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, hiddenKey, mode, hideSubmit, submitButtonText]);

  const templates = domainId && formLayouts[domainId]
    ? { ObjectFieldTemplate: SectionedObjectFieldTemplate(domainId) }
    : undefined;

  const containerRef = React.useRef<HTMLDivElement>(null);

  return (
    <div className={className} ref={containerRef}>
      <Form
        id={id}
        schema={rjsfSchema}
        uiSchema={uiSchema}
        formData={data}
        validator={validator}
        widgets={widgets}
        templates={templates}
        disabled={disabled}
        formContext={formContext}
        onChange={({ formData: next }) => {
          setData(resolveVisibleSchema(baseSchema, (next ?? {}) as Record<string, unknown>).formData);
        }}
        onSubmit={({ formData: submitted }) => {
          if (submitted) onSubmit(submitted as Record<string, unknown>);
        }}
        onError={(errors) => onError?.(errors)}
        focusOnFirstError={(error) =>
          focusErrorField(containerRef.current, error as RjsfError)
        }
        showErrorList={false}
        liveValidate={false}
        noHtml5Validate
        omitExtraData
        liveOmit
      />
    </div>
  );
}
