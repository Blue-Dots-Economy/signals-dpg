import type { ApiClient } from './api-client.js';
import type { E2EConfig } from './config.js';
import type { Capabilities } from './capabilities.js';
import { resolveBinding, buildMinimalItemState, type Binding } from './schema.js';
import {
  acceptCoreConsent,
  login,
  resolveAuthProvider,
  signup,
  type AuthContext,
  type Identity,
  type Session,
} from './auth.js';
import { newEmail, newName, newPhone } from './identities.js';
import { recordCreated } from './ledger.js';

/**
 * A proven-adult age so profiles in guardian-gated domains can go live (an
 * unknown age on a gated domain is fail-closed → stays draft). #331 replaced the
 * date of birth with this age snapshot everywhere, including `/consent/u18/dob`.
 */
const ADULT_AGE = 35;

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

/**
 * Which account-creation path to use for a throwaway persona.
 *
 * Service provisioning is preferred whenever credentials exist, even on an
 * `allowed` target. Public self-signup is rate-limited per IP
 * (`MAX_PER_IP = 10` per hour in `services/auth/self_signup.ts`), which a suite
 * that creates a fresh persona per test exhausts almost immediately — every
 * later test then dies on `SIGNUP_RATE_LIMITED` for a reason that has nothing to
 * do with what it was asserting. `POST /api/v1/admin/participant` is the
 * intended bulk path and carries no such limit; under Keycloak it creates the
 * realm identity too, so the persona can still log in.
 *
 * Journeys that are specifically ABOUT self-signup (A, B) call `signup()`
 * directly and are unaffected by this preference.
 */
export function provisioningMethod(cfg: E2EConfig, caps: Capabilities): 'signup' | 'service' | null {
  if (caps.serviceAuth) return 'service';
  if (cfg.selfSignupMode === 'allowed') return 'signup';
  return null;
}

/**
 * The provider, when an AuthContext is available. Without one the caller can
 * only be on the better-auth path (the Keycloak driver needs the request
 * context), so default there rather than making every call site pass it.
 */
async function resolveProvider(
  api: ApiClient,
  cfg: E2EConfig,
  authCtx?: AuthContext,
): Promise<'betterauth' | 'keycloak'> {
  if (!authCtx) return 'betterauth';
  return resolveAuthProvider(api, cfg);
}

/**
 * Pick an identity channel the target can actually deliver an OTP on.
 *
 * Under Keycloak the login OTP is random and must be read back from its delivery
 * channel: email → Mailpit, phone → the Keycloak container log. So when the
 * provider is Keycloak, prefer whichever channel has a configured oracle and
 * only fall back to phone when the log container is the one available.
 */
export function freshIdentity(
  cfg: E2EConfig,
  label: string,
  opts: { provider?: 'betterauth' | 'keycloak' } = {},
): Identity {
  const emailAllowed = cfg.loginChannels.includes('email');
  const phoneAllowed = cfg.loginChannels.includes('phone');

  if (opts.provider === 'keycloak') {
    if (emailAllowed && cfg.mailpitUrl) return { channel: 'email', value: newEmail(label) };
    if (phoneAllowed && cfg.keycloakLogContainer) return { channel: 'phone', value: newPhone() };
    throw new Error(
      '[e2e] keycloak target has no readable OTP channel: set config.mailpitUrl (email) or config.keycloakLogContainer (phone)',
    );
  }

  // better-auth: the code is the fixed CREATE_TEST_OTP value on either channel.
  const channel = phoneAllowed ? 'phone' : 'email';
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
  opts: { domainKey?: string; label?: string; authCtx?: AuthContext } = {},
): Promise<LiveProfile> {
  const label = opts.label ?? 'user';
  const displayName = newName(label);
  const binding = await resolveBinding(api, opts.domainKey);
  const itemState = buildMinimalItemState(binding.schema);
  const method = provisioningMethod(cfg, caps);
  if (!method) throw new Error('[e2e] cannot create users: target is gated and no service credentials configured');
  const provider = await resolveProvider(api, cfg, opts.authCtx);

  let session: Session;
  let itemId: string;

  if (method === 'signup') {
    const id = freshIdentity(cfg, label, { provider });
    // The Keycloak path needs the domain + age at signup time (they are written
    // onto the Keycloak identity); better-auth ignores the extra options.
    session = await signup(api, id, displayName, opts.authCtx, {
      domain: binding.domain,
      age: ADULT_AGE,
    });
    await acceptCoreConsent(session, binding.network, 'signup');
    // Establish a proven-adult DOB so guardian-gated domains (fail-closed on null
    // DOB) promote to live. Best-effort: older builds lack the u18 endpoint.
    await session.client.post('/api/v1/consent/u18/dob', { network: binding.network, age: ADULT_AGE });
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
    recordCreated('items', itemId);
    // The user row itself is ledgered inside signup() — it's the one choke
    // point every signup path (direct journeys included) goes through.
  } else {
    // service provisioning: create the participant + item, then log in as them.
    const id = freshIdentity(cfg, label, { provider });
    const idField = id.channel === 'phone' ? { phone_number: id.value } : { email: id.value };
    // Consent goes through the `compliance` array (#309), NOT the older
    // `terms_accepted` / `privacy_accepted` booleans — those are no longer read,
    // so a participant provisioned with them comes back `consent_recorded: 0`
    // and the profile stays `draft` forever. With all three keys the route
    // records consent inline and the classifier promotes to `live` on create.
    // Age is the stored snapshot (#331); date_of_birth is not persisted.
    const prov = await service.post<{ user_id: string; items: Array<{ item_id: string }> }>('/api/v1/admin/participant', {
      ...idField,
      name: displayName,
      age: ADULT_AGE,
      compliance: [
        { key: 'user_terms', value: true },
        { key: 'user_privacy', value: true },
        { key: 'profile_creation', value: true },
      ],
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
    recordCreated('items', itemId);
    // Unlike the signup branch, this path never calls signup() — the
    // participant (and its user row) is minted directly by admin/participant,
    // so this is the one place that knows its id.
    recordCreated('user', prov.body.user_id);
    session = await login(api, id, opts.authCtx);
    await acceptCoreConsent(session, binding.network, 'login');
    // The guardian gate keys off the U18 birth data, not the user row's DOB from
    // provisioning — set it so a gated-domain adult profile can promote to live.
    await session.client.post('/api/v1/consent/u18/dob', { network: binding.network, age: ADULT_AGE });
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
  // Fail here, not three assertions later. A persona that silently comes back
  // `draft` turns every downstream action into a confusing `PROFILE_NOT_LIVE`
  // that looks like an action bug rather than a provisioning one.
  if (item.lifecycle_status !== 'live') {
    throw new Error(
      `[e2e] persona "${label}" did not reach live (status="${item.lifecycle_status}", item=${itemId}, method=${method}). ` +
        'Check that profile_creation consent was recorded and every required schema field is present.',
    );
  }

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
