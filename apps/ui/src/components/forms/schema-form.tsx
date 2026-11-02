import * as React from 'react';
import Form from '@rjsf/shadcn';
import validator from '@rjsf/validator-ajv8';
import { useTranslation } from 'react-i18next';
import type {
  RJSFSchema,
  UiSchema,
  RegistryWidgetsType,
  ObjectFieldTemplateProps,
  RJSFValidationError,
} from '@rjsf/utils';
import { applyUriPatterns, collectUriFieldKeys, URI_FIELD_MARKER } from '@dpg/schemas/uri_fields';
import { DatePickerWidget } from './custom-widgets/date-picker-widget';
import { LocationAutocompleteWidget } from './custom-widgets/location-autocomplete-widget';
import { MultiLocationAutocompleteWidget } from './custom-widgets/multi-location-autocomplete-widget';
import { ReferenceAutocompleteWidget } from './custom-widgets/reference-autocomplete-widget';
import { ClearableSelectWidget } from './custom-widgets/clearable-select-widget';
import CustomFieldTemplate from './custom-field-template';
import { resolveFormLayout, type FormLayout } from '@/theme/form-layouts';
import { resolveVisibleSchema } from '@/lib/show-if';
import { filterErrorSchemaToVisited } from './field-error-visibility';
import { FIELD_ERROR_MESSAGE_MARKER, resolvePatternErrorMessage } from './field-error-message';
import { cn } from '@/lib/utils';

interface RjsfError {
  property?: string;
  name?: string;
  params?: { missingProperty?: string };
}

/**
 * Maps an RJSF error to the field's DOM id: ".items.0.name" becomes
 * "root_items_0_name" (RJSF's default idPrefix and idSeparator).
 */
function fieldIdFromError(error: RjsfError): string {
  const segments = (error.property ?? '')
    .replace(/\[(\w+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  return ['root', ...segments].join('_');
}

/**
 * `focusOnFirstError` handler: scrolls the first invalid field to the centre
 * and focuses it.
 */
function focusErrorField(container: HTMLElement | null, error: RjsfError): void {
  if (!container) return;
  const elementId = fieldIdFromError(error);
  const form = container.querySelector('form');

  // Resolve like RJSF does: by id or name, then a prefix match for shadcn
  // widgets that put the id on a wrapping button.
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
  /**
   * Initial values. Must be referentially stable: the form re-seeds whenever
   * this identity changes, so an inline literal discards edits every render.
   */
  formData?: Record<string, unknown>;
  onSubmit: (data: Record<string, unknown>) => void;
  onError?: (errors: unknown[]) => void;
  mode?: 'full' | 'compact';
  disabled?: boolean;
  className?: string;
  submitButtonText?: string;
  id?: string;
  hideSubmit?: boolean;
  /**
   * Called with AJV validity on mount and whenever data changes; `detail`
   * says why it is invalid. Only computed when provided.
   */
  onValidityChange?: (isValid: boolean, detail?: SchemaFormValidity) => void;
  domainId?: string;
  /**
   * With `domainId`, resolves the section layout. Domain ids collide across
   * networks, so layouts are keyed `${networkId}:${domainId}`.
   */
  networkId?: string;
  formContext?: Record<string, unknown>;
  /**
   * Heading level for section titles, so they follow the page's own heading
   * without skipping a level.
   */
  sectionHeadingLevel?: 2 | 3;
}

// ObjectFieldTemplate rendering layout sections, pairing adjacent `twoColumn`
// fields side by side.
function SectionedObjectFieldTemplate(
  layout: FormLayout | undefined,
  headingLevel: 2 | 3 = 3,
) {
  const SectionHeading = headingLevel === 2 ? 'h2' : 'h3';
  return function ObjectFieldTemplate(props: ObjectFieldTemplateProps) {
    if (!layout) {
      return (
        <div className="space-y-4">
          {props.properties.map((element) => (
            <div key={element.name}>{element.content}</div>
          ))}
        </div>
      );
    }

    const elementMap = new Map(props.properties.map((el) => [el.name, el]));
    const rendered = new Set<string>();

    // Numbers only sections that render.
    let visibleSectionIndex = 0;

    return (
      <div className="space-y-10">
        {layout.sections.map((section) => {
          const sectionElements = section.fields
            .map((f) => elementMap.get(f))
            .filter((el): el is NonNullable<typeof el> => !!el);

          if (sectionElements.length === 0) return null;

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
              {/* Section header */}
              <div className="mb-5">
                <div className="flex items-center gap-3">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-xs font-bold text-primary">
                    {sectionNum}
                  </div>
                  <SectionHeading className="text-base font-semibold text-foreground tracking-tight">{section.title}</SectionHeading>
                </div>
                <div className="mt-3 h-px bg-gradient-to-r from-border via-border/60 to-transparent" />
              </div>
              <div className="space-y-3">
                {rows.map((row, ri) =>
                  row.length === 2 ? (
                    <div key={ri} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

        {/* Fields not covered by any section */}
        {props.properties
          .filter((el) => !rendered.has(el.name))
          .map((el) => (
            <div key={el.name}>{el.content}</div>
          ))}
      </div>
    );
  };
}

// Resolves a local JSON pointer ("#/$defs/x") against the root schema.
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

  // The page chrome already titles the form, so suppress the schema's root
  // title and description.
  uiSchema['ui:title'] = '';
  uiSchema['ui:description'] = '';

  uiSchema['ui:submitButtonOptions'] = {
    ...(submitButtonText ? { submitText: submitButtonText } : {}),
    props: {
      className: 'mt-8 h-12 w-full text-base font-semibold bg-brand-cta hover:brightness-110 transition-all active:scale-95 shadow-md',
    },
  };

  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const typed = prop as RJSFSchema & {
      private?: boolean;
      format?: string;
      [URI_FIELD_MARKER]?: unknown;
    };

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

    // A link field (`x-uri`) gets a sample URL as its prompt. Merged, since
    // earlier blocks may have written this key.
    if (typed[URI_FIELD_MARKER] === true) {
      uiSchema[key] = { ...(uiSchema[key] as object), 'ui:placeholder': 'https://example.com' };
    }

    if (typed.enum && typed.type === 'string') {
      uiSchema[key] = { 'ui:placeholder': 'Select...' };
    }

    // Array-of-enums renders as one multi-select (FancyMultiSelect) instead of
    // RJSF's stack of per-index single-selects.
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

    // A field-level `placeholder` in the schema wins over the defaults above.
    const fieldPlaceholder = (typed as { placeholder?: unknown }).placeholder;
    if (typeof fieldPlaceholder === 'string' && fieldPlaceholder.length > 0) {
      uiSchema[key] = {
        ...(uiSchema[key] as object),
        'ui:placeholder': fieldPlaceholder,
      };
    }

    // `x-reference-source`: an autocomplete over a reference dataset, so large
    // lists stay out of the schema. Either a `"source"` string or
    // `{ source, subtitle }`, where `subtitle` lists the option fields shown
    // under each result.
    const referenceMarker = (typed as { 'x-reference-source'?: unknown })['x-reference-source'];
    let referenceSource: string | undefined;
    let subtitleFields: string[] | undefined;
    if (typeof referenceMarker === 'string') {
      referenceSource = referenceMarker;
    } else if (referenceMarker && typeof referenceMarker === 'object') {
      const m = referenceMarker as { source?: unknown; subtitle?: unknown };
      if (typeof m.source === 'string') referenceSource = m.source;
      if (Array.isArray(m.subtitle)) {
        subtitleFields = m.subtitle.filter((s): s is string => typeof s === 'string');
      }
    }
    if (referenceSource && referenceSource.length > 0) {
      const existing = (uiSchema[key] as Record<string, unknown>) ?? {};
      const existingOptions = (existing['ui:options'] as Record<string, unknown>) ?? {};
      uiSchema[key] = {
        ...existing,
        'ui:widget': 'reference-autocomplete',
        'ui:options': {
          ...existingOptions,
          source: referenceSource,
          ...(subtitleFields ? { subtitleFields } : {}),
        },
      };
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
  'reference-autocomplete': ReferenceAutocompleteWidget,
  // Overrides the theme's `SelectWidget` by name, so every enum field gets a
  // clear button when optional.
  SelectWidget: ClearableSelectWidget,
};

function stripMetaSchema(schema: RJSFSchema): RJSFSchema {
  const { $schema, ...rest } = schema as RJSFSchema & { $schema?: string };
  return rest as RJSFSchema;
}

// Inlines local `$ref`s, strips the custom keywords below, and sets `uniqueItems:
// true` on array-of-enum fields. RJSF's multi-select needs the items enum
// inline and uniqueItems set; otherwise the field renders as an empty
// single-select.
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
    // The `location` marker ("primary" | "secondary"), not a property named
    // "location", whose value is a schema object.
    if (key === 'location' && (value === 'primary' || value === 'secondary')) continue;
    if (key === 'x-show-if') continue;
    if (key === 'x-form-layout') continue;
    // The string guard keeps a property named "placeholder".
    if (key === 'placeholder' && typeof value === 'string') continue;
    if (key === 'x-reference-source') continue;
    if (key === FIELD_ERROR_MESSAGE_MARKER) continue;
    // `x-uri` has already become a `pattern` via applyUriPatterns.
    if (key === URI_FIELD_MARKER) continue;
    result[key] = normalizeSchemaForRjsf(value as RJSFSchema, root);
  }

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

export function isSchemaFormValid(
  v: typeof validator,
  schema: RJSFSchema,
  data: Record<string, unknown>,
): boolean {
  return v.isValid(schema, data, schema);
}

/** Why a form is invalid, so callers can say which of the two it is. */
export interface SchemaFormValidity {
  valid: boolean;
  /** Required fields the user has not filled in. */
  missingRequired: number;
  /** Fields that hold a value which breaks its own rule (pattern, format, …). */
  invalidValues: number;
}

/** Resolve an RJSF error `property` (".a", ".a.0") against the form data. */
function valueAtProperty(data: Record<string, unknown>, property: string | undefined): unknown {
  if (!property) return undefined;
  const segments = property.replace(/\[(\w+)\]/g, '.$1').split('.').filter(Boolean);
  let cursor: unknown = data;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Ajv's `if` error only summarises a conditional branch ("must match "then"
 * schema") on top of the field-level errors, so counting and display skip it.
 */
function isConditionalSummary(error: { name?: string }): boolean {
  return error.name === 'if';
}

/**
 * Splits AJV errors into missing required fields and invalid values, which
 * need different copy. A blank value counts as missing even when AJV reports
 * `minLength`.
 */
export function getSchemaFormValidity(
  v: typeof validator,
  schema: RJSFSchema,
  data: Record<string, unknown>,
): SchemaFormValidity {
  const errors = v.validateFormData(data, schema).errors.filter((e) => !isConditionalSummary(e));
  let missingRequired = 0;
  let invalidValues = 0;
  for (const error of errors) {
    const blank = isBlank(valueAtProperty(data, error.property));
    if (error.name === 'required' || blank) missingRequired += 1;
    else invalidValues += 1;
  }
  return { valid: errors.length === 0, missingRequired, invalidValues };
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
  onValidityChange,
  domainId,
  networkId,
  formContext,
  sectionHeadingLevel = 3,
}: Readonly<SchemaFormProps>) {
  const { t } = useTranslation();

  // Still carries `x-show-if` for the visibility evaluator.
  const baseSchema = React.useMemo(() => stripMetaSchema(schema), [schema]);

  // Seeded with hidden values cleared, so an edit-mode load starts clean.
  const [data, setData] = React.useState<Record<string, unknown>>(
    () => resolveVisibleSchema(baseSchema, formData ?? {}).formData,
  );

  // Re-seed when the formData identity changes (async edit-mode load).
  React.useEffect(() => {
    setData(resolveVisibleSchema(baseSchema, formData ?? {}).formData);
  }, [baseSchema, formData]);

  const resolved = resolveVisibleSchema(baseSchema, data);
  // The schema and uiSchema are memoized on the visible set; a new identity
  // per render makes RJSF remount fields and inputs lose focus on each key.
  const hiddenKey = resolved.hidden.join('|');

  const rjsfSchema = React.useMemo(
    // applyUriPatterns first, so the `x-uri` pattern exists before the marker
    // is stripped.
    () => normalizeSchemaForRjsf(applyUriPatterns(resolved.schema)),
    // resolved.schema depends only on schema and the visible set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [schema, hiddenKey],
  );

  const uiSchema = React.useMemo(() => {
    const ui = generateUiSchema(resolved.schema, mode, hideSubmit ? undefined : submitButtonText);
    if (hideSubmit) ui['ui:submitButtonOptions'] = { norender: true };
    return ui;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, hiddenKey, mode, hideSubmit, submitButtonText]);

  const uriFieldKeys = React.useMemo(() => new Set(collectUriFieldKeys(baseSchema)), [baseSchema]);

  /**
   * Readable copy for a failed `pattern`, since AJV's message is the raw
   * regex: the field's `x-error-message`, else the `x-uri` default, else a
   * generic. Used by both error paths, as `extraErrors` bypasses
   * `transformErrors`.
   */
  const patternMessageFor = React.useCallback(
    (property: string): string => {
      const properties = (baseSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
      return resolvePatternErrorMessage(properties[property], uriFieldKeys.has(property), {
        uri: t('form.invalid_url', 'Enter a valid link, e.g. https://example.com'),
        generic: (label) => t('form.invalid_format', 'Please enter a valid {{field}}.', { field: label }),
      });
    },
    [baseSchema, uriFieldKeys, t],
  );

  const transformErrors = React.useCallback(
    (errors: RJSFValidationError[]) =>
      errors.filter((error) => !isConditionalSummary(error)).map((error) => {
        if (error.name !== 'pattern') return error;
        const field = (error.property ?? '').replace(/^\./, '').split('.')[0];
        const message = patternMessageFor(field);
        // `stack` is what RJSF's ErrorList renders, so rewrite it too.
        return { ...error, message, stack: `${error.property} ${message}` };
      }),
    [patternMessageFor],
  );

  // A ref, so an inline-arrow callback does not re-fire the effect below in a
  // render loop.
  const onValidityChangeRef = React.useRef(onValidityChange);
  React.useEffect(() => {
    onValidityChangeRef.current = onValidityChange;
  });

  React.useEffect(() => {
    const cb = onValidityChangeRef.current;
    if (!cb) return;
    const detail = getSchemaFormValidity(validator, rjsfSchema, data);
    cb(detail.valid, detail);
  }, [rjsfSchema, data]);

  // Visited fields by RJSF id ("root_phone"); only these get errors.
  const [touchedFieldIds, setTouchedFieldIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [submitAttempted, setSubmitAttempted] = React.useState(false);

  const markTouched = React.useCallback((fieldId: string) => {
    setTouchedFieldIds((prev) => {
      if (prev.has(fieldId)) return prev;
      const next = new Set(prev);
      next.add(fieldId);
      return next;
    });
  }, []);

  // Reset on a schema swap so one form's touched set never leaks into another.
  React.useEffect(() => {
    setTouchedFieldIds(new Set());
    setSubmitAttempted(false);
  }, [schema]);

  // Display errors via `extraErrors`, limited to visited fields. `liveValidate`
  // is off because it errors every invalid field at once and the theme reddens
  // borders from `rawErrors`. RJSF still validates on submit.
  const extraErrors = React.useMemo(() => {
    const { errors, errorSchema } = validator.validateFormData(data, rjsfSchema);
    const patternFields = new Set(
      errors
        .filter((error) => error.name === 'pattern')
        .map((error) => (error.property ?? '').replace(/^\./, '').split('.')[0])
        .filter(Boolean),
    );
    const readable: Record<string, unknown> = { ...errorSchema };
    // Drop the root-level `if` summary.
    const ifMessages = new Set(errors.filter(isConditionalSummary).map((e) => e.message));
    const rootErrors = (readable.__errors as string[] | undefined)?.filter((m) => !ifMessages.has(m));
    if (rootErrors && rootErrors.length > 0) readable.__errors = rootErrors;
    else delete readable.__errors;
    for (const property of patternFields) {
      readable[property] = { __errors: [patternMessageFor(property)] };
    }
    return filterErrorSchemaToVisited(readable as typeof errorSchema, touchedFieldIds, submitAttempted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rjsfSchema, data, touchedFieldIds, submitAttempted, patternMessageFor]);

  // The schema's `x-form-layout` wins; the code-side `formLayouts` map is the
  // fallback for networks without one.
  const activeLayout: FormLayout | undefined =
    (schema as { 'x-form-layout'?: FormLayout })['x-form-layout'] ??
    resolveFormLayout(networkId, domainId);

  const templates = {
    FieldTemplate: CustomFieldTemplate,
    ...(activeLayout
      ? { ObjectFieldTemplate: SectionedObjectFieldTemplate(activeLayout, sectionHeadingLevel) }
      : {}),
  };

  const containerRef = React.useRef<HTMLDivElement>(null);

  return (
    <div
      // Left-align select triggers: `@rjsf/shadcn`'s FancySelect trigger is a
      // <button>, which keeps the UA `text-align: center`.
      className={cn('[&_button[aria-haspopup=listbox]]:text-left', className)}
      ref={containerRef}
    >
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
          const nextData = resolveVisibleSchema(baseSchema, (next ?? {}) as Record<string, unknown>).formData;
          setData(nextData);
        }}
        onBlur={(fieldId) => markTouched(fieldId)}
        onSubmit={({ formData: submitted }) => {
          setSubmitAttempted(true);
          if (submitted) onSubmit(submitted as Record<string, unknown>);
        }}
        onError={(errors) => {
          setSubmitAttempted(true);
          onError?.(errors);
        }}
        transformErrors={transformErrors}
        focusOnFirstError={(error) =>
          focusErrorField(containerRef.current, error as RjsfError)
        }
        showErrorList={false}
        extraErrors={extraErrors}
        liveValidate={false}
        noHtml5Validate
        omitExtraData
        liveOmit
      />
    </div>
  );
}
