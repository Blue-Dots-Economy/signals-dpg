import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// The U18 flow is the one dialog in the app that is deliberately
// non-dismissible — no close button, Escape and outside-click both guarded, and
// `onOpenChange` refuses to close. That makes an unbounded height a trap rather
// than a cosmetic issue: a `fixed`, vertically-centred dialog taller than the
// viewport clips at BOTH ends with no way to scroll and no way to dismiss, and
// the "Not you? Log out" escape hatch is the last child, so it clips first.
//
// Realistically triggered by the on-screen keyboard opening while the guardian
// form is being filled (~250-300px of visible height disappears mid-task), and
// on 320px-class devices and in landscape.
//
// The sibling flow test (`u18-guardian-flow.test.tsx`) covers DOB → guardian →
// OTP, but `useIsMobile()` reads `window.innerWidth`, which defaults to desktop
// width under happy-dom — so it only ever exercises the Dialog branch. This
// file covers the Drawer branch.

const isMobile = vi.hoisted(() => ({ value: true }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => isMobile.value }));

vi.mock('@/lib/consent-api', () => ({
  submitU18Dob: vi.fn(),
  submitGuardian: vi.fn(),
  verifyGuardian: vi.fn(),
}));

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    user: { email: 'ward@example.com', phoneNumber: '+919000000000' },
  }),
}));

// GuardianFormStep reads this for its T&C / Privacy copy; a null config is
// enough here (avoids needing a QueryClient) — this file never opens it.
vi.mock('@/hooks/use-consent-config', () => ({
  useConsentConfig: () => ({ config: null, isLoading: false }),
}));

async function renderFlow() {
  const { U18GuardianFlow } = await import('../u18-guardian-flow');
  return render(
    <U18GuardianFlow
      network="blue_dot"
      brand="standard"
      onComplete={() => {}}
      onNotMinor={() => {}}
      onLogout={() => {}}
    />,
  );
}

describe('U18GuardianFlow — mobile viewport safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isMobile.value = true;
  });

  it('renders as a Drawer on mobile, not a centred Dialog', async () => {
    const { baseElement } = await renderFlow();
    expect(baseElement.querySelector('[data-slot="drawer-content"]')).toBeTruthy();
    expect(baseElement.querySelector('[data-slot="dialog-content"]')).toBeFalsy();
  });

  it('bounds its height with dvh so content cannot overflow an unreachable area', async () => {
    const { baseElement } = await renderFlow();
    const content = baseElement.querySelector('[data-slot="drawer-content"]');
    expect(content?.className).toMatch(/max-h-\[\d+dvh\]/);
    // Raw vh would reintroduce the bug on mobile browsers, where 100vh exceeds
    // the visible viewport.
    expect(content?.className).not.toMatch(/max-h-\[\d+vh\]/);
  });

  it('scrolls its body so a clipped submit button and the logout escape hatch stay reachable', async () => {
    const { baseElement } = await renderFlow();
    const content = baseElement.querySelector('[data-slot="drawer-content"]') as HTMLElement;

    const scroller = content.querySelector('.overflow-y-auto');
    expect(
      scroller,
      'the drawer body must scroll — the drawer itself is overflow-hidden, so without an inner scroller tall content is unreachable',
    ).toBeTruthy();

    // The escape hatch is the last child and therefore the first thing clipped.
    // It has to live INSIDE the scroll container to stay reachable.
    const logout = screen.getByRole('button', { name: /log out/i });
    expect(scroller?.contains(logout)).toBe(true);
  });

  it('stays non-dismissible on mobile — Escape must not close the blocking flow', async () => {
    const { baseElement } = await renderFlow();
    const content = baseElement.querySelector('[data-slot="drawer-content"]') as HTMLElement;

    fireEvent.keyDown(content, { key: 'Escape' });

    // Still mounted: a minor must not be able to dismiss the guardian gate.
    expect(baseElement.querySelector('[data-slot="drawer-content"]')).toBeTruthy();
  });

  it('gives the mobile sheet an accessible name', async () => {
    // vaul bundles its own @radix-ui/react-dialog instance, so a DialogTitle
    // from this repo's dialog.tsx registers against the wrong context and never
    // satisfies DrawerContent's aria-labelledby. ResponsiveDialog's `title`
    // prop exists to close that gap — assert it is actually passed.
    const { baseElement } = await renderFlow();
    const content = baseElement.querySelector('[data-slot="drawer-content"]');
    expect(content?.getAttribute('aria-labelledby')).toBeTruthy();
  });
});
