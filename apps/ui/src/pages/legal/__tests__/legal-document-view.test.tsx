import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

const view = (doc: 'privacy' | 'terms', initialEntries?: string[]) =>
  render(
    <MemoryRouter initialEntries={initialEntries ?? [doc === 'privacy' ? '/privacy' : '/terms']}>
      <LegalDocumentView doc={doc} />
    </MemoryRouter>,
  );

describe('<LegalDocumentView />', () => {
  beforeEach(() => {
    mockUseConsentConfig.mockReturnValue(REAL_SHAPE);
  });

  it('renders both documents in order on both routes', () => {
    view('privacy');
    expect(screen.getAllByText('Privacy Policy').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Terms of Service').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Privacy Policy' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Terms of Service' })).toBeInTheDocument();
  });

  it('renders both documents in order on the /terms route too', () => {
    view('terms');
    expect(screen.getByRole('heading', { name: 'Privacy Policy' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Terms of Service' })).toBeInTheDocument();
  });

  it('anchors each extracted section', () => {
    view('privacy');
    expect(screen.getByRole('link', { name: 'Retention' })).toHaveAttribute('href', '#retention');
  });

  it('rail entries are same-page anchors, not links to another route', () => {
    view('privacy');
    // The other document's rail header used to navigate via a react-router
    // <Link to="/terms">. Both documents now live on the same page, so it
    // must be a same-page anchor instead.
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute(
      'href',
      '#terms-document',
    );
  });

  it('captures no consent', () => {
    view('terms');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('marks the routed document current on arrival, before any scrolling', () => {
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

  it('shows the version and effective date for each document', () => {
    view('privacy');
    expect(screen.getAllByText(/Version 1/).length).toBe(2);
  });

  it('does not repeat the document title as a second heading or as the rail\'s first section', () => {
    // Every real consent document opens with `## <title>` — verified across
    // all six network schemas. That leading heading must not become a
    // duplicate heading-role element, and must not become the rail's first
    // section entry (a repeat of the group header sitting right underneath
    // it).
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

  it('renders a document with no ### headings at all, without crashing', () => {
    mockUseConsentConfig.mockReturnValue(
      consentConfig({
        privacyContent: '## Privacy Policy\n\nJust a paragraph, no subsections at all.',
        termsContent: '## Terms of Service\n\nWelcome.',
      }),
    );
    view('privacy');
    expect(screen.getByText('Just a paragraph, no subsections at all.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Privacy Policy' })).toBeInTheDocument();
  });

  it('renders a document with five levels of heading nesting, without crashing', () => {
    mockUseConsentConfig.mockReturnValue(
      consentConfig({
        privacyContent:
          '## Privacy Policy\n\n### A section\nintro\n#### A subsection\nmore\n##### Deeper still\neven more\n###### Deepest\ndeepest text',
        termsContent: '## Terms of Service\n\nWelcome.',
      }),
    );
    view('privacy');
    expect(screen.getByRole('heading', { name: 'A section' })).toBeInTheDocument();
    expect(screen.getByText('deepest text')).toBeInTheDocument();
  });

  it('renumbers colliding section ids across documents instead of duplicating them', () => {
    // Nothing about section names is meant to be hardcoded; if the two
    // documents happen to share a heading, both must still get a unique,
    // resolvable id rather than two elements answering to the same anchor.
    mockUseConsentConfig.mockReturnValue(
      consentConfig({
        privacyContent: '## Privacy Policy\n\nIntro.\n### Shared Heading\nFrom privacy.',
        termsContent: '## Terms of Service\n\nWelcome.\n### Shared Heading\nFrom terms.',
      }),
    );
    view('privacy');
    const headings = screen.getAllByRole('heading', { name: 'Shared Heading' });
    expect(headings).toHaveLength(2);
    const ids = headings.map((h) => h.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain('shared-heading');
    expect(ids).toContain('shared-heading-2');

    const links = screen.getAllByRole('link', { name: 'Shared Heading' });
    expect(links.map((l) => l.getAttribute('href')).sort()).toEqual([
      '#shared-heading',
      '#shared-heading-2',
    ]);
  });

  it('uses the i18n contents label for the rail, not a hardcoded string', () => {
    view('privacy');
    expect(screen.getByRole('navigation', { name: 'Contents' })).toBeInTheDocument();
  });

  it('has a back-to-sign-in link', () => {
    view('privacy');
    expect(screen.getByRole('link', { name: /Back to sign in/i })).toHaveAttribute(
      'href',
      '/auth/login',
    );
  });

  it('clicking a rail section scrolls it into view and highlights it', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
    view('privacy');

    const link = screen.getByRole('link', { name: 'Retention' });
    fireEvent.click(link);

    expect(scrollIntoView).toHaveBeenCalled();
    expect(link).toHaveAttribute('aria-current', 'true');
  });

  it('clicking the other document\'s rail header scrolls to its heading and highlights it', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
    view('privacy');

    const termsHeader = screen.getByRole('link', { name: 'Terms of Service' });
    fireEvent.click(termsHeader);

    expect(scrollIntoView).toHaveBeenCalled();
    expect(termsHeader).toHaveAttribute('aria-current', 'page');
  });
});

describe('<LegalDocumentView /> deep-link and arrival scrolling', () => {
  let scrollIntoView: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
  });

  it('scrolls the hash target into view once its section has rendered', () => {
    mockUseConsentConfig.mockReturnValue(REAL_SHAPE);
    render(
      <MemoryRouter initialEntries={['/privacy#retention']}>
        <LegalDocumentView doc="privacy" />
      </MemoryRouter>,
    );
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it('scrolls once content arrives after mount, even though the hash was already set (cold-load ordering)', () => {
    // Reproduces a cold `/privacy#retention` load: the consent-config fetch
    // resolves well after the browser's own one-shot fragment-scroll attempt
    // has already run and found nothing — so the effect must fire again when
    // the CONTENT shows up, not only when the hash changes. An effect keyed
    // on `location.hash` alone would miss this case entirely: the hash here
    // never changes — it's present from the very first render, while
    // `isLoading` is still true.
    mockUseConsentConfig.mockReturnValue({ isLoading: true, config: null });
    const { rerender } = render(
      <MemoryRouter initialEntries={['/privacy#retention']}>
        <LegalDocumentView doc="privacy" />
      </MemoryRouter>,
    );
    expect(scrollIntoView).not.toHaveBeenCalled();

    // The fetch resolves; same hash, content now available.
    mockUseConsentConfig.mockReturnValue(REAL_SHAPE);
    rerender(
      <MemoryRouter initialEntries={['/privacy#retention']}>
        <LegalDocumentView doc="privacy" />
      </MemoryRouter>,
    );

    expect(scrollIntoView).toHaveBeenCalled();
  });

  it('does nothing on /privacy with no hash — it is already the top of the page', () => {
    mockUseConsentConfig.mockReturnValue(REAL_SHAPE);
    render(
      <MemoryRouter initialEntries={['/privacy']}>
        <LegalDocumentView doc="privacy" />
      </MemoryRouter>,
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('scrolls to the terms document heading when arriving at /terms with no hash', () => {
    mockUseConsentConfig.mockReturnValue(REAL_SHAPE);
    render(
      <MemoryRouter initialEntries={['/terms']}>
        <LegalDocumentView doc="terms" />
      </MemoryRouter>,
    );
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it('lands on the right heading for a /terms deep link', () => {
    mockUseConsentConfig.mockReturnValue(
      consentConfig({
        privacyContent: '## Privacy Policy\n\nIntro.',
        termsContent: '## Terms of Service\n\nWelcome.\n### Governing law\nIndia.',
      }),
    );
    render(
      <MemoryRouter initialEntries={['/terms#governing-law']}>
        <LegalDocumentView doc="terms" />
      </MemoryRouter>,
    );
    expect(scrollIntoView).toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Governing law' })).toHaveAttribute(
      'id',
      'governing-law',
    );
  });
});
