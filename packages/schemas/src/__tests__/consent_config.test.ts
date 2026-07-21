import { describe, it, expect } from 'vitest';
import { parseConsentConfigDocument } from '../consent_config';

const valid = {
  documents: {
    terms: {
      current_version: 2,
      versions: [
        { version: 1, title: 'T', content: '# v1', effective_from: '2026-06-01' },
        { version: 2, title: 'T', content: '# v2', effective_from: '2026-07-01' },
      ],
    },
    privacy: {
      current_version: 1,
      versions: [{ version: 1, title: 'P', content: '# p', effective_from: '2026-06-01' }],
    },
    profile_creation: {
      current_version: 1,
      versions: [{ version: 1, statement: 'I agree', effective_from: '2026-06-01' }],
    },
  },
  actions: {
    connect: {
      initiate: { current_version: 1, versions: [{ version: 1, statement: 'init', effective_from: '2026-06-01' }] },
      accept: { current_version: 1, versions: [{ version: 1, statement: 'acc', effective_from: '2026-06-01' }] },
    },
  },
};

describe('parseConsentConfigDocument', () => {
  it('accepts a valid config', () => {
    const parsed = parseConsentConfigDocument(valid);
    expect(parsed.documents.terms.current_version).toBe(2);
    expect(parsed.actions?.connect?.initiate.versions).toHaveLength(1);
  });

  it('rejects current_version not present in versions', () => {
    const bad = structuredClone(valid);
    bad.documents.terms.current_version = 99;
    expect(() => parseConsentConfigDocument(bad)).toThrow();
  });

  it('rejects duplicate version ints in one document', () => {
    const bad = structuredClone(valid);
    bad.documents.privacy.versions.push({ version: 1, title: 'P', content: 'dup', effective_from: '2026-08-01' });
    expect(() => parseConsentConfigDocument(bad)).toThrow();
  });

  it('allows actions to be omitted (network with no actions)', () => {
    const noActions = structuredClone(valid);
    delete (noActions as { actions?: unknown }).actions;
    expect(() => parseConsentConfigDocument(noActions)).not.toThrow();
  });
});

describe('u18_documents', () => {
  const u18 = {
    terms: {
      current_version: 1,
      versions: [{ version: 1, title: 'U18 T', content: '# u18 terms', effective_from: '2026-07-01' }],
    },
    privacy: {
      current_version: 1,
      versions: [{ version: 1, title: 'U18 P', content: '# u18 privacy', effective_from: '2026-07-01' }],
    },
    profile_creation: {
      current_version: 1,
      versions: [{ version: 1, statement: 'Guardian agrees to profile creation', effective_from: '2026-07-01' }],
    },
    guardian_declaration: {
      current_version: 1,
      versions: [{ version: 1, statement: 'I confirm the named guardian is my parent/guardian', effective_from: '2026-07-01' }],
    },
  };

  it('accepts a config with a full u18_documents block', () => {
    const parsed = parseConsentConfigDocument({ ...valid, u18_documents: u18 });
    expect(parsed.u18_documents?.guardian_declaration.current_version).toBe(1);
  });

  it('still accepts a config with NO u18_documents (optional)', () => {
    const parsed = parseConsentConfigDocument(valid);
    expect(parsed.u18_documents).toBeUndefined();
  });

  it('rejects a u18_documents block missing guardian_declaration', () => {
    const { guardian_declaration: _drop, ...noDecl } = u18;
    expect(() => parseConsentConfigDocument({ ...valid, u18_documents: noDecl })).toThrow();
  });
});
