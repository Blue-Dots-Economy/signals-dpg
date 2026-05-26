import Form from '@rjsf/shadcn';
import validator from '@rjsf/validator-ajv8';
import type { RJSFSchema, UiSchema, RegistryWidgetsType, ObjectFieldTemplateProps } from '@rjsf/utils';
import { DatePickerWidget } from './custom-widgets/date-picker-widget';
import { formLayouts } from '@/theme/form-layouts';

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

    return (
      <div className="space-y-8">
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

          return (
            <section key={section.title}>
              <h3 className="mb-3 text-sm font-semibold text-foreground border-b border-border pb-1.5">
                {section.title}
              </h3>
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
  domainId,
}: SchemaFormProps) {
  const uiSchema = generateUiSchema(schema, mode, hideSubmit ? undefined : submitButtonText);
  if (hideSubmit) {
    uiSchema['ui:submitButtonOptions'] = { norender: true };
  }
  const schemaWithoutMeta = stripMetaSchema(schema);

  const templates = domainId && formLayouts[domainId]
    ? { ObjectFieldTemplate: SectionedObjectFieldTemplate(domainId) }
    : undefined;

  return (
    <div className={className}>
      <Form
        id={id}
        schema={schemaWithoutMeta}
        uiSchema={uiSchema}
        formData={formData}
        validator={validator}
        widgets={widgets}
        templates={templates}
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
