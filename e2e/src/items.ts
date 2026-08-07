import type { ApiClient, ApiResult } from './api-client.js';
import type { Session } from './auth.js';
import type { Binding } from './schema.js';

/**
 * Item read + lifecycle helpers shared by the item journeys (O, P, Q).
 *
 * Two things every caller here gets wrong at least once:
 *
 *  - **`/item/fetch` has a ~1s Redis cache**, so a just-changed item can still be
 *    served from its previous snapshot. Never assert a status from a single
 *    read — use {@link waitForLifecycle}.
 *  - **network fetch caches per (network, domain)** for a domain-configured TTL.
 *    Pass a varying `cache_ttl_seconds` to bust it, or a "still discoverable"
 *    assertion will pass against a stale page long after the item went away.
 */

export type LifecycleStatus = 'draft' | 'live' | 'paused' | 'retired';
export type LifecycleAction = 'pause' | 'unpause' | 'retire';

export interface FetchedItem {
  item_id: string;
  lifecycle_status?: LifecycleStatus;
  item_instance_url: string;
  item_state?: Record<string, unknown>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const ownFetchPath = (binding: Binding) =>
  `/api/v1/item/fetch?item_network=${encodeURIComponent(binding.network)}` +
  `&item_domain=${encodeURIComponent(binding.domain)}` +
  `&item_type=${encodeURIComponent(binding.item_type)}&limit=100`;

/** All of the caller's own items in this binding. */
export async function fetchOwnItems(session: Session, binding: Binding): Promise<FetchedItem[]> {
  const res = await session.client.get<{ items: FetchedItem[] }>(ownFetchPath(binding));
  return res.body?.items ?? [];
}

/** One of the caller's own items, or undefined. */
export async function fetchOwnItemById(
  session: Session,
  binding: Binding,
  itemId: string,
): Promise<FetchedItem | undefined> {
  const items = await fetchOwnItems(session, binding);
  return items.find((i) => i.item_id === itemId);
}

/**
 * Poll own-fetch until the item reports `want`, then return it. Returns the last
 * observation either way so the caller can assert on it and see what it actually
 * got rather than `undefined`.
 */
export async function waitForLifecycle(
  session: Session,
  binding: Binding,
  itemId: string,
  want: LifecycleStatus,
  attempts = 6,
): Promise<FetchedItem | undefined> {
  let item = await fetchOwnItemById(session, binding, itemId);
  for (let i = 0; i < attempts && item?.lifecycle_status !== want; i++) {
    await sleep(1200);
    item = await fetchOwnItemById(session, binding, itemId);
  }
  return item;
}

export interface LifecycleResponse {
  item_id?: string;
  lifecycle_status?: LifecycleStatus;
  error?: string;
  message?: string;
}

/** Drive `POST /item/lifecycle`. Never throws — callers assert on the result. */
export async function setLifecycle(
  session: Session,
  itemId: string,
  action: LifecycleAction,
): Promise<ApiResult<LifecycleResponse>> {
  return session.client.post<LifecycleResponse>('/api/v1/item/lifecycle', {
    item_id: itemId,
    action,
  });
}

/**
 * Is the item visible through the **inter-instance** read (what discovery uses)?
 *
 * `cache_ttl_seconds` is varied per call to bypass the merged-result cache —
 * without it a de-indexed item keeps appearing and the assertion silently
 * passes against a stale aggregate.
 */
export async function isDiscoverable(
  api: ApiClient,
  binding: Binding,
  itemId: string,
): Promise<boolean> {
  const bust = 300 + (Date.now() % 100000);
  const res = await api.get<{ items: Array<{ item_id: string }> }>(
    `/api/v1/network/item/fetch?item_network=${encodeURIComponent(binding.network)}` +
      `&item_domain=${encodeURIComponent(binding.domain)}` +
      `&item_type=${encodeURIComponent(binding.item_type)}&limit=200&cache_ttl_seconds=${bust}`,
  );
  return Boolean(res.body?.items?.some((i) => i.item_id === itemId));
}

/** Poll discoverability until it matches `want`; returns what it settled on. */
export async function waitForDiscoverable(
  api: ApiClient,
  binding: Binding,
  itemId: string,
  want: boolean,
  attempts = 6,
): Promise<boolean> {
  let seen = await isDiscoverable(api, binding, itemId);
  for (let i = 0; i < attempts && seen !== want; i++) {
    await sleep(1500);
    seen = await isDiscoverable(api, binding, itemId);
  }
  return seen;
}
