import Form from '@rjsf/shadcn';
import validator from '@rjsf/validator-ajv8';
import type { RJSFSchema, UiSchema, RegistryWidgetsType } from '@rjsf/utils';
import { DatePickerWidget } from './custom-widgets/date-picker-widget';

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
}

function generateUiSchema(
  schema: RJSFSchema,
  mode: 'full' | 'compact',
  submitButtonText?: string
): UiSchema {
  const uiSchema: Record<string, unknown> = {};

  // Suppress the JSON-Schema-supplied root title/description. Surrounding
  // page chrome (CardTitle / CardDescription) already announces the form;
  // the inline duplicate ("PWD Beneficiary Profile 1.0") just adds noise.
  uiSchema['ui:title'] = '';
  uiSchema['ui:description'] = '';

  // Style the default RJSF Submit button: full width, prominent size,
  // separated from the last field with extra top margin. The rjsf-shadcn
  // default renders a tiny `my-2` pill that looks like an afterthought.
  uiSchema['ui:submitButtonOptions'] = {
    ...(submitButtonText ? { submitText: submitButtonText } : {}),
    props: {
      className: 'mt-6 h-11 w-full text-base font-medium',
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
  }

  return uiSchema;
}

const widgets: RegistryWidgetsType = {
  date: DatePickerWidget,
};

function stripMetaSchema(schema: RJSFSchema): RJSFSchema {
  const { $schema, ...rest } = schema as RJSFSchema & { $schema?: string };
  return rest as RJSFSchema;
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
}: SchemaFormProps) {
  const uiSchema = generateUiSchema(schema, mode, hideSubmit ? undefined : submitButtonText);
  if (hideSubmit) {
    uiSchema['ui:submitButtonOptions'] = { norender: true };
  }
  const schemaWithoutMeta = stripMetaSchema(schema);

  return (
    <div className={className}>
      <Form
        id={id}
        schema={schemaWithoutMeta}
        uiSchema={uiSchema}
        formData={formData}
        validator={validator}
        widgets={widgets}
        disabled={disabled}
        onSubmit={({ formData }) => {
          if (formData) onSubmit(formData as Record<string, unknown>);
        }}
        onError={(errors) => onError?.(errors)}
        liveValidate={false}
        noHtml5Validate
      />
    </div>
  );
}
