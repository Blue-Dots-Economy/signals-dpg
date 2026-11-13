import { ariaDescribedByIds, descriptionId, errorId, getTemplate, labelValue, type WidgetProps } from '@rjsf/utils';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

/** Boolean field: the theme's checkbox plus `aria-invalid` while it has an error. */
export function CheckboxWidget({
  id,
  htmlName,
  value,
  disabled,
  readonly,
  label,
  hideLabel,
  required,
  autofocus,
  onChange,
  onBlur,
  onFocus,
  rawErrors,
  schema,
  uiSchema,
  options,
  registry,
}: Readonly<WidgetProps>) {
  const invalid = Boolean(rawErrors && rawErrors.length > 0);
  const DescriptionFieldTemplate = getTemplate('DescriptionFieldTemplate', registry, options);
  const description = options.description || schema.description;
  return (
    <div className={disabled || readonly ? 'relative cursor-not-allowed opacity-50' : 'relative'}>
      {!hideLabel && description && (
        <DescriptionFieldTemplate
          id={descriptionId(id)}
          description={description}
          schema={schema}
          uiSchema={uiSchema}
          registry={registry}
        />
      )}
      <div className="flex items-center gap-2 my-2">
        <Checkbox
          id={id}
          name={htmlName || id}
          checked={Boolean(value)}
          required={required}
          disabled={disabled || readonly}
          autoFocus={autofocus}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId(id) : ariaDescribedByIds(id)}
          onCheckedChange={(checked) => onChange(checked === true)}
          onBlur={() => onBlur(id, value)}
          onFocus={() => onFocus(id, value)}
        />
        <Label className="leading-tight" htmlFor={id}>
          {labelValue(label, hideLabel || !label)}
        </Label>
      </div>
    </div>
  );
}
