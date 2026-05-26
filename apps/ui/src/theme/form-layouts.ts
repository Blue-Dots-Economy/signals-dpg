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

  seeker: {
    sections: [
      {
        title: 'Personal Details',
        fields: ['name', 'gender', 'age', 'location', 'phone'],
      },
      {
        title: 'Work Preferences',
        fields: [
          'workExperience',
          'workExperienceYearsConditional',
          'highestQualificationOrSkill',
          'natureOfJobsInterestedIn',
          'nameOfJobRolesInterestedIn',
        ],
      },
      {
        title: 'Additional Support',
        fields: ['otherHelpNeeded'],
      },
    ],
    twoColumn: ['gender', 'age', 'workExperience', 'workExperienceYearsConditional'],
  },

  provider: {
    sections: [
      {
        title: 'Company Details',
        fields: ['jobProviderName', 'jobProviderLocation', 'role', 'positions', 'natureOfJob'],
      },
      {
        title: 'Hiring Manager',
        fields: ['hiringManagerName', 'hiringManagerPhoneNumber', 'hiringManagerEmail'],
      },
      {
        title: 'Compensation',
        fields: [
          'salaryMin',
          'salaryMax',
          'stipendMin',
          'stipendMax',
          'taskRateMin',
          'taskRateMax',
        ],
      },
      {
        title: 'Candidate Requirements',
        fields: [
          'candidateExperienceType',
          'minEducationalInstitute',
          'workExperienceYears',
          'lastRoleHeld',
        ],
      },
    ],
    twoColumn: [
      'hiringManagerPhoneNumber',
      'hiringManagerEmail',
      'salaryMin',
      'salaryMax',
      'stipendMin',
      'stipendMax',
      'taskRateMin',
      'taskRateMax',
      'positions',
      'natureOfJob',
    ],
  },
};
