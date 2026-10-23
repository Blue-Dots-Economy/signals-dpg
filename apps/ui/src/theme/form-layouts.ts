export interface FormSection {
  title: string;
  fields: string[];
}

export interface FormLayout {
  sections: FormSection[];
  twoColumn: string[];
}

// Form layout config keyed by `${networkId}:${domainId}` or a bare `domainId`.
// Domain ids like `seeker`/`provider` collide across networks, so
// network-scoped keys stop one network inheriting another's field lists (see
// `resolveFormLayout`). Fields in `twoColumn` render side-by-side within their
// section; anything unresolved renders as the default single-column form.
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

  // blue_dot and purple_dot layouts live in their network.json as
  // `x-form-layout` on each item schema. This map is the fallback for networks
  // without one (yellow_dot student/tutor).
};

/**
 * Resolves the form layout for a (network, domain) pair: the network-scoped
 * key first, then the bare `domainId`. Undefined means the default
 * single-column form.
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
