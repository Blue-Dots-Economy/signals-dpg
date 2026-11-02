import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, OctagonX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AuthShell } from '@/components/layout/auth-shell';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/auth-context';
import { useAuthConfig } from '@/hooks/use-auth-config';
import { endBffSession } from '@/lib/bff-session';
import { takePendingConsent } from '@/lib/pending-consent';
import { buildOutstandingConsent, type OutstandingConsent } from '@/lib/consent-gate';
import { takePendingSignupExtras } from '@/lib/pending-signup-extras';
import {
  acceptConsent,
  fetchConsentConfigs,
  getConsentStatus,
  getU18Status,
  submitU18Dob,
} from '@/lib/consent-api';
import { mergeConsentConfig } from '@/hooks/use-consent-config';
import { ConsentModal } from '@/components/consent/consent-modal';
import { U18GuardianFlow } from '@/components/consent/u18/u18-guardian-flow';
import { useNetworkTheme } from '@/theme/theme-provider';
import { getServedScope } from '@/lib/served-binding';
import { setPendingWrongPortal } from '@/lib/pending-wrong-portal';
import { evaluateDomainGate, resolveHeldDomains } from '@/lib/domain-gate';
import { isGuardianConsentRequiredDomain } from '@/lib/guardian-consent';
import { fetchNetworkConfig } from '@/lib/network-api';
import { setStoredSignupDomain } from '@/lib/signup-domain';
import { setUserDomains } from '@/lib/user-api';
import { resolvePostLoginLanding } from '@/lib/post-login-landing';
import { preLoginConsentApplies } from './pre-login-consent';

/** How long to wait for the consent write before landing the user anyway. */
const CONSENT_WRITE_TIMEOUT_MS = 8000;

/** Reject after `ms` so a hanging request can't stall the redirect. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('consent write timed out')), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Writes any consent accepted on the login screen. The accept endpoint is
 * authenticated, so the acceptance was parked across the Keycloak redirect.
 * Non-fatal: a failed write means the gate re-prompts next login.
 */
async function flushPendingConsent(
  persistErrorMessage: string,
  consentAttempt: string | undefined,
): Promise<void> {
  // Honour a parked acceptance only if this same login parked it (the
  // `consentAttempt` from the OIDC state); otherwise it belongs to another
  // abandoned round trip on this device. See pending-consent.ts.
  const pending = takePendingConsent(consentAttempt);
  if (!pending) return;
  // The login screen showed the adult copy; a known minor on a network with
  // U18 documents is asked again by the gates below.
  if (!(await preLoginConsentApplies(pending.network, pending.brand ?? null))) return;
  try {
    // Bounded so a hanging write cannot hold a signed-in user on the spinner.
    await withTimeout(acceptConsent(pending), CONSENT_WRITE_TIMEOUT_MS);
  } catch (consentErr) {
    // eslint-disable-next-line no-console
    console.error('could not persist accepted consent', consentErr);
    toast.error(persistErrorMessage);
  }
}

/**
 * Durable write of the signup form's domain/age. The server parks these in
 * Redis for 30 minutes and swallows failures, so this authenticated write is
 * the backstop against landing with `domains = null` / `age = null` (a null
 * age is fail-closed server-side in a guardian-gated domain). Idempotent with
 * the server-side stash.
 */
async function flushPendingSignupExtras(
  network: string,
  persistErrorMessage: string,
): Promise<void> {
  const signupExtras = takePendingSignupExtras();
  if (!signupExtras) return;
  // Also hand the domain to profile-form-page (one-shot).
  setStoredSignupDomain(network, signupExtras.domain);
  try {
    await setUserDomains([signupExtras.domain]);
  } catch {
    // Best-effort: profile-form falls back to held items if unset.
  }
  if (signupExtras.age !== undefined) {
    try {
      await submitU18Dob({ network, age: signupExtras.age });
    } catch {
      toast.error(persistErrorMessage);
    }
  }
}

/**
 * Authenticated U18 guardian gate. Returns the step the blocking guardian flow
 * should open on, or null when the user is not gated. The Keycloak chooser
 * collects no identifier before login, so DOB capture (`'dob'`) happens here
 * when no birth data is stored.
 *
 * Best-effort: a failed lookup returns null and the user lands. The home-page
 * gate is a backstop and the server-side go-live gate is the real control.
 *
 * `heldDomains` is the caller's already-resolved held-domain list, if any.
 */
async function resolveGuardianGateStep(
  network: string,
  heldDomains: string[] | null,
): Promise<'dob' | 'guardian' | null> {
  try {
    const u18 = await getU18Status(network);
    // `isMinor` is false when age is unknown, which covers every user an
    // aggregator onboarded (bulk upload / form link never capture age).
    // `!hasBirthData` gates them too, so DOB is captured before navigation.
    const needsBirthData = !u18.hasBirthData;
    const needsGuardian = u18.isMinor && !u18.guardianVerified;
    if (!needsBirthData && !needsGuardian) return null;

    // Gate only inside a guardian-gated domain (a provider domain has no U18
    // flow). Judged on domains the user already holds a profile in, as
    // home-page does; a user with no profile is gated at profile creation.
    const held = heldDomains ?? (await resolveHeldDomains(network));

    if (held.length === 0) return null;

    const networkCfg = await fetchNetworkConfig(network);
    const inGatedDomain = held.some((domainId) =>
      isGuardianConsentRequiredDomain(networkCfg, domainId),
    );
    if (!inGatedDomain) return null;

    return u18.hasBirthData ? 'guardian' : 'dob';
  } catch {
    return null;
  }
}

/**
 * Landing page after the Keycloak round trip (`/auth/callback`).
 *
 * The API has already exchanged the code and set the session cookie. This page
 * asks who the session belongs to (which provisions the local `user` mirror on
 * a first login), then runs consent resume, the wrong-portal check, the U18
 * gate and the landing decision. On failure it surfaces the API's own message.
 */
export function OidcCallbackPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { completeKeycloakLogin, signOut } = useAuth();
  const { config: authCfg, isLoading: isConfigLoading } = useAuthConfig();
  const { themeId, brand } = useNetworkTheme();
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  /**
   * Terms/privacy still outstanding: the login-time consent gate. The Keycloak
   * chooser has no identifier to pre-check, so it runs here once the session
   * exists. Without it a migrated user, or one who signed up before a version
   * bump, is never re-prompted.
   */
  const [consentGate, setConsentGate] = useState<
    (OutstandingConsent & { returnTo: string }) | null
  >(null);
  /**
   * A gated minor held on a blocking guardian flow after login and before
   * landing. `initialStep` is `'dob'` when no birth data is stored.
   */
  const [guardianGate, setGuardianGate] = useState<{
    initialStep: 'dob' | 'guardian';
    returnTo: string;
  } | null>(null);

  // Runs once: StrictMode double-invokes effects in development, and the chain
  // below writes parked consent and signup domain/age.
  const exchangeStarted = useRef(false);

  useEffect(() => {
    // Wait for the auth config. The work below runs once behind the ref guard;
    // deciding before `/api/v1/auth/config` resolves would report "not
    // configured" permanently, and Keycloak's still-valid SSO cookie would
    // bounce the user straight back here.
    if (isConfigLoading) return;
    if (exchangeStarted.current) return;

    // Config loaded but names no Keycloak (unconfigured, or the request
    // failed). Say so rather than reporting a broken sign-in.
    if (!authCfg?.keycloak) {
      exchangeStarted.current = true;
      setError(t('auth.oidc_error_unconfigured'));
      return;
    }

    exchangeStarted.current = true;
    let cancelled = false;

    // Not awaited: an effect cannot be async. The body reports its own failures.
    void (async () => {
      try {
        // The API already exchanged the code and set the session cookie; it
        // hands the flow's parameters back on the redirect.
        const params = new URLSearchParams(window.location.search);
        const returnTo = params.get('returnTo') ?? undefined;
        const consentAttempt = params.get('consentAttempt') ?? undefined;
        await completeKeycloakLogin();

        // Per-domain gate: turn away a user who already holds a profile in a
        // domain this deployment does not serve, before any write. The held
        // domains are reused by the U18 gate below.
        let heldDomains: string[] | null = null;

        const scope = getServedScope();
        if (scope) {
          const held = await resolveHeldDomains(scope.network);
          heldDomains = held;
          const gate = evaluateDomainGate(held, scope.domains);
          if (!gate.allow) {
            // Park the reason before signing out: signOut() hands the browser
            // to Keycloak's end-session endpoint, which returns a fresh
            // document, so router state is lost. `WrongPortalToast` reads it
            // back.
            setPendingWrongPortal(gate.heldDomain);
            await signOut();
            // Still reached when no end-session redirect happens. Both paths
            // share the `wrong-portal-block` toast id, so the user sees one
            // message.
            navigate('/auth/login', {
              replace: true,
              state: { wrongPortalDomain: gate.heldDomain },
            });
            return;
          }
        }

        // After the session exists, since the accept endpoint is authenticated.
        await flushPendingConsent(t('auth.toast_consent_persist_error'), consentAttempt);

        // Durable write of the signup form's domain/age.
        await flushPendingSignupExtras(themeId, t('auth.toast_consent_persist_error'));

        // First-login profile redirect. Resolved once so all three exits below
        // share the landing; after the parked writes but before the gates, so
        // a gated user clears the gate first and then lands on the form.
        const landing = await resolvePostLoginLanding(themeId, returnTo ?? '/');

        // U18 guardian gate runs before the adult terms/privacy gate: a gated
        // minor must not see the adult consent screens, because the guardian
        // flow records their consent as guardian-sourced.
        const guardianStep = await resolveGuardianGateStep(themeId, heldDomains);
        if (guardianStep) {
          setGuardianGate({ initialStep: guardianStep, returnTo: landing });
          return;
        }

        // Login-time terms/privacy gate. Runs after the parked signup consent
        // is flushed, so a fresh signup has nothing outstanding.
        const outstanding = await resolveOutstandingConsent(themeId, brand);
        if (outstanding) {
          setConsentGate({ ...outstanding, returnTo: landing });
          return;
        }

        // Navigate regardless of `cancelled`: `completeKeycloakLogin` re-renders
        // this page and may run the effect cleanup, and gating on the flag
        // stranded authenticated users on the spinner. The flag only prevents
        // setState after unmount (see the catch).
        navigate(landing, { replace: true });
      } catch (err) {
        if (cancelled) return;
        setErrorCode(extractCode(err));
        setError(extractMessage(err) ?? t('auth.oidc_error_desc'));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authCfg, brand, completeKeycloakLogin, isConfigLoading, navigate, signOut, t, themeId]);

  /**
   * Accepted the login-time gate. The session exists, so this writes directly.
   * Non-fatal: a failed write means the gate re-prompts next login.
   */
  const handleConsentAccept = async () => {
    if (!consentGate) return;
    const { pendingConsent, returnTo } = consentGate;
    setConsentGate(null);
    try {
      await withTimeout(acceptConsent(pendingConsent), CONSENT_WRITE_TIMEOUT_MS);
    } catch (consentErr) {
      // eslint-disable-next-line no-console
      console.error('could not persist accepted consent', consentErr);
      toast.error(t('auth.toast_consent_persist_error'));
    }
    navigate(returnTo, { replace: true });
  };

  // Blocking guardian gate for a minor, so the ward never sees home until the
  // guardian is verified. `onNotMinor` (DOB says adult) and `onComplete`
  // (guardian verified) both land the user.
  if (guardianGate) {
    return (
      <AuthShell>
        <U18GuardianFlow
          inline
          network={themeId}
          brand={brand === 'standard' ? null : brand}
          initialStep={guardianGate.initialStep}
          onComplete={() => navigate(guardianGate.returnTo, { replace: true })}
          onNotMinor={() => navigate(guardianGate.returnTo, { replace: true })}
          onLogout={() => {
            void signOut();
            navigate('/auth/login', { replace: true });
          }}
        />
      </AuthShell>
    );
  }

  if (consentGate) {
    return (
      <>
        <ConsentModal
          open={true}
          mode="gate"
          initialTab="privacy"
          config={consentGate.config}
          variant={consentGate.variant}
          onAccept={() => {
            void handleConsentAccept();
          }}
        />
        <AuthShell>
          <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t('auth.oidc_signing_in')}</p>
          </div>
        </AuthShell>
      </>
    );
  }

  if (!error) {
    return (
      <AuthShell>
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('auth.oidc_signing_in')}</p>
        </div>
      </AuthShell>
    );
  }

  /**
   * Ends the session so the user can sign in as someone else. A forced
   * re-prompt (`prompt=login`) re-authenticates the current user, so naming a
   * different one makes Keycloak report `invalid_user_credentials` ("Invalid
   * username or password"). Only ending the session clears the authenticated
   * user. `endBffSession` destroys the server-side session and hands off to
   * Keycloak's end-session endpoint.
   */
  const switchAccount = async (): Promise<void> => {
    try {
      const ended = await endBffSession();
      // `endBffSession` navigates to Keycloak itself on success. `false` means
      // the server did not end the session and nothing is navigating.
      if (!ended) navigate('/auth/login', { replace: true });
    } catch {
      navigate('/auth/login', { replace: true });
    }
  };

  // The API's message is English, so prefer a localised equivalent when one
  // exists.
  const body = LOCALISED_REJECTION_KEYS[errorCode ?? ''] ?? '';

  return (
    <AuthShell>
      <div className="mx-auto flex max-w-md flex-col gap-4 py-16">
        <Alert variant="destructive">
          <OctagonX className="size-4" />
          <AlertTitle>{t('auth.oidc_error_title')}</AlertTitle>
          <AlertDescription>{body ? t(body) : error}</AlertDescription>
        </Alert>
        {isRecoverableIdentity(errorCode) ? (
          // "Back to sign in" would loop: Keycloak's still-valid SSO cookie
          // hands back the same identity and the same error.
          <Button onClick={() => void switchAccount()}>{t('auth.switch_account')}</Button>
        ) : (
          <Button onClick={() => navigate('/auth/login', { replace: true })}>
            {t('auth.oidc_retry')}
          </Button>
        )}
      </div>
    </AuthShell>
  );
}

/**
 * Rejections whose copy is localised, keyed by the API's error code. Others
 * fall back to the API's English message.
 */
const LOCALISED_REJECTION_KEYS: Readonly<Record<string, string>> = {
  TOKEN_AGGREGATOR_ACCOUNT: 'auth.aggregator_account_no_signals',
  TOKEN_ROLE_REJECTED: 'auth.non_participant_no_signals',
};

/**
 * Whether signing out and back in could succeed: only when the realm handed
 * over the wrong identity. Offering it for KEYCLOAK_NOT_CONFIGURED or
 * USER_BANNED would loop.
 */
function isRecoverableIdentity(errorCode: string | null | undefined): boolean {
  return errorCode === 'TOKEN_AGGREGATOR_ACCOUNT' || errorCode === 'TOKEN_ROLE_REJECTED';
}

/**
 * Reads the API's machine-readable error code, when present.
 * `TOKEN_AGGREGATOR_ACCOUNT` means the shared realm's SSO session belongs to an
 * aggregator account.
 */
function extractCode(err: unknown): string | null {
  const code = (err as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code;
  return typeof code === 'string' && code !== '' ? code : null;
}

/**
 * Pulls a human-readable reason out of a failure, usually an axios error from
 * `/api/v1/auth/me` carrying the API's `{ code, error, message }`. A failed
 * code exchange never reaches this page: the API redirects to
 * `/auth/login?auth_error=1` instead.
 */
function extractMessage(err: unknown): string | null {
  const apiMessage = (
    err as { response?: { data?: { message?: unknown } } } | null
  )?.response?.data?.message;
  if (typeof apiMessage === 'string' && apiMessage.trim() !== '') return apiMessage;

  if (err instanceof Error && err.message.trim() !== '') return err.message;
  return null;
}

/**
 * Which account consents this signed-in user still owes, or null. Uses the
 * authenticated status endpoint. Fails open: a consent-service blip must not
 * block a login that already succeeded; the user is re-prompted next time.
 */
async function resolveOutstandingConsent(
  network: string,
  brand: string,
): Promise<OutstandingConsent | null> {
  try {
    const [status, configEntries] = await Promise.all([
      getConsentStatus(network),
      fetchConsentConfigs(network),
    ]);

    const networkDefault = configEntries.find((e) => e.brand === null);
    if (!networkDefault) return null;

    const brandEntry =
      brand && brand !== 'standard' ? configEntries.find((e) => e.brand === brand) : undefined;
    const config = mergeConsentConfig(networkDefault.schema, brandEntry?.schema);

    return buildOutstandingConsent({
      config,
      network,
      brand,
      // A returning user or a version bump, not a signup.
      source: 'login',
      accepted: status.statuses,
      variant: status.variant,
    });
  } catch {
    return null;
  }
}
