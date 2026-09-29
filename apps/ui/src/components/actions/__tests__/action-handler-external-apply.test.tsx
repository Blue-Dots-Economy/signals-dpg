import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { DotActionSchema } from '@/engine/types';

// ActionHandler reads useAuth (for the "Log out" escape in GuardianOtpDialog).
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u1' }, signOut: vi.fn() }),
}));

vi.mock('@/lib/action-api', () => ({
  guardianOtpErrorFromThrown: () => null,
}));

// No requirement_schema → the "submit directly" branch, so a single click
// either redirects or submits.
const applySchema = {
  action_type: 'apply',
  from_domain: 'seeker',
  to_domain: 'provider',
  requirement_schema: undefined,
} as unknown as DotActionSchema;

async function renderHandler(
  onActionSubmit: () => Promise<void>,
  resolveExternalUrl?: (type: string, targetItemId: string) => string | null
) {
  const { ActionHandler } = await import('../action-handler');
  render(
    <ActionHandler onActionSubmit={onActionSubmit} resolveExternalUrl={resolveExternalUrl}>
      {(triggerAction) => (
        <button onClick={() => triggerAction('apply', applySchema, 'job-1')}>Apply</button>
      )}
    </ActionHandler>
  );
}

describe('ActionHandler partner-portal Apply', () => {
  let open: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    open = vi.spyOn(window, 'open').mockReturnValue(null);
  });
  afterEach(() => vi.restoreAllMocks());

  it('opens the partner URL in a new tab and submits nothing', async () => {
    const onActionSubmit = vi.fn().mockResolvedValue(undefined);
    const resolve = vi.fn().mockReturnValue('https://ncs.gov.in/job-listing/applying/2987726');
    await renderHandler(onActionSubmit, resolve);

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(resolve).toHaveBeenCalledWith('apply', 'job-1');
    expect(open).toHaveBeenCalledWith(
      'https://ncs.gov.in/job-listing/applying/2987726',
      '_blank',
      'noopener,noreferrer'
    );
    expect(onActionSubmit).not.toHaveBeenCalled();
  });

  it('falls back to the in-app flow when the resolver returns null', async () => {
    const onActionSubmit = vi.fn().mockResolvedValue(undefined);
    await renderHandler(onActionSubmit, () => null);

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(open).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onActionSubmit).toHaveBeenCalled());
  });

  it('keeps the in-app flow when no resolver is passed', async () => {
    const onActionSubmit = vi.fn().mockResolvedValue(undefined);
    await renderHandler(onActionSubmit);

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(open).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onActionSubmit).toHaveBeenCalled());
  });
});
