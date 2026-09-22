/**
 * `lib/consent-gate` — the login gate's document-set selection (#626).
 *
 * The bug this pins: four call sites each read `config.documents` directly, so
 * a known minor was shown the adult terms and had the acceptance recorded
 * against the adult version. The behaviour worth holding is that the variant
 * drives BOTH the copy and the version that gets written, and that a network
 * shipping no U18 set still lets a minor through rather than locking them out.
 */
import { describe, it, expect } from 'vitest';
import type { ConsentConfigDocument } from '@dpg/schemas';

import {
  buildOutstandingConsent,
  consentDocumentSet,
  currentGateVersions,
  outstandingGateCategories,
} from '@/lib/consent-gate';
import { mergeConsentConfig } from '@/hooks/use-consent-config';

const doc = (version: number, title: string) => ({
  current_version: version,
  versions: [{ version, title, content: `${title} body`, effective_from: '2026-01-01' }],
});

const statement = (version: number) => ({
  current_version: version,
  versions: [{ version, statement: 'statement', effective_from: '2026-01-01' }],
});

function config(overrides: Partial<ConsentConfigDocument> = {}): ConsentConfigDocument {
  return {
    documents: {
      terms: doc(2, 'Adult terms'),
      privacy: doc(3, 'Adult privacy'),
      profile_creation: statement(1),
    },
    ...overrides,
  } as ConsentConfigDocument;
}

const withU18 = () =>
  config({
    u18_documents: {
      terms: doc(7, 'U18 terms'),
      privacy: doc(8, 'U18 privacy'),
      profile_creation: statement(1),
      guardian_declaration: statement(1),
    },
  } as unknown as Partial<ConsentConfigDocument>);

describe('consentDocumentSet', () => {
  it('serves the U18 documents to a minor when the brand configures them', () => {
    const docs = consentDocumentSet(withU18(), 'u18');
    expect(docs.terms.versions[0].title).toBe('U18 terms');
    expect(docs.privacy.versions[0].title).toBe('U18 privacy');
  });

  it('serves the adult documents to an adult even when a U18 set exists', () => {
    expect(consentDocumentSet(withU18(), 'adult').terms.versions[0].title).toBe('Adult terms');
  });

  it('falls back to the adult set for a minor when no U18 set is configured', () => {
    // Most shipped networks have none. Gating against documents that do not
    // exist would leave a minor unable to satisfy the gate at all.
    expect(consentDocumentSet(config(), 'u18').terms.versions[0].title).toBe('Adult terms');
  });
});

describe('currentGateVersions / outstandingGateCategories', () => {
  it('compares a minor against the U18 versions, not the adult ones', () => {
    expect(currentGateVersions(withU18(), 'u18')).toEqual({ terms: 7, privacy: 8 });
  });

  it('treats a minor who accepted the adult versions as still owing the U18 ones', () => {
    // The regression that made #626 invisible: accepting v2/v3 looked complete
    // because the gate was diffing against the adult set either way.
    expect(outstandingGateCategories(withU18(), 'u18', { terms: [2], privacy: [3] })).toEqual([
      'terms',
      'privacy',
    ]);
  });

  it('clears the gate once the U18 versions are on file', () => {
    expect(outstandingGateCategories(withU18(), 'u18', { terms: [7], privacy: [8] })).toEqual([]);
  });
});

describe('buildOutstandingConsent', () => {
  it('returns null when nothing is outstanding', () => {
    expect(
      buildOutstandingConsent({
        config: config(),
        network: 'blue_dot',
        brand: 'standard',
        source: 'login',
        accepted: { terms: [2], privacy: [3] },
      }),
    ).toBeNull();
  });

  it('records the U18 versions and passes the variant through to the modal', () => {
    const out = buildOutstandingConsent({
      config: withU18(),
      network: 'blue_dot',
      brand: 'acme',
      source: 'signup',
      accepted: { terms: [], privacy: [] },
      variant: 'u18',
    });

    expect(out).not.toBeNull();
    expect(out?.variant).toBe('u18');
    expect(out?.pendingConsent).toEqual({
      network: 'blue_dot',
      brand: 'acme',
      source: 'signup',
      items: [
        { category: 'terms', version: 7 },
        { category: 'privacy', version: 8 },
      ],
    });
  });

  it("normalises the 'standard' brand to null, matching what the API stores", () => {
    const out = buildOutstandingConsent({
      config: config(),
      network: 'blue_dot',
      brand: 'standard',
      source: 'login',
      accepted: { terms: [], privacy: [] },
    });
    expect(out?.pendingConsent.brand).toBeNull();
  });

  it('defaults to the adult set when the status endpoint reports no variant', () => {
    // Older API, or a response predating #626 — must not crash or silently
    // pick the U18 set for someone whose age was never established.
    const out = buildOutstandingConsent({
      config: withU18(),
      network: 'blue_dot',
      brand: null,
      source: 'login',
      accepted: { terms: [], privacy: [] },
    });
    expect(out?.variant).toBe('adult');
    expect(out?.pendingConsent.items[0]).toEqual({ category: 'terms', version: 2 });
  });
});

describe('mergeConsentConfig + u18_documents', () => {
  it('keeps the network U18 set when a brand overrides only the adult documents', () => {
    // The second half of #626: the merge dropped `u18_documents` outright, so
    // every BRANDED deployment silently downgraded its minors to adult copy.
    const merged = mergeConsentConfig(withU18(), config({
      documents: { terms: doc(5, 'Brand terms'), privacy: doc(6, 'Brand privacy'), profile_creation: statement(1) },
    }));
    expect(merged.u18_documents?.terms.current_version).toBe(7);
    expect(merged.documents.terms.current_version).toBe(5);
  });

  it('lets a brand override a single U18 document without losing the rest', () => {
    const brandOverride = {
      documents: { terms: doc(5, 'Brand terms'), privacy: doc(6, 'Brand privacy'), profile_creation: statement(1) },
      u18_documents: { terms: doc(11, 'Brand U18 terms') },
    } as unknown as ConsentConfigDocument;

    const merged = mergeConsentConfig(withU18(), brandOverride);
    expect(merged.u18_documents?.terms.current_version).toBe(11);
    expect(merged.u18_documents?.privacy.current_version).toBe(8);
  });

  it('lets a brand introduce a U18 set the network itself does not ship', () => {
    const merged = mergeConsentConfig(config(), withU18());
    expect(merged.u18_documents?.terms.current_version).toBe(7);
  });
});
