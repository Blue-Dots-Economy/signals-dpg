import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useActions, useReceivedActions, useInitiatedActions } from '../use-actions';

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));

vi.mock('@/lib/action-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/action-api')>('@/lib/action-api');
  return { ...actual, fetchMyActions: vi.fn() };
});
import { fetchMyActions } from '@/lib/action-api';

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useActions (#439: extended with itemId/status/sort/facets)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards itemId/status/sort into the fetchMyActions query, and still drops a page-sized default limit', async () => {
    vi.mocked(fetchMyActions).mockResolvedValue({
      meta: { total: 1, limit: 20, offset: 0 },
      actions: [],
    });
    renderHook(
      () =>
        useActions('received', {
          itemId: 'profile-999',
          status: 'accepted',
          sort: 'recent',
          enabled: true,
        }),
      { wrapper },
    );
    await waitFor(() => expect(fetchMyActions).toHaveBeenCalled());
    expect(fetchMyActions).toHaveBeenCalledWith(
      expect.objectContaining({
        ownership_role: 'received',
        item_id: 'profile-999',
        action_status: 'accepted',
        sort: 'recent',
        limit: 20,
        offset: 0,
      }),
      expect.anything(),
    );
  });

  it('keeps working unchanged for the plain "all" pair-check call sites (home-page/public-profile-page)', async () => {
    vi.mocked(fetchMyActions).mockResolvedValue({
      meta: { total: 0, limit: 20, offset: 0 },
      actions: [],
    });
    renderHook(() => useActions('all', { enabled: true }), { wrapper });
    await waitFor(() => expect(fetchMyActions).toHaveBeenCalled());
    expect(fetchMyActions).toHaveBeenCalledWith(
      expect.objectContaining({ ownership_role: 'all', offset: 0 }),
      expect.anything(),
    );
  });
});

describe('useReceivedActions (#439 per-profile scoping + infinite paging)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards item_id, sort, and action_status into the fetchMyActions query', async () => {
    vi.mocked(fetchMyActions).mockResolvedValue({
      meta: { total: 1, limit: 20, offset: 0 },
      actions: [],
    });
    renderHook(
      () =>
        useReceivedActions('profile-123', {
          status: ['created', 'pending'],
          sort: 'oldest',
        }),
      { wrapper },
    );
    await waitFor(() => expect(fetchMyActions).toHaveBeenCalled());
    expect(fetchMyActions).toHaveBeenCalledWith(
      expect.objectContaining({
        ownership_role: 'received',
        item_id: 'profile-123',
        action_status: ['created', 'pending'],
        sort: 'oldest',
      }),
      expect.anything(),
    );
  });

  it('advances offset by the page size on a second page fetch', async () => {
    vi.mocked(fetchMyActions).mockImplementation(async (q) => ({
      meta: { total: 40, limit: 20, offset: q?.offset ?? 0 },
      actions: [],
    }));
    const { result } = renderHook(() => useReceivedActions('profile-123'), { wrapper });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    expect(fetchMyActions).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 0, limit: 20 }),
      expect.anything(),
    );

    act(() => {
      result.current.fetchNextPage();
    });

    await waitFor(() =>
      expect(fetchMyActions).toHaveBeenLastCalledWith(
        expect.objectContaining({ offset: 20, limit: 20 }),
        expect.anything(),
      ),
    );
  });

  it('stops paging once offset + limit reaches meta.total', async () => {
    vi.mocked(fetchMyActions).mockResolvedValue({
      meta: { total: 20, limit: 20, offset: 0 },
      actions: [],
    });
    const { result } = renderHook(() => useReceivedActions('profile-123'), { wrapper });
    await waitFor(() => expect(fetchMyActions).toHaveBeenCalled());
    expect(result.current.hasNextPage).toBe(false);
  });

  it('does not fetch when itemId is null (no live profile scoped yet)', () => {
    renderHook(() => useReceivedActions(null), { wrapper });
    expect(fetchMyActions).not.toHaveBeenCalled();
  });
});

describe('useInitiatedActions (#439 per-profile scoping + infinite paging)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards ownership_role=initiated and item_id', async () => {
    vi.mocked(fetchMyActions).mockResolvedValue({
      meta: { total: 0, limit: 20, offset: 0 },
      actions: [],
    });
    renderHook(() => useInitiatedActions('profile-abc', { sort: 'match_score' }), { wrapper });
    await waitFor(() => expect(fetchMyActions).toHaveBeenCalled());
    expect(fetchMyActions).toHaveBeenCalledWith(
      expect.objectContaining({
        ownership_role: 'initiated',
        item_id: 'profile-abc',
        sort: 'match_score',
      }),
      expect.anything(),
    );
  });
});
