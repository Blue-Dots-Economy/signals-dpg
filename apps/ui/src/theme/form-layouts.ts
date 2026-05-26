export interface FormSection {
  title: string;
  fields: string[];
}

export interface FormLayout {
  sections: FormSection[];
  twoColumn: string[];
}

// Per-domain form layout config. Fields listed in `twoColumn` render
// side-by-side within their section. Domains not listed here fall back
// to the default single-column RJSF render.
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

  // purple_dot network — PWD Beneficiary Profile
  seeker: {
    sections: [
      {
        title: 'Personal Details',
        fields: ['beneficiary_name', 'age', 'gender', 'mobile_number', 'email'],
      },
      {
        title: 'Disability Profile',
        fields: ['disability_type', 'disability_percentage', 'looking_for', 'looking_for_details'],
      },
      {
        title: 'Location',
        fields: ['service_city', 'state', 'district', 'block', 'pincode', 'address'],
      },
      {
        title: 'Documents & Education',
        fields: ['documents_available', 'highest_qualification'],
      },
    ],
    twoColumn: ['age', 'gender', 'mobile_number', 'email', 'state', 'district', 'block', 'pincode'],
  },

  // purple_dot network — PWD Service Provider Profile
  provider: {
    sections: [
      {
        title: 'Contact Details',
        fields: ['contact_name', 'contact_phone', 'contact_email'],
      },
      {
        title: 'Organisation',
        fields: ['provider_category', 'organisation_name'],
      },
      {
        title: 'Services & Coverage',
        fields: ['disabilities_served', 'services_offered', 'service_cities'],
      },
      {
        title: 'Location',
        fields: ['official_address', 'state', 'district', 'block', 'pincode'],
      },
      {
        title: 'More Details',
        fields: ['service_details', 'catalog_url'],
      },
    ],
    twoColumn: ['contact_phone', 'contact_email', 'state', 'district', 'block', 'pincode'],
  },
};
