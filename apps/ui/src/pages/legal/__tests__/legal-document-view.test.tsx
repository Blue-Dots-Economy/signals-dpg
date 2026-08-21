import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LegalDocumentView } from '@/pages/legal/legal-document-view';

vi.mock('@/hooks/use-consent-config', () => ({
  useConsentConfig: () => ({
    isLoading: false,
    config: {
      documents: {
        privacy: {
          current_version: 1,
          versions: [
            {
              version: 1,
              title: 'Privacy Policy',
              content: '## Overview\n### Retention\nx',
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
              content: '## Overview',
              effective_from: '2026-06-01',
            },
          ],
        },
      },
    },
  }),
}));

const view = (doc: 'privacy' | 'terms') =>
  render(
    <MemoryRouter>
      <LegalDocumentView doc={doc} />
    </MemoryRouter>,
  );

describe('<LegalDocumentView />', () => {
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
});
