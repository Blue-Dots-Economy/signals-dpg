import { type FieldTemplateProps, getTemplate, getUiOptions } from '@rjsf/utils';

import { cn } from '@/lib/utils';
import { SUBMIT_ATTEMPTED_KEY, TOUCHED_FIELDS_KEY } from './schema-form';

/**
 * Whether this field's validation error should be shown yet.
 *
 * SchemaForm runs `liveValidate`, so AJV errors exist for every empty required
 * field from the first render. Painting those immediately would turn a pristine
 * form red, so an error surfaces only once the user has visited the field (blur)
 * or has tried to submit. After that it updates live, clearing as soon as the
 * value becomes valid.
 *
 * A container (object/array) counts as visited when any of its children is, so a
 * bad array entry still reddens the group it sits in.
 */
function shouldShowErrors(
  id: string,
  formContext: unknown,
): boolean {
  const ctx = (formContext ?? {}) as Record<string, unknown>;
  if (ctx[SUBMIT_ATTEMPTED_KEY] === true) return true;
  const touched = ctx[TOUCHED_FIELDS_KEY];
  if (!(touched instanceof Set)) return true; // no gate wired up: preserve prior behaviour
  if (touched.has(id)) return true;
  for (const touchedId of touched) {
    if (typeof touchedId === 'string' && touchedId.startsWith(`${id}_`)) return true;
  }
  return false;
}

/**
 * FieldTemplate override of `@rjsf/shadcn`'s default. Identical layout, with one
 * change: the required indicator is a red asterisk shown for every required field
 * (the upstream template renders a plain `*` that only turns red on validation
 * error). This gives a consistent red required marker across all schema-driven
 * forms. See issue #200.
 */
export default function CustomFieldTemplate({
  id,
  children,
  displayLabel,
  rawErrors = [],
  errors,
  help,
  description,
  rawDescription,
  classNames,
  style,
  disabled,
  label,
  hidden,
  onKeyRename,
  onKeyRenameBlur,
  onRemoveProperty,
  readonly,
  required,
  schema,
  uiSchema,
  registry,
}: FieldTemplateProps) {
  const uiOptions = getUiOptions(uiSchema);
  const WrapIfAdditionalTemplate = getTemplate<'WrapIfAdditionalTemplate'>(
    'WrapIfAdditionalTemplate',
    registry,
    uiOptions,
  );
  // Gate the error display (not the validation) on whether the user has been here.
  const showErrors = shouldShowErrors(id, registry.formContext);
  const visibleRawErrors = showErrors ? rawErrors : [];
  if (hidden) {
    return <div className="hidden">{children}</div>;
  }
  const isCheckbox = uiOptions.widget === 'checkbox';
  return (
    <WrapIfAdditionalTemplate
      classNames={classNames}
      style={style}
      disabled={disabled}
      id={id}
      label={label}
      displayLabel={displayLabel}
      onKeyRename={onKeyRename}
      onKeyRenameBlur={onKeyRenameBlur}
      onRemoveProperty={onRemoveProperty}
      rawDescription={rawDescription}
      readonly={readonly}
      required={required}
      schema={schema}
      uiSchema={uiSchema}
      registry={registry}
    >
      <div className="flex flex-col gap-2">
        {displayLabel && !isCheckbox && (
          <label
            className={cn(
              'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
              { ' text-destructive': visibleRawErrors.length > 0 },
            )}
            htmlFor={id}
          >
            {label}
            {required ? (
              <>
                <span aria-hidden="true" className="ml-0.5 text-destructive">
                  *
                </span>
                <span className="sr-only"> (required)</span>
              </>
            ) : null}
          </label>
        )}
        {children}
        {displayLabel && rawDescription && !isCheckbox && (
          <span
            className={cn('text-xs font-medium text-muted-foreground', {
              ' text-destructive': visibleRawErrors.length > 0,
            })}
          >
            {description}
          </span>
        )}
        {showErrors ? errors : null}
        {help}
      </div>
    </WrapIfAdditionalTemplate>
  );
}
