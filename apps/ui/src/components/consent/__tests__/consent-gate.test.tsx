import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from '@/i18n';
import { ConsentGateBody } from '@/components/consent/consent-gate';

const docs = [
  { id: 'privacy', cap: 'Privacy', title: 'Privacy Policy', body: 'Privacy body' },
  { id: 'terms', cap: 'Terms', title: 'Terms of Service', body: 'Terms body' },
];

/**
 * happy-dom (this repo's Vitest environment — see the note in
 * read-progress.ts) performs no real layout, so an unstubbed scroller reads
 * 0x0 and computeReadProgress treats that as "unmeasured", not "unscrollable".
 * Stub geometry to exercise the locked/unlocked paths deliberately.
 *
 * Stubbed via `getBoundingClientRect`, NOT `offsetTop`/`offsetHeight`: fix
 * round 3 found the real implementation had been measuring with offsetTop,
 * which is relative to the nearest *positioned* ancestor -- the dialog's own
 * `fixed` wrapper here, not the scroller -- and made the gate permanently
 * unreachable in every real browser while these very stubs (which set
 * offsetTop directly, in the scroller's own coordinate space) stayed green.
 * A `getBoundingClientRect`-based stub is honest about which space the
 * browser actually reports geometry in.
 */

/**
 * Viewport distance from the dialog's top edge to the reader, in a real
 * desktop dialog (header + progress tracker + border + padding) --
 * matches production geometry measured directly in Chromium (see
 * task-3-report.md, fix round 3). Non-zero and reused for every section, so
 * a regression back to reading raw offsetTop (dialog-relative, i.e. this
 * same constant added into every section's top) would show up as every
 * section becoming permanently unreadable, not as a silently-passing test.
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

function stubScroller(scrollTop: number) {
  const el = screen.getByTestId('consent-reader');
  Object.defineProperty(el, 'scrollHeight', { value: 600, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
  Object.defineProperty(el, 'scrollTop', { value: scrollTop, writable: true, configurable: true });
  stubRect(el, READER_VIEWPORT_TOP, 200);
  docs.forEach((d, i) => {
    const s = el.querySelector<HTMLElement>(`[data-consent-section="${d.id}"]`)!;
    const contentTop = i * 300;
    // Viewport top = reader's own viewport top + this section's position in
    // the (unscrolled) content, minus however much has already been
    // scrolled -- the same relationship read-progress.ts's measure() inverts.
    stubRect(s, READER_VIEWPORT_TOP + contentTop - scrollTop, 300);
  });
  return el;
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

describe('<ConsentGateBody />', () => {
  it('keeps the checkbox and CTA locked until the end is reached', () => {
    render(<ConsentGateBody docs={docs} onAccept={vi.fn()} />);
    fireEvent.scroll(stubScroller(0));
    // `aria-disabled`, not `disabled`: the controls stay in the accessibility
    // tree so a screen-reader user can land on them and hear why they are
    // locked. Enforcement is the handler guard, asserted below.
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: /accept/i })).toHaveAttribute('aria-disabled', 'true');
  });

  it('unlocks the checkbox at the end, then the CTA once ticked', () => {
    const onAccept = vi.fn();
    render(<ConsentGateBody docs={docs} onAccept={onAccept} />);
    fireEvent.scroll(stubScroller(400));

    const box = screen.getByRole('checkbox');
    expect(box).toHaveAttribute('aria-disabled', 'false');
    const cta = screen.getByRole('button', { name: /accept/i });
    expect(cta).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(box);
    expect(cta).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(cta);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('treats content shorter than the viewport as read', () => {
    render(
      <ConsentGateBody
        docs={[{ id: 'terms', cap: 'Terms', title: 'Terms', body: 'Short.' }]}
        onAccept={vi.fn()}
      />,
    );
    // A short, unscrollable document: clientHeight > 0 with
    // scrollHeight <= clientHeight, the real-browser geometry for content
    // that fits without scrolling. Deliberately NOT left at the default 0x0 —
    // computeReadProgress treats 0x0 as unmeasured (nothing read), not
    // unscrollable (all read), because read state is sticky and a premature
    // 0x0 measurement would open the gate before it has been laid out at all.
    const el = screen.getByTestId('consent-reader');
    Object.defineProperty(el, 'scrollHeight', { value: 100, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
    stubRect(el, READER_VIEWPORT_TOP, 200);
    const section = el.querySelector<HTMLElement>('[data-consent-section="terms"]')!;
    stubRect(section, READER_VIEWPORT_TOP, 100);
    fireEvent.scroll(el);

    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-disabled', 'false');
  });

  /**
   * The security half of the `disabled` -> `aria-disabled` change made for
   * WCAG 2.2 4.1.3 (a locked control must stay in the accessibility tree so a
   * screen-reader user can discover WHY they cannot proceed).
   *
   * `aria-disabled` is advisory only: unlike `disabled` it does NOT prevent
   * activation, so the element is genuinely clickable and keyboard-activatable
   * while locked. If the handlers were not guarded, this change would hand
   * everyone a one-click bypass of the very gate the feature exists to
   * enforce — strictly worse than the inline checkbox it replaced. These two
   * tests are what stop that: they drive the controls exactly as a user could,
   * and assert nothing happens.
   */
  it('cannot be accepted by clicking the locked CTA before reading', () => {
    const onAccept = vi.fn();
    render(<ConsentGateBody docs={docs} onAccept={onAccept} />);
    fireEvent.scroll(stubScroller(0));

    fireEvent.click(screen.getByRole('button', { name: /accept/i }));

    expect(onAccept).not.toHaveBeenCalled();
  });

  it('cannot be ticked by clicking the locked checkbox before reading', () => {
    render(<ConsentGateBody docs={docs} onAccept={vi.fn()} />);
    fireEvent.scroll(stubScroller(0));

    const box = screen.getByRole('checkbox');
    fireEvent.click(box);

    // Still unchecked, and the CTA still refuses — a bypass would need both.
    expect(box).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: /accept/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('announces the unlock to screen readers via a live region', () => {
    render(<ConsentGateBody docs={docs} onAccept={vi.fn()} />);
    fireEvent.scroll(stubScroller(0));

    const hint = document.getElementById('consent-scroll-hint');
    expect(hint).not.toBeNull();
    expect(hint).toHaveAttribute('aria-live', 'polite');
    // Both controls point at it, so a locked control explains itself rather
    // than being an unexplained dead end.
    expect(screen.getByRole('checkbox')).toHaveAttribute(
      'aria-describedby',
      'consent-scroll-hint',
    );
    expect(screen.getByRole('button', { name: /accept/i })).toHaveAttribute(
      'aria-describedby',
      'consent-scroll-hint',
    );

    const locked = hint!.textContent;
    fireEvent.scroll(stubScroller(400));
    // The same live region now carries the unlocked message, so the transition
    // is announced rather than happening silently.
    expect(hint!.textContent).not.toBe(locked);
  });

  it('renders every document in one scroll region rather than tabs', () => {
    render(<ConsentGateBody docs={docs} onAccept={vi.fn()} />);
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    const reader = screen.getByTestId('consent-reader');
    expect(reader.querySelectorAll('[data-consent-section]')).toHaveLength(2);
  });

  it('prefers the consent.cap_* translation over the doc-supplied fallback label', () => {
    // consent-progress-tracker.tsx looks up `consent.cap_<id>` and falls back
    // to the doc's own `cap` only when the key is missing. Use a fallback
    // that differs from the translation so a pass can only mean the key won.
    expect(i18n.exists('consent.cap_privacy')).toBe(true);
    expect(i18n.t('consent.cap_privacy')).toBe('Privacy');

    render(
      <ConsentGateBody
        docs={[
          { id: 'privacy', cap: 'Fallback Privacy Label', title: 'Privacy Policy', body: 'Privacy body' },
          { id: 'terms', cap: 'Fallback Terms Label', title: 'Terms of Service', body: 'Terms body' },
        ]}
        onAccept={vi.fn()}
      />,
    );

    expect(screen.getByText('Privacy')).toBeInTheDocument();
    expect(screen.getByText('Terms')).toBeInTheDocument();
    expect(screen.queryByText('Fallback Privacy Label')).not.toBeInTheDocument();
    expect(screen.queryByText('Fallback Terms Label')).not.toBeInTheDocument();
  });
});
