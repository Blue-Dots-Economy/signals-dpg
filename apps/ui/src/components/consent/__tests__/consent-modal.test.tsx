import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConsentConfigDocument } from '@dpg/schemas';
import { ConsentModal } from '@/components/consent/consent-modal';

// Defaults to desktop (false) so every pre-existing test below keeps
// exercising the real Dialog path unchanged; only the mobile-parity describe
// block at the bottom flips this to true.
const isMobile = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => isMobile.value }));

const config: ConsentConfigDocument = {
  documents: {
    privacy: {
      current_version: 1,
      versions: [
        {
          version: 1,
          title: 'Privacy Policy v1',
          content: 'We respect your privacy.',
          effective_from: '2024-01-01',
        },
      ],
    },
    terms: {
      current_version: 1,
      versions: [
        {
          version: 1,
          title: 'Terms of Service v1',
          content: 'By using this service you agree to these terms.',
          effective_from: '2024-01-01',
        },
      ],
    },
    profile_creation: {
      current_version: 1,
      versions: [
        {
          version: 1,
          statement: 'I agree to create a profile.',
          effective_from: '2024-01-01',
        },
      ],
    },
  },
  u18_documents: {
    privacy: {
      current_version: 1,
      versions: [
        {
          version: 1,
          title: 'U18 Privacy Policy',
          content: 'Guardian-facing privacy notice for minors.',
          effective_from: '2024-01-01',
        },
      ],
    },
    terms: {
      current_version: 1,
      versions: [
        {
          version: 1,
          title: 'U18 Terms of Service',
          content: 'Guardian-facing terms for minors.',
          effective_from: '2024-01-01',
        },
      ],
    },
    profile_creation: {
      current_version: 1,
      versions: [
        {
          version: 1,
          statement: 'Guardian agrees to the minor profile creation.',
          effective_from: '2024-01-01',
        },
      ],
    },
    guardian_declaration: {
      current_version: 1,
      versions: [
        {
          version: 1,
          statement: 'I declare I am the legal guardian.',
          effective_from: '2024-01-01',
        },
      ],
    },
  },
};

/**
 * Gate mode now delegates to `ConsentGateBody`, which gates the checkbox on
 * scroll-read progress (see `read-progress.ts`), not just on the checkbox
 * itself. happy-dom performs no real layout (0x0 geometry by default), so
 * these tests stub the scroller as fully read — the same technique
 * `consent-gate.test.tsx`'s `stubScroller(400)` case uses — to reach the
 * "unlocked" state deterministically before exercising the checkbox/button.
 */
function stubReaderAsFullyRead() {
  const el = screen.getByTestId('consent-reader');
  Object.defineProperty(el, 'scrollHeight', { value: 600, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
  Object.defineProperty(el, 'scrollTop', { value: 400, writable: true, configurable: true });
  const privacy = el.querySelector<HTMLElement>('[data-consent-section="privacy"]')!;
  Object.defineProperty(privacy, 'offsetTop', { value: 0, configurable: true });
  Object.defineProperty(privacy, 'offsetHeight', { value: 300, configurable: true });
  const terms = el.querySelector<HTMLElement>('[data-consent-section="terms"]')!;
  Object.defineProperty(terms, 'offsetTop', { value: 300, configurable: true });
  Object.defineProperty(terms, 'offsetHeight', { value: 300, configurable: true });
  fireEvent.scroll(el);
  return el;
}

describe('ConsentModal — gate mode', () => {
  it('Accept button is disabled until checkbox is checked, then enabled', async () => {
    const user = userEvent.setup();
    const onAccept = vi.fn();

    render(
      <ConsentModal
        open
        mode="gate"
        initialTab="privacy"
        config={config}
        onAccept={onAccept}
        onOpenChange={vi.fn()}
      />,
    );

    const acceptBtn = screen.getByRole('button', { name: /accept/i });
    expect(acceptBtn).toBeDisabled();

    stubReaderAsFullyRead();

    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeEnabled();
    await user.click(checkbox);

    expect(acceptBtn).not.toBeDisabled();
  });

  it('clicking Accept calls onAccept after reading to the end and checking the checkbox', async () => {
    const user = userEvent.setup();
    const onAccept = vi.fn();

    render(
      <ConsentModal
        open
        mode="gate"
        initialTab="privacy"
        config={config}
        onAccept={onAccept}
        onOpenChange={vi.fn()}
      />,
    );

    stubReaderAsFullyRead();

    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);

    const acceptBtn = screen.getByRole('button', { name: /accept/i });
    await user.click(acceptBtn);

    expect(onAccept).toHaveBeenCalledOnce();
  });

  it('shows every document in one continuous scroll rather than tabs', () => {
    render(
      <ConsentModal
        open
        mode="gate"
        initialTab="privacy"
        config={config}
        onAccept={vi.fn()}
        onOpenChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.getByText('We respect your privacy.')).toBeInTheDocument();
    expect(
      screen.getByText('By using this service you agree to these terms.'),
    ).toBeInTheDocument();
  });
});

describe('ConsentModal — view mode', () => {
  it('does not render checkbox or Accept button', () => {
    render(
      <ConsentModal
        open
        mode="view"
        initialTab="terms"
        config={config}
        onOpenChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /accept/i })).toBeNull();
  });

  it('shows document content in the initially selected tab', () => {
    render(
      <ConsentModal
        open
        mode="view"
        initialTab="terms"
        config={config}
        onOpenChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText('By using this service you agree to these terms.'),
    ).toBeInTheDocument();
  });
});

describe('ConsentModal — mobile (Drawer) dismissal parity', () => {
  afterEach(() => {
    isMobile.value = false;
  });

  it('view mode on mobile shows a close control that closes the sheet', () => {
    isMobile.value = true;
    const onOpenChange = vi.fn();

    const { baseElement } = render(
      <ConsentModal
        open
        mode="view"
        initialTab="terms"
        config={config}
        onOpenChange={onOpenChange}
      />,
    );

    expect(baseElement.querySelector('[data-slot="drawer-content"]')).toBeTruthy();
    const closeButton = baseElement.querySelector('[data-slot="drawer-close"]') as HTMLElement | null;
    expect(closeButton).toBeTruthy();

    fireEvent.click(closeButton!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('gate mode on mobile has no close control and cannot be dismissed via Escape', () => {
    isMobile.value = true;
    const onOpenChange = vi.fn();

    const { baseElement } = render(
      <ConsentModal
        open
        mode="gate"
        initialTab="privacy"
        config={config}
        onAccept={vi.fn()}
        onOpenChange={onOpenChange}
      />,
    );

    expect(baseElement.querySelector('[data-slot="drawer-content"]')).toBeTruthy();
    expect(baseElement.querySelector('[data-slot="drawer-close"]')).toBeFalsy();

    const content = baseElement.querySelector('[data-slot="drawer-content"]') as HTMLElement;
    fireEvent.keyDown(content, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe('gate mode uses the guided read', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  it('renders no tabs in gate mode', () => {
    render(<ConsentModal open mode="gate" initialTab="privacy" config={config} />);
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.getByTestId('consent-reader')).toBeInTheDocument();
  });

  it('still renders tabs in view mode', () => {
    render(
      <ConsentModal open mode="view" initialTab="privacy" config={config} onOpenChange={vi.fn()} />,
    );
    expect(screen.getAllByRole('tab').length).toBeGreaterThan(0);
  });

  it('shows the U18 documents when variant is u18, not the adult ones', () => {
    render(<ConsentModal open mode="gate" initialTab="privacy" config={config} variant="u18" />);
    expect(screen.getByTestId('consent-reader')).toBeInTheDocument();

    // U18-specific content from the fixture must be present...
    expect(screen.getByText('U18 Privacy Policy')).toBeInTheDocument();
    expect(
      screen.getByText('Guardian-facing privacy notice for minors.'),
    ).toBeInTheDocument();
    expect(screen.getByText('U18 Terms of Service')).toBeInTheDocument();
    expect(screen.getByText('Guardian-facing terms for minors.')).toBeInTheDocument();

    // ...and the adult document set's content must NOT be, or this would only
    // prove the reader renders *something*, not that it picked the right set.
    expect(screen.queryByText('Privacy Policy v1')).not.toBeInTheDocument();
    expect(screen.queryByText('We respect your privacy.')).not.toBeInTheDocument();
    expect(screen.queryByText('Terms of Service v1')).not.toBeInTheDocument();
    expect(
      screen.queryByText('By using this service you agree to these terms.'),
    ).not.toBeInTheDocument();
  });
});
