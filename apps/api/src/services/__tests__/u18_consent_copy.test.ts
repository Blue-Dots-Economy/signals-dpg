import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseConsentConfigDocument } from '@dpg/schemas';

// Repo-root-relative to this test file: __tests__ → services → src → api → apps → root.
const root = fileURLToPath(new URL('../../../../../', import.meta.url));

const dots = ['blue_dot', 'purple_dot'] as const;

describe('U18 consent copy fixtures', () => {
  for (const dot of dots) {
    it(`${dot}/consent.json parses with a distinct u18_documents block`, () => {
      const raw = JSON.parse(
        readFileSync(`${root}examples/schemas/${dot}/consent.json`, 'utf8'),
      );
      const parsed = parseConsentConfigDocument(raw);
      expect(parsed.u18_documents?.guardian_declaration.current_version).toBe(1);
      // Distinct from adult (not aliased): U18 profile_creation statement differs.
      expect(parsed.u18_documents?.profile_creation.versions[0].statement).not.toBe(
        parsed.documents.profile_creation.versions[0].statement,
      );
    });
  }
});
