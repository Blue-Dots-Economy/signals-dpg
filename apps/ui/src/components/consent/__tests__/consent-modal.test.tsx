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
 *
 * Stubbed via `getBoundingClientRect`, NOT `offsetTop`/`offsetHeight` — see
 * the equivalent note in `consent-gate.test.tsx`: offsetTop is relative to
 * the nearest *positioned* ancestor (this dialog's own `fixed` wrapper, not
 * the scroller), which made the gate permanently unreachable in every real
 * browser while offsetTop-based stubs here stayed green.
 */
const READER_VIEWPORT_TOP = 149;

function stubRect(el: Element, top: number, height: number) {
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () =>
      ({
        top,
        height,
        bottom: top + height,
        left: 0,
        right: 0,
        width: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
    configurable: true,
  });
}

function stubReader(scrollTop: number) {
  const el = screen.getByTestId('consent-reader');
  Object.defineProperty(el, 'scrollHeight', { value: 600, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
  Object.defineProperty(el, 'scrollTop', { value: scrollTop, writable: true, configurable: true });
  stubRect(el, READER_VIEWPORT_TOP, 200);
  const privacy = el.querySelector<HTMLElement>('[data-consent-section="privacy"]')!;
  stubRect(privacy, READER_VIEWPORT_TOP + 0 - scrollTop, 300);
  const terms = el.querySelector<HTMLElement>('[data-consent-section="terms"]')!;
  stubRect(terms, READER_VIEWPORT_TOP + 300 - scrollTop, 300);
  fireEvent.scroll(el);
  return el;
}

// scrollTop 400 puts the viewport bottom past both 300px sections stacked in
// a 600px-tall document behind a 200px-tall viewport -- fully read.
function stubReaderAsFullyRead() {
  return stubReader(400);
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

    // Fix round 3 regression pin: with REAL (non-zero, getBoundingClientRect
    // -based) geometry and the reader genuinely NOT yet scrolled, the
    // checkbox must stay locked. This is the assertion the earlier version
    // of this test never made -- it went straight to stubReaderAsFullyRead()
    // and only ever checked the unlocked side, which an offsetTop-based
    // regression (reading position relative to the dialog's own `fixed`
    // wrapper instead of the scroller) would have passed anyway, by
    // coincidence, at every scroll position.
    stubReader(0);
    expect(screen.getByRole('checkbox')).toBeDisabled();

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

  /**
   * Keyboard reachability regression guard. Fix round 1 found that with the
   * checkbox/button disabled and no close button, Radix's own
   * `@radix-ui/react-focus-scope` (unmocked here — this exercises the real
   * library, not a stand-in) found no tabbable candidate on open and fell
   * back to focusing the outer, non-scrollable dialog wrapper, actively
   * swallowing Tab. This asserts the actual consequence of that autofocus
   * pass: `document.activeElement` must be the reader itself once the gate
   * dialog opens. This is genuine evidence, not an assertion of intent —
   * before the `tabIndex={0}` fix on `consent-reader`, this test failed with
   * `document.activeElement` pointing at `[data-slot="dialog-content"]`
   * instead (confirmed by hand while diagnosing the bug).
   *
   * What this test does NOT prove: that pressing the physical Tab key
   * cycles focus in a real browser. happy-dom/jsdom do not implement the
   * browser's native Tab-key focus-traversal algorithm, so a `fireEvent`
   * Tab keydown here would not exercise that path — only Radix's own
   * FocusScope effects (autofocus-on-mount, and its keydown handler used
   * for *cycling once already inside*) run for real. The autofocus part is
   * exactly the part that was broken, and is what's asserted below.
   */
  it('gives keyboard focus to the reading pane on open, not the non-scrollable wrapper', () => {
    render(<ConsentModal open mode="gate" initialTab="privacy" config={config} />);
    const reader = screen.getByTestId('consent-reader');
    expect(document.activeElement).toBe(reader);
  });

  /**
   * Structural companion to the test above: the reader must actually be a
   * tab stop (positive `tabIndex`, not `-1` — `-1` is reachable exactly once
   * via an imperative `.focus()` but drops out of the Tab sequence, so a
   * user who tabs forward to the checkbox could never tab back to keep
   * reading) and must announce as a named landmark rather than an anonymous
   * scroller.
   */
  it('makes the reading pane a real, named tab stop', () => {
    render(<ConsentModal open mode="gate" initialTab="privacy" config={config} />);
    const reader = screen.getByTestId('consent-reader');
    expect(reader).toHaveAttribute('tabindex', '0');
    expect(reader).toHaveAttribute('role', 'region');
    expect(reader.getAttribute('aria-label')).toBeTruthy();
  });
});
