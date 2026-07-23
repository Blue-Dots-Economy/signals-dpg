import type { ApiClient } from './api-client.js';
import type { E2EConfig } from './config.js';
import type { Capabilities } from './capabilities.js';
import { resolveBinding, buildMinimalItemState, type Binding } from './schema.js';
import { acceptCoreConsent, login, signup, type Identity, type Session } from './auth.js';
import { newEmail, newName, newPhone } from './identities.js';

/** A proven-adult DOB so profiles in guardian-gated domains can go live
 *  (a null DOB on a gated domain is fail-closed → stays draft). */
const ADULT_DOB = '1990-01-01';

export interface ItemRef {
  item_network: string;
  item_domain: string;
  item_type: string;
  item_id: string;
}

export interface LiveProfile {
  session: Session;
  userId: string;
  binding: Binding;
  itemId: string;
  itemInstanceUrl: string;
  lifecycleStatus: string;
  /** The display name the user was created with (for UI avatar targeting). */
  displayName: string;
  /** The (real, unmasked) item_state the profile was created with. */
  itemState: Record<string, unknown>;
  /** For use as an action `source_item`. */
  sourceRef: ItemRef;
  /** For use as an action `target_item` (includes item_instance_url). */
  targetRef: ItemRef & { item_instance_url: string };
}

/** Which account-creation path the target supports, given config + capabilities. */
export function provisioningMethod(cfg: E2EConfig, caps: Capabilities): 'signup' | 'service' | null {
  if (cfg.selfSignupMode === 'allowed') return 'signup';
  if (caps.serviceAuth) return 'service';
  return null;
}

function freshIdentity(cfg: E2EConfig, label: string): Identity {
  const channel = cfg.loginChannels.includes('phone') ? 'phone' : 'email';
  return channel === 'phone' ? { channel, value: newPhone() } : { channel, value: newEmail(label) };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Read the caller's own item by id. `/item/fetch` has a ~1s Redis cache, so a
 * just-created item can transiently be absent under concurrent load; poll past
 * the TTL before giving up rather than reading once.
 */
async function fetchOwnItem(
  session: Session,
  binding: Binding,
  itemId: string,
): Promise<{ lifecycle_status?: string; item_instance_url: string } | undefined> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await session.client.get<{ items: Array<{ item_id: string; lifecycle_status?: string; item_instance_url: string }> }>(
      `/api/v1/item/fetch?item_network=${encodeURIComponent(binding.network)}&item_domain=${encodeURIComponent(binding.domain)}&item_type=${encodeURIComponent(binding.item_type)}&limit=100`,
    );
    const found = res.body?.items?.find((i) => i.item_id === itemId);
    if (found) return found;
    await sleep(1200);
  }
  return undefined;
}

/**
 * Create a user with a LIVE profile in the given domain, using whichever method
 * the target supports. Callers should gate with `provisioningMethod(...) !== null`.
 */
export async function createLiveProfileUser(
  api: ApiClient,
  service: ApiClient,
  cfg: E2EConfig,
  caps: Capabilities,
  opts: { domainKey?: string; label?: string } = {},
): Promise<LiveProfile> {
  const label = opts.label ?? 'user';
  const displayName = newName(label);
  const binding = await resolveBinding(api, opts.domainKey);
  const itemState = buildMinimalItemState(binding.schema);
  const method = provisioningMethod(cfg, caps);
  if (!method) throw new Error('[e2e] cannot create users: target is gated and no service credentials configured');

  let session: Session;
  let itemId: string;

  if (method === 'signup') {
    const id = freshIdentity(cfg, label);
    session = await signup(api, id, displayName);
    await acceptCoreConsent(session, binding.network, 'signup');
    // Establish a proven-adult DOB so guardian-gated domains (fail-closed on null
    // DOB) promote to live. Best-effort: older builds lack the u18 endpoint.
    await session.client.post('/api/v1/consent/u18/dob', { network: binding.network, dateOfBirth: ADULT_DOB });
    // No explicit domain registration needed: a fresh user has empty
    // user.domains, so the first item/create bootstraps their domain (see
    // create_item.ts single-role lock). Each test user creates one profile.
    const create = await session.client.post<{ item_id: string }>('/api/v1/item/create', {
      item_network: binding.network,
      item_domain: binding.domain,
      item_type: binding.item_type,
      item_state: itemState,
      consent: { category: 'profile_creation', version: 1 },
    });
    if (create.status !== 201 || !create.body?.item_id) {
      throw new Error(`[e2e] item/create failed: ${create.status} ${JSON.stringify(create.body)}`);
    }
    itemId = create.body.item_id;
  } else {
    // service provisioning: create the participant + item, then log in as them.
    const id = freshIdentity(cfg, label);
    const idField = id.channel === 'phone' ? { phone_number: id.value } : { email: id.value };
    const prov = await service.post<{ user_id: string; items: Array<{ item_id: string }> }>('/api/v1/admin/participant', {
      ...idField,
      name: displayName,
      date_of_birth: ADULT_DOB,
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      network: binding.network,
      domain: binding.domain,
      item_type: binding.item_type,
      item_state: itemState,
    });
    if (prov.status !== 200 || !prov.body?.items?.[0]?.item_id) {
      throw new Error(`[e2e] admin/participant provisioning failed: ${prov.status} ${JSON.stringify(prov.body)}`);
    }
    itemId = prov.body.items[0].item_id;
    session = await login(api, id);
    await acceptCoreConsent(session, binding.network, 'login');
    // The guardian gate keys off the U18 birth data, not the user row's DOB from
    // provisioning — set it so a gated-domain adult profile can promote to live.
    await session.client.post('/api/v1/consent/u18/dob', { network: binding.network, dateOfBirth: ADULT_DOB });
  }

  // Ensure the profile is live: promote via profile-accept if still draft.
  let item = await fetchOwnItem(session, binding, itemId);
  if (item && item.lifecycle_status !== 'live') {
    const pa = await session.client.post('/api/v1/consent/profile-accept', {
      network: binding.network,
      item_domain: binding.domain,
      item_type: binding.item_type,
      item_id: itemId,
      version: 1,
    });
    if (process.env.E2E_DEBUG) {
      // eslint-disable-next-line no-console
      console.error('[profile-accept]', pa.status, JSON.stringify(pa.body), 'itemBefore', item.lifecycle_status);
    }
    // Promotion is immediate server-side, but the 1s item-fetch cache can still
    // serve the pre-promotion (draft) snapshot — poll for `live` past the TTL.
    for (let i = 0; i < 5; i++) {
      await sleep(1200);
      item = await fetchOwnItem(session, binding, itemId);
      if (item?.lifecycle_status === 'live') break;
    }
  }
  if (!item) throw new Error(`[e2e] created item ${itemId} not found on own fetch`);

  const sourceRef: ItemRef = { item_network: binding.network, item_domain: binding.domain, item_type: binding.item_type, item_id: itemId };
  return {
    session,
    userId: session.userId,
    binding,
    itemId,
    itemInstanceUrl: item.item_instance_url,
    lifecycleStatus: item.lifecycle_status ?? 'unknown',
    displayName,
    itemState,
    sourceRef,
    targetRef: { ...sourceRef, item_instance_url: item.item_instance_url },
  };
}
