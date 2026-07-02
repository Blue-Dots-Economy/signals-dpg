import { describe, it, expect } from 'vitest';
import type { ConsentConfigDocument } from '@dpg/schemas';
import { mergeConsentConfig } from '../use-consent-config';

const termsDoc: ConsentConfigDocument['documents']['terms'] = {
  current_version: 1,
  versions: [{ version: 1, title: 'Terms v1', content: 'Default terms content.', effective_from: '2024-01-01' }],
};

const privacyDoc: ConsentConfigDocument['documents']['privacy'] = {
  current_version: 1,
  versions: [{ version: 1, title: 'Privacy v1', content: 'Default privacy content.', effective_from: '2024-01-01' }],
};

const profileCreationDoc: ConsentConfigDocument['documents']['profile_creation'] = {
  current_version: 1,
  versions: [{ version: 1, statement: 'Default profile creation statement.', effective_from: '2024-01-01' }],
};

const networkDefault: ConsentConfigDocument = {
  documents: {
    terms: termsDoc,
    privacy: privacyDoc,
    profile_creation: profileCreationDoc,
  },
};

const brandPrivacyDoc: ConsentConfigDocument['documents']['privacy'] = {
  current_version: 2,
  versions: [
    { version: 1, title: 'Brand Privacy v1', content: 'Brand privacy v1 content.', effective_from: '2024-01-01' },
    { version: 2, title: 'Brand Privacy v2', content: 'Brand privacy v2 content.', effective_from: '2025-01-01' },
  ],
};

describe('mergeConsentConfig', () => {
  it('brand override of privacy replaces only privacy; terms, profile_creation, and actions inherit from default', () => {
    const brandOverride: ConsentConfigDocument = {
      documents: {
        terms: networkDefault.documents.terms,
        privacy: brandPrivacyDoc,
        profile_creation: networkDefault.documents.profile_creation,
      },
    };

    const merged = mergeConsentConfig(networkDefault, brandOverride);

    expect(merged.documents.privacy).toBe(brandPrivacyDoc);
    expect(merged.documents.terms).toBe(termsDoc);
    expect(merged.documents.profile_creation).toBe(profileCreationDoc);
    expect(merged.actions).toBeUndefined();
  });

  it('no brand override returns default unchanged', () => {
    const merged = mergeConsentConfig(networkDefault);

    expect(merged).toBe(networkDefault);
  });

  it('brand current_version is honored over the default current_version', () => {
    const brandOverride: ConsentConfigDocument = {
      documents: {
        terms: networkDefault.documents.terms,
        privacy: brandPrivacyDoc,
        profile_creation: networkDefault.documents.profile_creation,
      },
    };

    const merged = mergeConsentConfig(networkDefault, brandOverride);

    expect(merged.documents.privacy.current_version).toBe(2);
    expect(merged.documents.terms.current_version).toBe(1);
  });
});
