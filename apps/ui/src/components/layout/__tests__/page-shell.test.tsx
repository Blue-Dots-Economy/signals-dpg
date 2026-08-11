import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageShell } from '../page-shell';

// PageShell composes TopBar/AppSidebar, which pull in auth, i18n, routing and
// data-fetching hooks that aren't relevant to this test — stub them out so
// this file only exercises the shell's own overflow-containment classes and
// its prop pass-through to TopBar.
vi.mock('../top-bar', () => ({
  TopBar: (props: { variant?: string; title?: string }) => (
    <div data-testid="top-bar" data-variant={props.variant} data-title={props.title} />
  ),
}));
vi.mock('../sidebar', () => ({
  AppSidebar: () => <div data-testid="app-sidebar" />,
}));

function renderShell() {
  return render(
    <PageShell
      domains={[]}
      selectedDomain={null}
      onDomainSelect={() => {}}
      search=""
      onSearchChange={() => {}}
      viewMode="list"
      onViewModeChange={() => {}}
    >
      <div>content</div>
    </PageShell>,
  );
}

// jsdom doesn't compute real layout (no box model / scrollWidth), so this is
// a structural, class-level assertion: it confirms the overflow-containment
// classes described in the mobile-no-horizontal-scroll fix are present on the
// right elements, not that scrollWidth stays within the viewport at runtime
// (that was verified manually against the dev server at 320/390/768/1280px).
describe('PageShell overflow containment (mobile no-horizontal-scroll)', () => {
  it('gives the content column min-w-0 so a wide child cannot widen the sidebar row', () => {
    renderShell();
    const column = screen.getByTestId('top-bar').parentElement;
    expect(column).toHaveClass('flex', 'h-svh', 'min-w-0', 'flex-1', 'flex-col');
  });

  it('clips residual horizontal overflow in <main> on mobile only, leaving desktop unclipped', () => {
    renderShell();
    const main = document.getElementById('main-content');
    expect(main).toHaveClass('max-md:overflow-x-clip');
    // Desktop (md+) must not clip: no bare `overflow-x-clip` / `overflow-x-hidden`.
    expect(main).not.toHaveClass('overflow-x-clip');
    expect(main).not.toHaveClass('overflow-x-hidden');
  });
});

describe('PageShell form variant pass-through', () => {
  it('forwards form variant + title to TopBar and renders children + sidebar', () => {
    render(
      <PageShell
        variant="form"
        title="Edit Provider Profile"
        onBack={() => {}}
        domains={[]}
        selectedDomain={null}
        onDomainSelect={() => {}}
      >
        <div data-testid="child" />
      </PageShell>,
    );
    const bar = screen.getByTestId('top-bar');
    expect(bar.getAttribute('data-variant')).toBe('form');
    expect(bar.getAttribute('data-title')).toBe('Edit Provider Profile');
    expect(screen.getByTestId('app-sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });
});
