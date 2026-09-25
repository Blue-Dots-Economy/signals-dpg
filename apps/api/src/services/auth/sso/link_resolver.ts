import type { KeycloakAdminClient } from '@/services/auth/keycloak_admin';
import type { SsoIdentity, SsoResult } from '@/services/auth/sso/types';

/**
 * Decide which Keycloak account a verified partner user becomes.
 *
 * The SSO API decides and Keycloak executes: the answer is the
 * `preferred_username` put in the id_token, and the realm's first-login flow
 * auto-links on username. Because only this function sets that claim — and
 * never from partner-supplied email — linking is on the phone number alone.
 *
 * Rules (spec §6), in this order:
 *   - an account is already linked to this partner user → that account
 *     (returning user — whatever number the partner has on file now)
 *   - no account holds the number, partner verified it  → new account,
 *     username = the number
 *   - no account holds the number, not verified         → phone-unverified
 *   - one account, linked to another partner user        → link-conflict
 *   - one account, not linked, verified                  → link it
 *   - one account, not linked, unverified                → phone-unverified
 *   - several accounts (by link or by number)            → link-conflict
 *
 * The link comes first because it is what Keycloak itself logs in through: a
 * returning user whose partner number changed would otherwise be sent to a
 * new username while Keycloak still logs them into the linked account, and
 * the callback refuses that mismatch on every attempt.
 *
 * An unverified number never becomes an account's username or phone, new or
 * existing: the real owner's phone-OTP login would later open that account.
 *
 * The phone lookup is on the `phoneNumber` attribute. That attribute is
 * declared on every realm by `infra/keycloak/init/apply-user-profile.sh`
 * (without it phone OTP login itself does not work), so every account holding
 * a number carries it — including those whose username is that number.
 */

type AdminLookups = Pick<
  KeycloakAdminClient,
  'findByIdpLink' | 'findByPhone' | 'federatedIdentities'
>;

export interface LinkResolverDeps {
  admin: AdminLookups | null;
  /** The realm's alias for the SSO identity provider. */
  idpAlias: string;
}

export async function resolveAccountLink(
  identity: SsoIdentity,
  deps: LinkResolverDeps
): Promise<SsoResult<{ preferredUsername: string }>> {
  if (!deps.admin) {
    return {
      ok: false,
      reason: 'provider-unavailable',
      detail: 'Keycloak Admin-REST client is not configured',
    };
  }
  const admin = deps.admin;

  try {
    const linked = await admin.findByIdpLink(deps.idpAlias, identity.subject);
    if (linked.length > 1) {
      return { ok: false, reason: 'link-conflict', detail: 'partner user linked to several accounts' };
    }
    if (linked.length === 1) {
      const account = linked[0] as { id: string; username?: string };
      return account.username
        ? { ok: true, value: { preferredUsername: account.username } }
        : { ok: false, reason: 'link-conflict', detail: 'linked account has no username' };
    }

    const candidates = await admin.findByPhone(identity.phone);

    if (candidates.length === 0) {
      if (!identity.phoneVerified) return { ok: false, reason: 'phone-unverified' };
      return { ok: true, value: { preferredUsername: identity.phone } };
    }
    if (candidates.length > 1) {
      return { ok: false, reason: 'link-conflict', detail: 'number matches several accounts' };
    }

    const account = candidates[0] as { id: string; username?: string };
    if (!account.username) {
      return { ok: false, reason: 'link-conflict', detail: 'matched account has no username' };
    }

    // Not linked to THIS partner user (the link lookup above found nothing),
    // so any link of ours on this account belongs to someone else.
    const links = await admin.federatedIdentities(account.id);
    if (links.some((l) => l.identityProvider === deps.idpAlias)) {
      return { ok: false, reason: 'link-conflict', detail: 'account linked to another partner user' };
    }

    if (!identity.phoneVerified) {
      return { ok: false, reason: 'phone-unverified' };
    }
    return { ok: true, value: { preferredUsername: account.username } };
  } catch (err) {
    return {
      ok: false,
      reason: 'provider-unavailable',
      detail: err instanceof Error ? err.message : 'Keycloak lookup failed',
    };
  }
}
