// RJSF v6's form submit does not fire under happy-dom; jsdom implements it.
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RJSFSchema } from '@rjsf/utils';
import type { DotActionSchema } from '@/engine/types';

const mocks = vi.hoisted(() => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u1' }, signOut: vi.fn() }),
}));
vi.mock('@/hooks/use-consent-config', () => ({
  useConsentConfig: () => ({ config: null, isLoading: false }),
}));
vi.mock('@/lib/action-api', () => ({
  ACTION_CONSENT_SENTINEL: '__consent',
  guardianOtpErrorFromThrown: () => null,
}));

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

const schemaWithForm = {
  action_type: 'connect',
  from_domain: 'seeker',
  to_domain: 'provider',
  requirement_schema: {
    type: 'object',
    required: ['note'],
    properties: { note: { type: 'string', title: 'Note' } },
  } as RJSFSchema,
} as unknown as DotActionSchema;

async function renderHandler(onActionSubmit: () => Promise<void>) {
  const { ActionHandler } = await import('../action-handler');
  render(
    <ActionHandler onActionSubmit={onActionSubmit}>
      {(trigger) => <button onClick={() => trigger('connect', schemaWithForm, 'target-1')}>Open</button>}
    </ActionHandler>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Open' }));
}

describe('ActionHandler requirement form errors', () => {
  beforeEach(() => vi.clearAllMocks());

  it('an empty Confirm shows the field message and sends nothing', async () => {
    const onActionSubmit = vi.fn(async () => {});
    await renderHandler(onActionSubmit);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Note is required.')).toBeInTheDocument();
    expect(onActionSubmit).not.toHaveBeenCalled();
  });

  it('a failed submit keeps the form open with what the user typed and a readable message', async () => {
    const forbidden = Object.assign(new Error('Request failed with status code 403'), {
      response: { status: 403, data: { error: 'FORBIDDEN' } },
    });
    const onActionSubmit = vi.fn(async () => {
      throw forbidden;
    });
    await renderHandler(onActionSubmit);
    await userEvent.type(screen.getByLabelText(/Note/), 'Hello there');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(onActionSubmit).toHaveBeenCalled());
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(expect.any(String), {
        description: "You don't have permission to do this.",
      }),
    );
    expect(screen.getByLabelText(/Note/)).toHaveValue('Hello there');
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  });

  it('closes the form once the submit succeeds', async () => {
    const onActionSubmit = vi.fn(async () => {});
    await renderHandler(onActionSubmit);
    await userEvent.type(screen.getByLabelText(/Note/), 'Hi');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull());
  });
});
