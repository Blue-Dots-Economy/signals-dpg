import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
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
});
