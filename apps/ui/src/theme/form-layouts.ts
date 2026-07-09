export interface FormSection {
  title: string;
  fields: string[];
}

export interface FormLayout {
  sections: FormSection[];
  twoColumn: string[];
}

// Form layout config keyed by `${networkId}:${domainId}` (network-aware) or a
// bare `domainId` (back-compat). Domain ids like `seeker`/`provider` collide
// across networks (blue_dot AND purple_dot both expose them), so network-scoped
// keys are required to stop one network inheriting another's field lists — see
// `resolveFormLayout`. Fields listed in `twoColumn` render side-by-side within
// their section. Anything not resolved here falls back to the default
// single-column RJSF render.
export const formLayouts: Record<string, FormLayout> = {
  student: {
    sections: [
      {
        title: 'About You',
        fields: ['Student ID', 'Full Name', 'Phone Number', 'Email Address', 'Location'],
      },
      {
        title: 'Academics',
        fields: ['Grade', 'Academic Stream'],
      },
      {
        title: 'What You Need',
        fields: ['Service Looking For'],
      },
    ],
    twoColumn: ['Phone Number', 'Email Address', 'Grade', 'Academic Stream'],
  },

  tutor_counsellor: {
    sections: [
      {
        title: 'About You',
        fields: ['Tutor ID', 'Full Name', 'Phone Number', 'Email Address', 'Location'],
      },
      {
        title: 'Service Details',
        fields: ['Coverage Radius (km)', 'Service Offered'],
      },
      {
        title: 'Grade Bands Served',
        fields: ['Grade Bands Served'],
      },
      {
        title: 'Academic Streams Served',
        fields: ['Academic Streams Served'],
      },
    ],
    twoColumn: ['Phone Number', 'Email Address', 'Coverage Radius (km)', 'Service Offered'],
  },

  // NOTE: blue_dot AND purple_dot layouts are NOT here — they live in their
  // examples/schemas/<network>/network.json as `x-form-layout` on each item
  // schema (schema-driven, single source of truth). The code-side map above is
  // the fallback for networks not yet migrated (yellow_dot student/tutor).
};

/**
 * Resolve the form layout for a (network, domain) pair. Prefers the
 * network-scoped key `${networkId}:${domainId}` and falls back to a bare
 * `domainId` for networks/domains that don't collide (e.g. yellow_dot
 * `student`). Returns undefined when nothing matches — the caller then renders
 * the default single-column form.
 */
export function resolveFormLayout(
  networkId: string | undefined,
  domainId: string | undefined,
): FormLayout | undefined {
  if (!domainId) return undefined;
  if (networkId) {
    const scoped = formLayouts[`${networkId}:${domainId}`];
    if (scoped) return scoped;
  }
  return formLayouts[domainId];
}
