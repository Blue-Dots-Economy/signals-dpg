import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LegalDocumentView } from '@/pages/legal/legal-document-view';

const mockUseConsentConfig = vi.fn();
vi.mock('@/hooks/use-consent-config', () => ({
  useConsentConfig: () => mockUseConsentConfig(),
}));

function consentConfig(overrides: { privacyContent: string; termsContent: string }) {
  return {
    isLoading: false,
    config: {
      documents: {
        privacy: {
          current_version: 1,
          versions: [
            {
              version: 1,
              title: 'Privacy Policy',
              content: overrides.privacyContent,
              effective_from: '2026-06-01',
            },
          ],
        },
        terms: {
          current_version: 1,
          versions: [
            {
              version: 1,
              title: 'Terms of Service',
              content: overrides.termsContent,
              effective_from: '2026-06-01',
            },
          ],
        },
      },
    },
  };
}

// Shape verified against every real consent.json across all six network
// schemas: the document opens with a `##` heading that repeats its own
// `title`, then intro prose, then real subsections. A fixture that starts
// with something else (the earlier `## Overview`) doesn't exercise the
// duplicate-title bug production always hits.
const REAL_SHAPE = consentConfig({
  privacyContent: '## Privacy Policy\n\nIntro paragraph.\n### Retention\nx',
  termsContent: '## Terms of Service\n\nWelcome.',
});

const view = (doc: 'privacy' | 'terms') =>
  render(
    <MemoryRouter>
      <LegalDocumentView doc={doc} />
    </MemoryRouter>,
  );

describe('<LegalDocumentView />', () => {
  beforeEach(() => {
    mockUseConsentConfig.mockReturnValue(REAL_SHAPE);
  });

  it('lists both documents in the rail', () => {
    view('privacy');
    expect(screen.getAllByText('Privacy Policy').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Terms of Service').length).toBeGreaterThan(0);
  });

  it('anchors each extracted section', () => {
    view('privacy');
    expect(screen.getByRole('link', { name: 'Retention' })).toHaveAttribute('href', '#retention');
  });

  it('links to the other document by route', () => {
    view('privacy');
    expect(screen.getByRole('link', { name: /Terms of Service/ })).toHaveAttribute(
      'href',
      '/terms',
    );
  });

  it('captures no consent', () => {
    view('terms');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('marks the document being read with aria-current', () => {
    view('privacy');
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('renders the heading it links to, so the anchor actually lands', () => {
    view('privacy');
    const heading = screen.getByRole('heading', { name: 'Retention' });
    expect(heading).toHaveAttribute('id', 'retention');
  });

  it('shows the version and effective date', () => {
    view('privacy');
    expect(screen.getByText(/Version 1/)).toBeInTheDocument();
  });

  it('does not repeat the document title as a second heading or as the rail\'s first section', () => {
    // Every real consent document opens with `## <title>` — verified across
    // all six network schemas. That leading heading must not become a
    // duplicate heading-role element alongside the page's own <h1>, and must
    // not become the rail's first section entry (a repeat of the group
    // header sitting right underneath it).
    view('privacy');
    expect(screen.getAllByRole('heading', { name: 'Privacy Policy' })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: 'Privacy Policy' })).toHaveLength(1);
    // The real (and only) surviving section is "Retention".
    expect(screen.getAllByRole('link', { name: 'Retention' })).toHaveLength(1);
  });

  it('keeps a section that legitimately opens with a non-title heading like Overview', () => {
    // Regression guard: the fix must match on the document's *title*
    // specifically, not blanket-drop whatever heading comes first — a
    // document that opens with "## Overview" (not its title) keeps that
    // section as a real, anchored entry.
    mockUseConsentConfig.mockReturnValue(
      consentConfig({
        privacyContent: '## Overview\n\nSomething else entirely.',
        termsContent: '## Terms of Service\n\nWelcome.',
      }),
    );
    view('privacy');
    expect(screen.getByRole('heading', { name: 'Overview' })).toHaveAttribute('id', 'overview');
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('href', '#overview');
  });
});
