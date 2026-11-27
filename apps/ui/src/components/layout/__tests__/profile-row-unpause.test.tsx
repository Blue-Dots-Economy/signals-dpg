import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProfileRowActions } from '../profile-row-actions';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/item-api', () => ({ setItemLifecycle: vi.fn() }));
import { toast } from 'sonner';
import { setItemLifecycle } from '@/lib/item-api';
import { TooltipProvider } from '@/components/ui/tooltip';

const pausedProfile = {
  item_id: 'abc', item_network: 'blue_dot', item_domain: 'provider', item_type: 'job_posting_1.0',
  item_instance_url: null, item_schema_url: null, item_state: {}, item_locations: [],
  created_at: '', updated_at: '', lifecycle_status: 'paused' as const,
};

const httpError = (status: number, data: Record<string, unknown>) =>
  Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });

async function resume() {
  render(
    <TooltipProvider>
      <ProfileRowActions profile={pausedProfile} pauseEnabled onEdit={() => {}} onChanged={() => {}} />
    </TooltipProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Resume profile' }));
  const buttons = await screen.findAllByRole('button', { name: 'Resume profile' });
  await userEvent.click(buttons[buttons.length - 1]);
}

describe('ProfileRowActions — unpause refused by the live profile limit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the server message, not the generic failure', async () => {
    vi.mocked(setItemLifecycle).mockRejectedValue(
      httpError(409, {
        error: 'PROFILE_LIMIT_REACHED',
        limit_type: 'live',
        message: 'Live profile limit reached. Pause or retire any live profile to unpause this one.',
      }),
    );

    await resume();

    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Live profile limit reached. Pause or retire any live profile to unpause this one.',
      ),
    );
  });

  it('keeps the generic message for any other failure', async () => {
    vi.mocked(setItemLifecycle).mockRejectedValue(httpError(500, { error: 'INTERNAL_SERVER_ERROR' }));

    await resume();

    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not update profile status. Try again.'),
    );
  });
});
