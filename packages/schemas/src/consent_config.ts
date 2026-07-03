import z from 'zod';

const EffectiveFrom = z.string().min(1); // ISO date string; content, not validated as date in v1

const ContentVersion = z.object({
  version: z.number().int().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  effective_from: EffectiveFrom,
});

const StatementVersion = z.object({
  version: z.number().int().min(1),
  statement: z.string().trim().min(1).max(1000),
  effective_from: EffectiveFrom,
});

function documentWith<T extends z.ZodTypeAny>(versionSchema: T) {
  return z
    .object({
      current_version: z.number().int().min(1),
      versions: z.array(versionSchema).min(1),
    })
    .superRefine((doc, ctx) => {
      const nums = doc.versions.map((v) => (v as { version: number }).version);
      if (new Set(nums).size !== nums.length) {
        ctx.addIssue({ code: 'custom', message: 'version ints must be unique within a document' });
      }
      if (!nums.includes(doc.current_version)) {
        ctx.addIssue({ code: 'custom', message: `current_version ${doc.current_version} is not present in versions` });
      }
    });
}

const ContentDocument = documentWith(ContentVersion);
const StatementDocument = documentWith(StatementVersion);

const ActionStages = z.object({
  initiate: StatementDocument,
  accept: StatementDocument,
});

export const ConsentConfigSchema = z.object({
  documents: z.object({
    terms: ContentDocument,
    privacy: ContentDocument,
    profile_creation: StatementDocument,
  }),
  actions: z.record(z.string().min(1), ActionStages).optional(),
});

// Brand overrides are a partial document set — each document is optional. Built
// explicitly because Zod 4 has no `.deepPartial()`.
export const PartialConsentConfigSchema = z.object({
  documents: z
    .object({
      terms: ContentDocument.optional(),
      privacy: ContentDocument.optional(),
      profile_creation: StatementDocument.optional(),
    })
    .optional(),
  actions: z.record(z.string().min(1), ActionStages).optional(),
});

export type ConsentConfigDocument = z.infer<typeof ConsentConfigSchema>;
export type PartialConsentConfig = z.infer<typeof PartialConsentConfigSchema>;
export type ConsentDocumentVersions = z.infer<typeof ContentDocument>;

export function parseConsentConfigDocument(input: unknown): ConsentConfigDocument {
  return ConsentConfigSchema.parse(input);
}
