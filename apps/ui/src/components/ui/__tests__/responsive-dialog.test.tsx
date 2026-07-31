import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResponsiveDialog } from '../responsive-dialog';

const isMobile = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => isMobile.value }));

describe('ResponsiveDialog', () => {
  it('renders a Dialog on desktop', () => {
    isMobile.value = false;
    const { baseElement } = render(
      <ResponsiveDialog open onOpenChange={() => {}}><p>body</p></ResponsiveDialog>,
    );
    expect(baseElement.querySelector('[data-slot="dialog-content"]')).toBeTruthy();
    expect(baseElement.querySelector('[data-slot="drawer-content"]')).toBeFalsy();
  });

  it('renders a Drawer on mobile', () => {
    isMobile.value = true;
    const { baseElement } = render(
      <ResponsiveDialog open onOpenChange={() => {}}><p>body</p></ResponsiveDialog>,
    );
    expect(baseElement.querySelector('[data-slot="drawer-content"]')).toBeTruthy();
    expect(baseElement.querySelector('[data-slot="dialog-content"]')).toBeFalsy();
  });

  it('forwards the escape guard to the mobile Drawer so a guarded sheet cannot be dismissed via Escape', () => {
    isMobile.value = true;
    const onOpenChange = vi.fn();
    const onEscapeKeyDown = vi.fn((e: Event) => e.preventDefault());
    const { baseElement } = render(
      <ResponsiveDialog
        open
        onOpenChange={onOpenChange}
        onEscapeKeyDown={onEscapeKeyDown}
      >
        <p>body</p>
      </ResponsiveDialog>,
    );

    const content = baseElement.querySelector('[data-slot="drawer-content"]') as HTMLElement;
    fireEvent.keyDown(content, { key: 'Escape' });

    // The guard callback must actually be wired to the underlying radix
    // Dialog.Content (not silently dropped by the Drawer branch), and since it
    // calls preventDefault, the Drawer must not proceed to dismiss.
    expect(onEscapeKeyDown).toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('view-mode-style mobile sheet (dismissible, showCloseButton) renders a working close affordance', () => {
    isMobile.value = true;
    const onOpenChange = vi.fn();
    const { baseElement } = render(
      <ResponsiveDialog
        open
        onOpenChange={onOpenChange}
        dismissible
        showCloseButton
      >
        <p>body</p>
      </ResponsiveDialog>,
    );

    const closeButton = baseElement.querySelector('[data-slot="drawer-close"]') as HTMLElement | null;
    expect(closeButton).toBeTruthy();

    fireEvent.click(closeButton!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('gate-mode-style mobile sheet (dismissible={false}, showCloseButton={false}) has no close affordance', () => {
    isMobile.value = true;
    const onOpenChange = vi.fn();
    const { baseElement } = render(
      <ResponsiveDialog
        open
        onOpenChange={onOpenChange}
        dismissible={false}
        showCloseButton={false}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <p>body</p>
      </ResponsiveDialog>,
    );

    // No X — the user must use the in-content action (e.g. an Accept button)
    // to leave; nothing here should offer an implicit dismiss path.
    expect(baseElement.querySelector('[data-slot="drawer-close"]')).toBeFalsy();

    const content = baseElement.querySelector('[data-slot="drawer-content"]') as HTMLElement;
    fireEvent.keyDown(content, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('wires the `title` prop as the mobile Drawer\'s accessible name (vaul\'s own Title, not the child radix DialogTitle)', () => {
    isMobile.value = true;
    render(
      <ResponsiveDialog open onOpenChange={() => {}} title="Some Title">
        <p>body</p>
      </ResponsiveDialog>,
    );

    // A child radix DialogTitle (from dialog.tsx's OWN @radix-ui/react-dialog
    // instance) would render visible text but never satisfy vaul's
    // aria-labelledby — vaul bundles a different module instance with its own
    // context. Resolving the sheet by accessible name proves the `title` prop
    // is wired through vaul's own DrawerTitle, in the right context.
    expect(screen.getByRole('dialog', { name: 'Some Title' })).toBeTruthy();
  });
});
