import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';

const error = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => error(...args) } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => `${key}:${vars?.domain ?? ''}`,
  }),
}));

const { WrongPortalToast } = await import('./wrong-portal-toast');
const { setPendingWrongPortal } = await import('@/lib/pending-wrong-portal');

describe('WrongPortalToast', () => {
  beforeEach(() => {
    localStorage.clear();
    error.mockClear();
  });

  it('explains the bounce after the Keycloak logout redirect lands', () => {
    setPendingWrongPortal('seeker');

    render(<WrongPortalToast />);

    expect(error).toHaveBeenCalledWith('auth.wrong_portal:seeker', {
      id: 'wrong-portal-block',
    });
  });

  it('stays silent on an ordinary visit', () => {
    render(<WrongPortalToast />);
    expect(error).not.toHaveBeenCalled();
  });

  it('consumes the bounce, so a later navigation does not re-toast it', () => {
    setPendingWrongPortal('provider');

    const { unmount } = render(<WrongPortalToast />);
    unmount();
    render(<WrongPortalToast />);

    expect(error).toHaveBeenCalledTimes(1);
  });
});
