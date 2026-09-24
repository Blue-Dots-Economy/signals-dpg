/**
 * Partner-portal single sign-on — shared types.
 *
 * A *provider* is one partner portal (NCS today). It turns the query string the
 * partner redirects the browser with into a verified `SsoIdentity`, or a
 * `SsoFailureReason`. Everything after that — the Keycloak hop, account
 * linking, the draft profile — is provider-agnostic.
 *
 * See docs/superpowers/specs/2026-09-24-external-idp-bridge-ncs-sso-design.md.
 */

/**
 * Why an SSO login was refused. Kebab-case because it travels to the UI as
 * `/auth/sso/error?reason=<code>` — never anything from the request itself.
 */
export type SsoFailureReason =
  /** Missing / malformed parameters, bad signature, or the partner said no. */
  | 'link-invalid'
  /** The partner link is past its lifetime. */
  | 'link-expired'
  /** This exact link was already used. */
  | 'link-reused'
  /** The partner API is down, slow, or refusing us. Retryable. */
  | 'provider-unavailable'
  /** The partner account is not active. */
  | 'account-inactive'
  /** An existing Bluedots account holds this number, but the partner has not verified it. */
  | 'phone-unverified'
  /** The number is tied to a different partner account, or to several Bluedots accounts. */
  | 'link-conflict'
  /** The login could not be completed (flow expired, Keycloak refused, …). */
  | 'session-expired';

export type SsoResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: SsoFailureReason; detail?: string };

/** A partner user, verified and reduced to what Bluedots needs. */
export interface SsoIdentity {
  /** Provider id, e.g. `ncs`. */
  provider: string;
  /** The partner's own stable user id. */
  providerUserId: string;
  /** `<provider>:<providerUserId>` — the `sub` Keycloak links on. */
  subject: string;
  fullName: string | null;
  /** E.164, e.g. `+919730862967`. Mandatory: it is the account-linking key. */
  phone: string;
  phoneVerified: boolean;
  email: string | null;
  emailVerified: boolean;
  /** Partner role, e.g. `JOBSEEKER`. Maps to a Signals domain. */
  role: string | null;
  /** The partner's raw user fields, for profile mapping. */
  attributes: Record<string, unknown>;
}

/** What a provider hands back for a verified link. */
export interface SsoVerifiedLink {
  identity: SsoIdentity;
  /** App path to land on (already passed through `safeReturnTo`). */
  returnTo: string;
  /** UI origin to land on, if the provider pins one. */
  appOrigin?: string;
}

export interface SsoProvider {
  readonly id: string;
  /** Verify the partner's redirect query string. Never throws. */
  verify(query: Record<string, unknown>): Promise<SsoResult<SsoVerifiedLink>>;
  /** UI origin for error pages before a link is verified. */
  readonly appOrigin?: string;
}
