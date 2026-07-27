import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
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
});
