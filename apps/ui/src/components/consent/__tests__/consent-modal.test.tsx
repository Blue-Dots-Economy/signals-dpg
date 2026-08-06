import { afterEach, describe, it, expect, vi } from 'vitest';
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
};

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

    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);

    expect(acceptBtn).not.toBeDisabled();
  });

  it('clicking Accept calls onAccept after checking the checkbox', async () => {
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

    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);

    const acceptBtn = screen.getByRole('button', { name: /accept/i });
    await user.click(acceptBtn);

    expect(onAccept).toHaveBeenCalledOnce();
  });

  it('switching tabs shows the other document content', async () => {
    const user = userEvent.setup();

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

    // Privacy tab is active by default — its content should be visible
    expect(screen.getByText('We respect your privacy.')).toBeInTheDocument();

    // Click Terms tab
    const termsTab = screen.getByRole('tab', { name: /terms of service/i });
    await user.click(termsTab);

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
