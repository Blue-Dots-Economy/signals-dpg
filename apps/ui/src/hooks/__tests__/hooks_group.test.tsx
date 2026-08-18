import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, renderHook, act, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import type {
  FetchMyActionsQuery,
  FetchMyActionsResponse,
  UpdateActionStatusPayload,
  UpdateActionStatusResponse,
} from '@/lib/action-api';
import type { BulkEnvelope } from '@/lib/bulk';
import type { Item, ItemLifecycleAction, ItemLifecycleResponse } from '@/lib/item-api';
import type { CalculateMatchScorePayload, MatchScoreResult } from '@/lib/match-score-api';
import type { DotActionSchema } from '@/engine/types';

// Four boundaries are stubbed for the whole file: the auth context (drives the
// `enabled:` gate in use-actions), the action API, the item API's lifecycle
// call, and the match-score API. Everything else — react-query, i18n, sonner,
// Radix dialogs, the real browser-location wrapper — stays REAL so the
// assertions are about user-visible behaviour.
//
// Every shared handle goes through `vi.hoisted`: a `vi.mock` factory is hoisted
// above ordinary top-level declarations, so it must not close over them.

const mocks = vi.hoisted(() => ({
  authed: { value: true },
  signOut: vi.fn(async (): Promise<void> => {}),
  fetchMyActions: vi.fn(
    async (_query: FetchMyActionsQuery, _signal?: AbortSignal): Promise<FetchMyActionsResponse> => ({
      meta: { total: 0, limit: 100, offset: 0 },
      actions: [],
    }),
  ),
  updateActionStatus: vi.fn(
    async (_payload: UpdateActionStatusPayload): Promise<UpdateActionStatusResponse> => ({
      action_id: 'act-1',
      action_type: 'connect',
      action_status: 'accepted',
      update_count: 2,
    }),
  ),
  updateActionStatusBulk: vi.fn(
    async (
      _payloads: UpdateActionStatusPayload[],
      _guardianOtp?: string,
    ): Promise<BulkEnvelope<UpdateActionStatusResponse>> => ({
      results: [],
      summary: { total: 0, succeeded: 0, failed: 0 },
    }),
  ),
  setItemLifecycle: vi.fn(
    async (itemId: string, _action: ItemLifecycleAction): Promise<ItemLifecycleResponse> => ({
      item_id: itemId,
      lifecycle_status: 'live',
    }),
  ),
  calculateMatchScore: vi.fn(
    async (_payload: CalculateMatchScorePayload): Promise<MatchScoreResult> => ({
      provider: 'test',
      score: 8,
    }),
  ),
}));

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    user: mocks.authed.value ? { id: 'u1' } : null,
    isLoading: false,
    isAuthenticated: mocks.authed.value,
    signOut: mocks.signOut,
  }),
}));

vi.mock('@/lib/action-api', () => ({
  ACTION_CONSENT_SENTINEL: '__consent',
  fetchMyActions: mocks.fetchMyActions,
  updateActionStatus: mocks.updateActionStatus,
  updateActionStatusBulk: mocks.updateActionStatusBulk,
  // Faithful to the real classifier for the codes these components branch on.
  guardianOtpErrorFromThrown: (err: unknown) => {
    const code = (err as { code?: string } | null | undefined)?.code;
    const known = [
      'GUARDIAN_OTP_REQUIRED',
      'GUARDIAN_OTP_INVALID',
      'GUARDIAN_OTP_THROTTLED',
      'GUARDIAN_OTP_RATE_LIMITED',
      'OTP_PROVIDER_UNAVAILABLE',
    ];
    return code && known.includes(code) ? code : null;
  },
}));

vi.mock('@/lib/item-api', () => ({ setItemLifecycle: mocks.setItemLifecycle }));

vi.mock('@/lib/match-score-api', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/match-score-api')>('@/lib/match-score-api');
  return { ...actual, calculateMatchScore: mocks.calculateMatchScore };
});

// Imported AFTER the mocks so the modules under test pick them up.
import { useBrowserLocation } from '@/hooks/use-browser-location';
import {
  ACTIONS_PAGE_SIZE,
  useActions,
  useInitiatedActions,
  usePendingActionsCount,
  useReceivedActions,
  useReceivedActionsByStatus,
  useUpdateActionStatus,
  useUpdateActionStatusBulk,
} from '@/hooks/use-actions';
import { useMatchScore } from '@/hooks/use-match-score';
import { setCachedMatchScore, getCachedMatchScore } from '@/utils/match-score-cache';
import { ActionAbortedError } from '@/lib/action-abort';
import { BulkSingleError } from '@/lib/bulk';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ProfileRowActions } from '@/components/layout/profile-row-actions';
import { ActionHandler } from '@/components/actions/action-handler';

// ─── Shared helpers ───────────────────────────────────────────────

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function queryWrapper(): ({ children }: { children: React.ReactNode }) => React.ReactElement {
  const client = makeQueryClient();
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function makeItem(id: string, overrides: Partial<Item> = {}): Item {
  return {
    item_id: id,
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_instance_url: null,
    item_schema_url: null,
    item_state: { name: `Name ${id}` },
    item_locations: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ─── useBrowserLocation ───────────────────────────────────────────

interface GeolocationStub {
  getCurrentPosition: (
    success: PositionCallback,
    error?: PositionErrorCallback | null,
    options?: PositionOptions,
  ) => void;
}

/** Install an own `navigator.geolocation` that shadows happy-dom's getter. */
function stubGeolocation(stub: GeolocationStub): void {
  Object.defineProperty(navigator, 'geolocation', {
    value: stub,
    configurable: true,
    writable: true,
  });
}

function clearGeolocationStub(): void {
  if (Object.getOwnPropertyDescriptor(navigator, 'geolocation')) {
    delete (navigator as unknown as Record<string, unknown>).geolocation;
  }
}

/**
 * Run `fn` with geolocation absent from `navigator` AND its prototype chain, so
 * `'geolocation' in navigator` is genuinely false (happy-dom defines it as a
 * configurable getter on `Navigator.prototype`).
 */
async function withoutGeolocation(fn: () => Promise<void>): Promise<void> {
  clearGeolocationStub();
  const restore: Array<[object, PropertyDescriptor]> = [];
  let holder: object | null = navigator;
  while (holder) {
    const desc = Object.getOwnPropertyDescriptor(holder, 'geolocation');
    if (desc?.configurable) {
      restore.push([holder, desc]);
      delete (holder as Record<string, unknown>).geolocation;
    }
    holder = Object.getPrototypeOf(holder) as object | null;
  }
  try {
    await fn();
  } finally {
    for (const [obj, desc] of restore) Object.defineProperty(obj, 'geolocation', desc);
  }
}

function coords(lat: number, lng: number, accuracy: number): GeolocationPosition {
  return {
    coords: { latitude: lat, longitude: lng, accuracy },
    timestamp: Date.now(),
  } as GeolocationPosition;
}

/** A GeolocationPositionError carrying the instance code constants the wrapper reads. */
function positionError(code: number, message = ''): GeolocationPositionError {
  return {
    code,
    message,
    PERMISSION_DENIED: 1,
    POSITION_UNAVAILABLE: 2,
    TIMEOUT: 3,
  } as GeolocationPositionError;
}

describe('useBrowserLocation', () => {
  afterEach(() => {
    clearGeolocationStub();
  });

  it('starts idle and does nothing on mount (no permission prompt without a gesture)', () => {
    const getCurrentPosition = vi.fn();
    stubGeolocation({ getCurrentPosition });

    const { result } = renderHook(() => useBrowserLocation());

    expect(result.current.status).toBe('idle');
    expect(result.current.location).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.isSupported).toBe(true);
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it('resolves the position and forwards the caller options to the browser API', async () => {
    let seenOptions: PositionOptions | undefined;
    stubGeolocation({
      getCurrentPosition: (success, _error, options) => {
        seenOptions = options;
        success(coords(12.97, 77.59, 25));
      },
    });

    const { result } = renderHook(() => useBrowserLocation());

    let resolved: { lat: number; lng: number; accuracy: number } | null = null;
    await act(async () => {
      resolved = await result.current.request({
        highAccuracy: true,
        timeoutMs: 4000,
        maxAgeMs: 1000,
      });
    });

    expect(resolved).toEqual({ lat: 12.97, lng: 77.59, accuracy: 25 });
    expect(result.current.location).toEqual({ lat: 12.97, lng: 77.59, accuracy: 25 });
    expect(result.current.status).toBe('success');
    expect(result.current.error).toBeNull();
    expect(seenOptions).toEqual({ enableHighAccuracy: true, timeout: 4000, maximumAge: 1000 });
  });

  it.each([
    [1, 'permission_denied', 'Location permission was denied.'],
    [2, 'position_unavailable', 'Your location could not be determined.'],
    [3, 'timeout', 'Timed out while determining your location.'],
  ])('maps browser error code %i to "%s"', async (code, expectedCode, expectedMessage) => {
    stubGeolocation({
      getCurrentPosition: (_success, error) => error?.(positionError(code)),
    });

    const { result } = renderHook(() => useBrowserLocation());

    let resolved: unknown = 'unset';
    await act(async () => {
      resolved = await result.current.request();
    });

    expect(resolved).toBeNull();
    expect(result.current.status).toBe('error');
    expect(result.current.location).toBeNull();
    expect(result.current.error?.code).toBe(expectedCode);
    expect(result.current.error?.message).toBe(expectedMessage);
  });

  it('falls back to position_unavailable (keeping the browser message) for an unknown error code', async () => {
    stubGeolocation({
      getCurrentPosition: (_success, error) => error?.(positionError(99, 'gps chip melted')),
    });

    const { result } = renderHook(() => useBrowserLocation());
    await act(async () => {
      await result.current.request();
    });

    expect(result.current.error?.code).toBe('position_unavailable');
    expect(result.current.error?.message).toBe('gps chip melted');
  });

  it('wraps a non-BrowserLocationError rejection into a generic position_unavailable error', async () => {
    stubGeolocation({
      getCurrentPosition: () => {
        throw new TypeError('geolocation exploded');
      },
    });

    const { result } = renderHook(() => useBrowserLocation());
    await act(async () => {
      await result.current.request();
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error?.code).toBe('position_unavailable');
    expect(result.current.error?.message).toBe('Failed to get the current location.');
  });

  it('reports unsupported when the browser exposes no geolocation API', async () => {
    await withoutGeolocation(async () => {
      const { result } = renderHook(() => useBrowserLocation());
      expect(result.current.isSupported).toBe(false);

      await act(async () => {
        await result.current.request();
      });

      expect(result.current.status).toBe('error');
      expect(result.current.error?.code).toBe('unsupported');
    });
  });

  it('reset() clears a resolved location back to idle', async () => {
    stubGeolocation({ getCurrentPosition: (success) => success(coords(1, 2, 3)) });

    const { result } = renderHook(() => useBrowserLocation());
    await act(async () => {
      await result.current.request();
    });
    expect(result.current.status).toBe('success');

    act(() => {
      result.current.reset();
    });

    expect(result.current.location).toBeNull();
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeNull();
  });

  it('a second request() aborts the first, so a late first response is discarded', async () => {
    const pending: Array<(p: GeolocationPosition) => void> = [];
    stubGeolocation({
      getCurrentPosition: (success) => {
        pending.push(success);
      },
    });

    const { result } = renderHook(() => useBrowserLocation());

    let first: Promise<unknown> = Promise.resolve(null);
    act(() => {
      first = result.current.request();
    });
    // Second request supersedes the first (which is now aborted).
    let second: Promise<unknown> = Promise.resolve(null);
    act(() => {
      second = result.current.request();
    });

    await act(async () => {
      pending[1](coords(50, 60, 5));
      pending[0](coords(10, 20, 1));
      await Promise.resolve();
    });

    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toEqual({ lat: 50, lng: 60, accuracy: 5 });
    // The superseded first response must NOT win the race.
    expect(result.current.location).toEqual({ lat: 50, lng: 60, accuracy: 5 });
  });

  it('unmounting aborts an in-flight request instead of resolving it', async () => {
    const pending: Array<(p: GeolocationPosition) => void> = [];
    stubGeolocation({
      getCurrentPosition: (success) => {
        pending.push(success);
      },
    });

    const { result, unmount } = renderHook(() => useBrowserLocation());
    let inFlight: Promise<unknown> = Promise.resolve(null);
    act(() => {
      inFlight = result.current.request();
    });

    unmount();
    pending[0](coords(9, 9, 9));

    await expect(inFlight).resolves.toBeNull();
  });

  it('reset() also cancels an in-flight request', async () => {
    const pending: Array<(p: GeolocationPosition) => void> = [];
    stubGeolocation({
      getCurrentPosition: (success) => {
        pending.push(success);
      },
    });

    const { result } = renderHook(() => useBrowserLocation());
    let inFlight: Promise<unknown> = Promise.resolve(null);
    act(() => {
      inFlight = result.current.request();
    });
    act(() => {
      result.current.reset();
    });

    await act(async () => {
      pending[0](coords(7, 8, 9));
      await Promise.resolve();
    });

    await expect(inFlight).resolves.toBeNull();
    expect(result.current.status).toBe('idle');
    expect(result.current.location).toBeNull();
  });
});

// ─── use-actions ──────────────────────────────────────────────────

function actionsResponse(total: number): FetchMyActionsResponse {
  return {
    meta: { total, limit: 100, offset: 0 },
    actions: [],
  };
}

describe('use-actions', () => {
  beforeEach(() => {
    mocks.authed.value = true;
    mocks.fetchMyActions.mockReset();
    mocks.fetchMyActions.mockResolvedValue(actionsResponse(0));
    mocks.updateActionStatus.mockReset();
    mocks.updateActionStatus.mockResolvedValue({
      action_id: 'act-1',
      action_type: 'connect',
      action_status: 'accepted',
      update_count: 2,
    });
    mocks.updateActionStatusBulk.mockReset();
    mocks.updateActionStatusBulk.mockResolvedValue({
      results: [],
      summary: { total: 0, succeeded: 0, failed: 0 },
    });
  });

  it('useActions() fetches all ownership roles and exposes actions + meta', async () => {
    mocks.fetchMyActions.mockResolvedValue({
      meta: { total: 1, limit: ACTIONS_PAGE_SIZE, offset: 0 },
      actions: [
        {
          action_id: 'act-1',
          action_type: 'connect',
          action_status: 'created',
          update_count: 1,
          source_item_id: 'src-1',
          source_item_network: 'blue_dot',
          source_item_domain: 'seeker',
          source_item_type: 'profile_1.0',
          source_item_owner: 'u1',
          target_item_id: 'tgt-1',
          target_item_network: 'blue_dot',
          target_item_domain: 'provider',
          target_item_type: 'profile_1.0',
          target_item_owner: 'u2',
          requirements_snapshot: {},
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          ownership_roles: ['initiated'],
        },
      ],
    });

    const { result } = renderHook(() => useActions(), { wrapper: queryWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      actions: [expect.objectContaining({ action_id: 'act-1' })],
      meta: { total: 1, limit: ACTIONS_PAGE_SIZE, offset: 0 },
    });
    // #439 replaced the old hardcoded `limit: 100` with the shared page size.
    expect(mocks.fetchMyActions.mock.calls[0][0]).toEqual({
      ownership_role: 'all',
      limit: ACTIONS_PAGE_SIZE,
      offset: 0,
    });
  });

  it('does not fetch actions for an anonymous user (the endpoint requires a session)', async () => {
    mocks.authed.value = false;

    const { result } = renderHook(() => useActions('received'), { wrapper: queryWrapper() });

    expect(result.current.fetchStatus).toBe('idle');
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.fetchMyActions).not.toHaveBeenCalled();
  });

  it("honours a caller's enabled:false even when authenticated", async () => {
    const { result } = renderHook(() => useActions('all', { enabled: false }), {
      wrapper: queryWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.fetchMyActions).not.toHaveBeenCalled();
  });

  it('useInitiatedActions / useReceivedActions filter by ownership role', async () => {
    const { result: initiated } = renderHook(() => useInitiatedActions('item-1'), {
      wrapper: queryWrapper(),
    });
    await waitFor(() => expect(initiated.current.isSuccess).toBe(true));
    // #439: both hooks are now scoped to one profile and paged from offset 0.
    expect(mocks.fetchMyActions.mock.calls[0][0]).toEqual({
      ownership_role: 'initiated',
      item_id: 'item-1',
      limit: ACTIONS_PAGE_SIZE,
      offset: 0,
    });

    mocks.fetchMyActions.mockClear();
    const { result: received } = renderHook(() => useReceivedActions('item-1'), {
      wrapper: queryWrapper(),
    });
    await waitFor(() => expect(received.current.isSuccess).toBe(true));
    expect(mocks.fetchMyActions.mock.calls[0][0].ownership_role).toBe('received');
  });

  it('stays disabled until a profile id is resolvable (nothing to scope to)', async () => {
    const { result } = renderHook(() => useReceivedActions(null), { wrapper: queryWrapper() });

    expect(result.current.fetchStatus).toBe('idle');
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.fetchMyActions).not.toHaveBeenCalled();
  });

  it('useReceivedActionsByStatus narrows to received actions with the given status', async () => {
    const { result } = renderHook(() => useReceivedActionsByStatus('created'), {
      wrapper: queryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.fetchMyActions.mock.calls[0][0]).toEqual({
      ownership_role: 'received',
      action_status: 'created',
      limit: 100,
      offset: 0,
    });
  });

  it('usePendingActionsCount returns the pending-received total using a 1-row probe', async () => {
    mocks.fetchMyActions.mockResolvedValue(actionsResponse(7));

    const { result } = renderHook(() => usePendingActionsCount(), { wrapper: queryWrapper() });

    await waitFor(() => expect(result.current.data).toBe(7));
    expect(mocks.fetchMyActions.mock.calls[0][0]).toEqual({
      ownership_role: 'received',
      action_status: 'created',
      limit: 1,
      offset: 0,
    });
  });

  it('usePendingActionsCount stays idle for an anonymous user', async () => {
    mocks.authed.value = false;

    const { result } = renderHook(() => usePendingActionsCount(), { wrapper: queryWrapper() });

    expect(result.current.fetchStatus).toBe('idle');
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.fetchMyActions).not.toHaveBeenCalled();
  });

  it('useUpdateActionStatus refreshes the action list after a successful update', async () => {
    const { result } = renderHook(
      () => ({ list: useActions('received'), update: useUpdateActionStatus() }),
      { wrapper: queryWrapper() },
    );

    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    expect(mocks.fetchMyActions).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.update.mutateAsync({ action_id: 'act-1', action_status: 'accepted' });
    });

    expect(mocks.updateActionStatus).toHaveBeenCalledWith({
      action_id: 'act-1',
      action_status: 'accepted',
    });
    // The list must re-fetch so the receiver sees the new status immediately.
    await waitFor(() => expect(mocks.fetchMyActions).toHaveBeenCalledTimes(2));
  });

  it('useUpdateActionStatusBulk forwards the guardian OTP and returns the envelope', async () => {
    const envelope: BulkEnvelope<UpdateActionStatusResponse> = {
      results: [
        {
          index: 0,
          status: 'success',
          action_id: 'act-1',
          action_type: 'connect',
          action_status: 'accepted',
          update_count: 2,
        },
      ],
      summary: { total: 1, succeeded: 1, failed: 0 },
    };
    mocks.updateActionStatusBulk.mockResolvedValue(envelope);

    const { result } = renderHook(
      () => ({ list: useActions('received'), bulk: useUpdateActionStatusBulk() }),
      { wrapper: queryWrapper() },
    );
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));

    const payloads = [{ action_id: 'act-1', action_status: 'accepted' }];
    let returned: BulkEnvelope<UpdateActionStatusResponse> | undefined;
    await act(async () => {
      returned = await result.current.bulk.mutateAsync({ payloads, guardianOtp: '123456' });
    });

    expect(mocks.updateActionStatusBulk).toHaveBeenCalledWith(payloads, '123456');
    expect(returned).toEqual(envelope);
    await waitFor(() => expect(mocks.fetchMyActions).toHaveBeenCalledTimes(2));
  });

  it('useUpdateActionStatusBulk still refreshes the list when the bulk call fails (onSettled)', async () => {
    mocks.updateActionStatusBulk.mockRejectedValue(new Error('bulk boom'));

    const { result } = renderHook(
      () => ({ list: useActions('received'), bulk: useUpdateActionStatusBulk() }),
      { wrapper: queryWrapper() },
    );
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));

    await act(async () => {
      await expect(
        result.current.bulk.mutateAsync({ payloads: [{ action_id: 'a', action_status: 'accepted' }] }),
      ).rejects.toThrow('bulk boom');
    });

    await waitFor(() => expect(mocks.fetchMyActions).toHaveBeenCalledTimes(2));
  });
});

describe('use-actions polling interval (VITE_ACTION_POLL_INTERVAL_MS)', () => {
  beforeEach(() => {
    mocks.authed.value = true;
    mocks.fetchMyActions.mockReset();
    mocks.fetchMyActions.mockResolvedValue(actionsResponse(0));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** Re-import use-actions so its module-level POLLING_INTERVAL is recomputed. */
  async function loadWithPollEnv(raw: string | undefined): Promise<typeof import('@/hooks/use-actions')> {
    vi.resetModules();
    vi.stubEnv('VITE_ACTION_POLL_INTERVAL_MS', raw);
    return import('@/hooks/use-actions');
  }

  async function advance(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it('polls at the configured interval when the override is a positive number', async () => {
    const mod = await loadWithPollEnv('2000');
    vi.useFakeTimers();

    renderHook(() => mod.useActions('received'), { wrapper: queryWrapper() });
    await advance(0);
    expect(mocks.fetchMyActions).toHaveBeenCalledTimes(1);

    await advance(2000);
    expect(mocks.fetchMyActions).toHaveBeenCalledTimes(2);

    await advance(2000);
    expect(mocks.fetchMyActions).toHaveBeenCalledTimes(3);
  });

  it('disables polling entirely when the override is "0"', async () => {
    const mod = await loadWithPollEnv('0');
    vi.useFakeTimers();

    renderHook(() => mod.usePendingActionsCount(), { wrapper: queryWrapper() });
    await advance(0);
    expect(mocks.fetchMyActions).toHaveBeenCalledTimes(1);

    await advance(300_000);
    expect(mocks.fetchMyActions).toHaveBeenCalledTimes(1);
  });

  it.each(['not-a-number', '-1'])(
    'ignores the invalid override %o and falls back to the 60s default',
    async (raw) => {
      const mod = await loadWithPollEnv(raw);
      vi.useFakeTimers();

      renderHook(() => mod.useActions('all'), { wrapper: queryWrapper() });
      await advance(0);
      expect(mocks.fetchMyActions).toHaveBeenCalledTimes(1);

      // Well past a 2s-style override, still short of the 60s default.
      await advance(30_000);
      expect(mocks.fetchMyActions).toHaveBeenCalledTimes(1);

      await advance(30_000);
      expect(mocks.fetchMyActions).toHaveBeenCalledTimes(2);
    },
  );

  it('falls back to the 60s default when the override is an empty string', async () => {
    const mod = await loadWithPollEnv('');
    vi.useFakeTimers();

    renderHook(() => mod.useActions('all'), { wrapper: queryWrapper() });
    await advance(0);
    expect(mocks.fetchMyActions).toHaveBeenCalledTimes(1);

    await advance(60_000);
    expect(mocks.fetchMyActions).toHaveBeenCalledTimes(2);
  });
});

// ─── useMatchScore (paths the existing use-match-score.test.tsx leaves open) ──

describe('useMatchScore calculate/recalculate/clearCache', () => {
  const dest = makeItem('dest-1');

  beforeEach(() => {
    localStorage.clear();
    mocks.calculateMatchScore.mockReset();
    mocks.calculateMatchScore.mockResolvedValue({ provider: 'llm', score: 8.2 });
  });

  it('refuses to calculate without a local profile and never calls the API', async () => {
    const { result } = renderHook(() =>
      useMatchScore({ localItem: null, networkItem: dest, skipCache: true }),
    );

    await act(async () => {
      await result.current.calculate();
    });

    expect(result.current.error?.message).toBe('No local item selected');
    expect(result.current.isLoading).toBe(false);
    expect(result.current.score).toBeNull();
    expect(mocks.calculateMatchScore).not.toHaveBeenCalled();
  });

  it('calculates from the API, marks the result uncached and persists it for the pair', async () => {
    const local = makeItem('profile-A');
    const { result } = renderHook(() => useMatchScore({ localItem: local, networkItem: dest }));

    await act(async () => {
      await result.current.calculate();
    });

    expect(result.current.score).toEqual({ provider: 'llm', score: 8.2 });
    expect(result.current.cached).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(mocks.calculateMatchScore).toHaveBeenCalledTimes(1);
    // Snapshots of BOTH sides of the pair are sent.
    expect(mocks.calculateMatchScore.mock.calls[0][0].itemA.item_id).toBe('profile-A');
    expect(mocks.calculateMatchScore.mock.calls[0][0].itemB.item_id).toBe('dest-1');
    // Cached for the pair so a repeat view is free.
    expect(getCachedMatchScore('profile-A', 'dest-1')?.score).toEqual({
      provider: 'llm',
      score: 8.2,
    });
  });

  it('serves a previously cached score for the pair without calling the API', async () => {
    setCachedMatchScore('profile-A', 'dest-1', { provider: 'llm', score: 6.5 });

    const { result } = renderHook(() =>
      useMatchScore({ localItem: makeItem('profile-A'), networkItem: dest }),
    );

    await act(async () => {
      await result.current.calculate();
    });

    expect(result.current.score).toEqual({ provider: 'llm', score: 6.5 });
    expect(result.current.cached).toBe(true);
    expect(mocks.calculateMatchScore).not.toHaveBeenCalled();
  });

  it('skipCache bypasses the cached score and re-fetches', async () => {
    setCachedMatchScore('profile-A', 'dest-1', { provider: 'llm', score: 6.5 });

    const { result } = renderHook(() =>
      useMatchScore({ localItem: makeItem('profile-A'), networkItem: dest, skipCache: true }),
    );

    await act(async () => {
      await result.current.calculate();
    });

    expect(mocks.calculateMatchScore).toHaveBeenCalledTimes(1);
    expect(result.current.score).toEqual({ provider: 'llm', score: 8.2 });
    expect(result.current.cached).toBe(false);
  });

  it('recalculate() drops the cached score for the pair and fetches a fresh one', async () => {
    setCachedMatchScore('profile-A', 'dest-1', { provider: 'llm', score: 1.1 });
    mocks.calculateMatchScore.mockResolvedValue({ provider: 'llm', score: 9.4 });

    const { result } = renderHook(() =>
      useMatchScore({ localItem: makeItem('profile-A'), networkItem: dest }),
    );

    await act(async () => {
      await result.current.recalculate();
    });

    expect(mocks.calculateMatchScore).toHaveBeenCalledTimes(1);
    expect(result.current.score).toEqual({ provider: 'llm', score: 9.4 });
    expect(result.current.cached).toBe(false);
    expect(getCachedMatchScore('profile-A', 'dest-1')?.score.score).toBe(9.4);
  });

  it('clearCache() resets the badge and forces the next calculate() back to the API', async () => {
    setCachedMatchScore('profile-A', 'dest-1', { provider: 'llm', score: 3.3 });

    const { result } = renderHook(() =>
      useMatchScore({ localItem: makeItem('profile-A'), networkItem: dest }),
    );
    await act(async () => {
      await result.current.calculate();
    });
    expect(result.current.cached).toBe(true);

    act(() => {
      result.current.clearCache();
    });

    expect(result.current.score).toBeNull();
    expect(result.current.cached).toBe(false);
    expect(getCachedMatchScore('profile-A', 'dest-1')).toBeNull();

    await act(async () => {
      await result.current.calculate();
    });
    expect(mocks.calculateMatchScore).toHaveBeenCalledTimes(1);
    expect(result.current.score).toEqual({ provider: 'llm', score: 8.2 });
  });

  it('surfaces the API error message and clears any stale score', async () => {
    mocks.calculateMatchScore.mockRejectedValue(new Error('relevance service down'));

    const { result } = renderHook(() =>
      useMatchScore({ localItem: makeItem('profile-A'), networkItem: makeItem('dest-2'), skipCache: true }),
    );

    await act(async () => {
      await result.current.calculate();
    });

    expect(result.current.error?.message).toBe('relevance service down');
    expect(result.current.score).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('uses a generic message when the API rejects with a non-Error value', async () => {
    mocks.calculateMatchScore.mockRejectedValue('kaboom');

    const { result } = renderHook(() =>
      useMatchScore({ localItem: makeItem('profile-A'), networkItem: makeItem('dest-3'), skipCache: true }),
    );

    await act(async () => {
      await result.current.calculate();
    });

    expect(result.current.error?.message).toBe('Failed to calculate match score');
  });
});

// ─── ProfileRowActions (lifecycle) ────────────────────────────────

function renderProfileRow(
  opts: {
    status?: Item['lifecycle_status'];
    pauseEnabled?: boolean;
    onEdit?: () => void;
    onChanged?: () => void;
    onRowClick?: () => void;
  } = {},
) {
  const {
    status = 'live',
    pauseEnabled = true,
    onEdit = () => {},
    onChanged = () => {},
    onRowClick = () => {},
  } = opts;

  return render(
    <>
      <Toaster />
      <TooltipProvider>
        {/* The row itself is clickable in the sidebar, so the action buttons
            must not bubble their clicks up to it. */}
        <div onClick={onRowClick}>
          <ProfileRowActions
            profile={makeItem('prof-1', { lifecycle_status: status })}
            pauseEnabled={pauseEnabled}
            onEdit={onEdit}
            onChanged={onChanged}
          />
        </div>
      </TooltipProvider>
    </>,
  );
}

describe('ProfileRowActions lifecycle', () => {
  beforeEach(() => {
    mocks.setItemLifecycle.mockReset();
    mocks.setItemLifecycle.mockResolvedValue({ item_id: 'prof-1', lifecycle_status: 'paused' });
  });

  it('offers Pause on a live profile and Resume on a paused one', () => {
    const live = renderProfileRow({ status: 'live' });
    expect(screen.getByRole('button', { name: 'Pause profile' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume profile' })).not.toBeInTheDocument();
    live.unmount();

    renderProfileRow({ status: 'paused' });
    expect(screen.getByRole('button', { name: 'Resume profile' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause profile' })).not.toBeInTheDocument();
  });

  it('hides Pause when the network disables pausing, but still offers Retire', () => {
    renderProfileRow({ status: 'live', pauseEnabled: false });

    expect(screen.queryByRole('button', { name: 'Pause profile' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retire profile' })).toBeInTheDocument();
  });

  it('Edit opens the editor without also triggering the surrounding row click', () => {
    const onEdit = vi.fn();
    const onRowClick = vi.fn();
    renderProfileRow({ onEdit, onRowClick });

    fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }));

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('confirms before pausing, explains the effects, then pauses and refreshes the list', async () => {
    const onChanged = vi.fn();
    renderProfileRow({ status: 'live', onChanged });

    fireEvent.click(screen.getByRole('button', { name: 'Pause profile' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Pause this profile?')).toBeInTheDocument();
    expect(
      within(dialog).getByText('It is hidden — not discoverable by anyone in the network.'),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        'You can resume any time — the profile goes live and everything is restored.',
      ),
    ).toBeInTheDocument();
    expect(mocks.setItemLifecycle).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Pause profile' }));

    await waitFor(() => expect(mocks.setItemLifecycle).toHaveBeenCalledWith('prof-1', 'pause'));
    expect(
      await screen.findByText('Profile paused — it is no longer discoverable in the network.'),
    ).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('cancelling the pause confirmation leaves the profile untouched', async () => {
    const onChanged = vi.fn();
    renderProfileRow({ status: 'live', onChanged });

    fireEvent.click(screen.getByRole('button', { name: 'Pause profile' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mocks.setItemLifecycle).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('resuming a complete profile reports that it is discoverable again', async () => {
    mocks.setItemLifecycle.mockResolvedValue({ item_id: 'prof-1', lifecycle_status: 'live' });
    renderProfileRow({ status: 'paused' });

    fireEvent.click(screen.getByRole('button', { name: 'Resume profile' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Resume this profile?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Resume profile' }));

    await waitFor(() => expect(mocks.setItemLifecycle).toHaveBeenCalledWith('prof-1', 'unpause'));
    expect(
      await screen.findByText('Profile resumed — discoverable in the network again.'),
    ).toBeInTheDocument();
  });

  it('resuming an incomplete profile warns that it landed back as a draft', async () => {
    mocks.setItemLifecycle.mockResolvedValue({ item_id: 'prof-1', lifecycle_status: 'draft' });
    renderProfileRow({ status: 'paused' });

    fireEvent.click(screen.getByRole('button', { name: 'Resume profile' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Resume profile' }));

    expect(
      await screen.findByText('Profile resumed, but it needs completing before it goes live.'),
    ).toBeInTheDocument();
  });

  it('retire is confirmed as irreversible before it is applied', async () => {
    mocks.setItemLifecycle.mockResolvedValue({ item_id: 'prof-1', lifecycle_status: 'retired' });
    const onChanged = vi.fn();
    renderProfileRow({ status: 'live', onChanged });

    fireEvent.click(screen.getByRole('button', { name: 'Retire profile' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Retire this profile?')).toBeInTheDocument();
    expect(
      within(dialog).getByText('This cannot be undone — the profile cannot be restored.'),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText('Any open connections or requests on it are cancelled.'),
    ).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Retire permanently' }));

    await waitFor(() => expect(mocks.setItemLifecycle).toHaveBeenCalledWith('prof-1', 'retire'));
    expect(
      await screen.findByText(
        'Profile retired — it has been permanently removed from the network.',
      ),
    ).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed lifecycle change and does not refresh the list', async () => {
    mocks.setItemLifecycle.mockRejectedValue(new Error('409'));
    const onChanged = vi.fn();
    renderProfileRow({ status: 'live', onChanged });

    fireEvent.click(screen.getByRole('button', { name: 'Pause profile' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pause profile' }));

    expect(
      await screen.findByText('Could not update profile status. Try again.'),
    ).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

// ─── ActionHandler ────────────────────────────────────────────────

type ActionSubmit = (
  actionType: string,
  actionSchema: DotActionSchema,
  formData: Record<string, unknown>,
  targetItemId: string,
  guardianOtp?: string,
) => Promise<void> | void;

/** No requirement_schema → ActionHandler's "submit directly" path. */
function noFormSchema(actionType: string): DotActionSchema {
  return {
    action_type: actionType,
    from_domain: 'student',
    to_domain: 'mentor',
    requirement_schema: undefined,
  } as unknown as DotActionSchema;
}

function renderActionHandler(opts: {
  onActionSubmit?: ActionSubmit;
  guardianConfirmRequired?: boolean;
  actionType?: string;
  schema?: DotActionSchema;
}) {
  const actionType = opts.actionType ?? 'connect';
  const schema = opts.schema ?? noFormSchema(actionType);
  const client = makeQueryClient();
  render(
    <QueryClientProvider client={client}>
      <Toaster />
      <ActionHandler
        onActionSubmit={opts.onActionSubmit}
        guardianConfirmRequired={opts.guardianConfirmRequired}
      >
        {(triggerAction) => (
          <button onClick={() => triggerAction(actionType, schema, 'target-1')}>Go</button>
        )}
      </ActionHandler>
    </QueryClientProvider>,
  );
  return { schema };
}

function clickTrigger(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Go' }));
}

describe('ActionHandler error messaging', () => {
  beforeEach(() => {
    mocks.signOut.mockReset();
  });

  it('shows the generic failure toast for an unexpected error', async () => {
    const onActionSubmit = vi.fn(async () => {
      throw new Error('boom');
    });
    renderActionHandler({ onActionSubmit });

    clickTrigger();

    expect(await screen.findByText("Couldn't complete request")).toBeInTheDocument();
    expect(
      await screen.findByText(
        'Something went wrong while processing your request. Please try again.',
      ),
    ).toBeInTheDocument();
  });

  it('stays silent for an ActionAbortedError — the caller already messaged the user', async () => {
    const onActionSubmit = vi.fn(async () => {
      throw new ActionAbortedError('already handled');
    });
    renderActionHandler({ onActionSubmit });

    clickTrigger();

    await waitFor(() => expect(onActionSubmit).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Couldn't complete request")).not.toBeInTheDocument();
    expect(screen.queryByText('Complete your profile first')).not.toBeInTheDocument();
  });

  it('turns PROFILE_NOT_LIVE into a "complete your profile" prompt instead of an error', async () => {
    const onActionSubmit = vi.fn(async () => {
      throw Object.assign(new Error('draft'), { code: 'PROFILE_NOT_LIVE' });
    });
    renderActionHandler({ onActionSubmit });

    clickTrigger();

    expect(await screen.findByText('Complete your profile first')).toBeInTheDocument();
    expect(
      await screen.findByText(
        'Your profile is still a draft. Fill in the required fields to make it live, then you can perform any actions.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Couldn't complete request")).not.toBeInTheDocument();
  });

  it("prefers the API's per-item bulk message (e.g. the action cap) over the generic copy", async () => {
    const onActionSubmit = vi.fn(async () => {
      throw new BulkSingleError(
        'ACTION_LIMIT_REACHED',
        'An active request already exists between these two profiles.',
        409,
      );
    });
    renderActionHandler({ onActionSubmit });

    clickTrigger();

    expect(await screen.findByText("Couldn't complete request")).toBeInTheDocument();
    expect(
      await screen.findByText('An active request already exists between these two profiles.'),
    ).toBeInTheDocument();
  });

  it('ignores the synthetic "Request failed" placeholder and falls back to the generic copy', async () => {
    const onActionSubmit = vi.fn(async () => {
      throw new BulkSingleError('UNKNOWN', 'Request failed', 422);
    });
    renderActionHandler({ onActionSubmit });

    clickTrigger();

    expect(
      await screen.findByText(
        'Something went wrong while processing your request. Please try again.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Request failed')).not.toBeInTheDocument();
  });
});

describe('ActionHandler guardian confirm step (minor ward)', () => {
  beforeEach(() => {
    mocks.signOut.mockReset();
  });

  it('defers the submit behind a confirm, then runs it on Proceed', async () => {
    const onActionSubmit = vi.fn(async () => {});
    const { schema } = renderActionHandler({ onActionSubmit, guardianConfirmRequired: true });

    clickTrigger();

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Guardian confirmation needed')).toBeInTheDocument();
    // The OTP must NOT be dispatched until the ward opts in.
    expect(onActionSubmit).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Proceed' }));

    await waitFor(() =>
      expect(onActionSubmit).toHaveBeenCalledWith('connect', schema, {}, 'target-1'),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('cancelling the confirm never dispatches the action', async () => {
    const onActionSubmit = vi.fn(async () => {});
    renderActionHandler({ onActionSubmit, guardianConfirmRequired: true });

    clickTrigger();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onActionSubmit).not.toHaveBeenCalled();
  });

  it('describes a connect action as "Connecting with…" in the confirm', async () => {
    renderActionHandler({
      onActionSubmit: vi.fn(async () => {}),
      guardianConfirmRequired: true,
      actionType: 'connect',
    });

    clickTrigger();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Guardian approval for')).toBeInTheDocument();
    expect(within(dialog).getByText('Connecting with the organisation')).toBeInTheDocument();
  });

  it('describes any other action type as "Applying to…" in the confirm', async () => {
    renderActionHandler({
      onActionSubmit: vi.fn(async () => {}),
      guardianConfirmRequired: true,
      actionType: 'apply',
    });

    clickTrigger();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Applying to the organisation')).toBeInTheDocument();
  });
});

describe('ActionHandler guardian OTP dialog wiring', () => {
  beforeEach(() => {
    mocks.signOut.mockReset();
  });

  it('labels a non-connect OTP challenge as an application', async () => {
    const onActionSubmit = vi.fn(async (..._args: unknown[]) => {
      throw Object.assign(new Error('otp'), { code: 'GUARDIAN_OTP_REQUIRED' });
    });
    renderActionHandler({ onActionSubmit: onActionSubmit as ActionSubmit, actionType: 'apply' });

    clickTrigger();

    expect(
      await screen.findByText("This requires your guardian's confirmation via OTP"),
    ).toBeInTheDocument();
    expect(screen.getByText('Applying to the organisation')).toBeInTheDocument();
  });

  it('dismissing the OTP dialog clears the stashed challenge', async () => {
    const onActionSubmit = vi.fn(async (..._args: unknown[]) => {
      throw Object.assign(new Error('otp'), { code: 'GUARDIAN_OTP_REQUIRED' });
    });
    renderActionHandler({ onActionSubmit: onActionSubmit as ActionSubmit });

    clickTrigger();
    const title = await screen.findByText("This requires your guardian's confirmation via OTP");
    expect(title).toBeInTheDocument();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    await waitFor(() =>
      expect(
        screen.queryByText("This requires your guardian's confirmation via OTP"),
      ).not.toBeInTheDocument(),
    );
  });

  it('offers a sign-out escape to a ward stuck on the OTP step', async () => {
    const onActionSubmit = vi.fn(async (..._args: unknown[]) => {
      throw Object.assign(new Error('otp'), { code: 'GUARDIAN_OTP_REQUIRED' });
    });
    renderActionHandler({ onActionSubmit: onActionSubmit as ActionSubmit });

    clickTrigger();
    await screen.findByText("This requires your guardian's confirmation via OTP");

    fireEvent.click(screen.getByRole('button', { name: 'Not you? Log out' }));

    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledTimes(1));
  });
});
