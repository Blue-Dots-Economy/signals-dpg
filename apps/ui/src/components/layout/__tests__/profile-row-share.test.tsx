import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProfileRowActions } from '../profile-row-actions';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/item-api', () => ({ setItemLifecycle: vi.fn() }));
import { TooltipProvider } from '@/components/ui/tooltip';

const base = {
  item_id: 'abc', item_network: 'blue_dot', item_domain: 'seeker', item_type: 'profile_1.0',
  item_instance_url: null, item_schema_url: null, item_state: {}, item_locations: [],
  created_at: '', updated_at: '',
};

function renderRow(status: 'live' | 'paused') {
  // ProfileRowActions uses Radix Tooltip for its icon buttons, which needs a
  // TooltipProvider ancestor; wrap so the row mounts in a test.
  return render(
    <TooltipProvider>
      <ProfileRowActions
        profile={{ ...base, lifecycle_status: status }}
        pauseEnabled
        onEdit={() => {}}
        onChanged={() => {}}
      />
    </TooltipProvider>,
  );
}

describe('ProfileRowActions Share button', () => {
  it('shows Share on a live profile', () => {
    renderRow('live');
    expect(screen.getByRole('button', { name: 'Share profile' })).toBeInTheDocument();
  });
  it('hides Share on a paused profile', () => {
    renderRow('paused');
    expect(screen.queryByRole('button', { name: 'Share profile' })).not.toBeInTheDocument();
  });
});
