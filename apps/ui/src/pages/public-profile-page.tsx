import * as React from 'react';
import { useParams, useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertCircle, ArrowLeft, Copy, Loader2 } from 'lucide-react';
import type { RJSFSchema } from '@rjsf/utils';
import { useResolvedNetwork } from '@/hooks/use-network-config';
import { useItemDetail } from '@/hooks/use-item-detail';
import { useMyItems } from '@/hooks/use-my-items';
import { useActiveProfile } from '@/hooks/use-active-profile';
import { useActions } from '@/hooks/use-actions';
import { useAuth } from '@/contexts/auth-context';
import { useNetworkTheme } from '@/theme/theme-provider';
import { resolveCardFields, formatCardValue } from '@/components/cards/resolve-card-fields';
import { UriValue } from '@/components/cards/uri-value';
import { buildProfileShareUrl, copyTextToClipboard } from '@/lib/share-profile';
import { queryKeys } from '@/lib/query-keys';
import type { Item } from '@/lib/item-api';
import type { User } from '@/lib/auth-api';
import type { DotActionSchema, DotNetworkSchema } from '@/engine/types';
import { performAction, ACTION_CONSENT_SENTINEL } from '@/lib/action-api';
import {
  getActionsForDomain,
  resolveTargetInstanceUrl,
  computeOpenActionItemIds,
} from '@/lib/profile-actions';
import { ActionAbortedError } from '@/lib/action-abort';
import { isGuardianConsentRequiredDomain } from '@/lib/guardian-consent';
import { getU18Status, type U18StatusResponse } from '@/lib/consent-api';
import { apiConfig } from '@/lib/api-config';
import { ActionHandler } from '@/components/actions/action-handler';
import { ActionButton } from '@/components/cards/action-button';
import { MatchScoreButton, MatchScoreModal } from '@/components/match-score';
import { useMatchScore } from '@/hooks/use-match-score';
import { AppSidebar } from '@/components/layout/sidebar';
import { PortalHeader } from '@/components/layout/portal-header';
import { ThemeModeToggle } from '@/components/layout/theme-mode-toggle';
import { UserMenu } from '@/components/auth/user-menu';
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HERO_GRADIENT =
  'linear-gradient(135deg, var(--primary), color-mix(in srgb, var(--primary), white 32%))';

function titleCaseDomain(id: string): string {
  return id.replaceAll('_', ' ').replaceAll(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Lean top bar shared by every state on this page — no search / view-toggle /
 * filters / notifications, none of which are relevant on a single-profile
 * page. Branding lives in the sidebar header (PortalHeader), so this is just
 * the mobile sidebar trigger plus the share + explore + auth affordances.
 * "Copy link" is disabled until a live item has loaded — there is nothing
 * shareable before then.
 */
function ProfileTopBar({
  networkId,
  item,
  isAuthenticated,
  showLogo,
  onBack,
}: Readonly<{
  networkId?: string;
  item: Item | null;
  isAuthenticated: boolean;
  /** Navigate back to where the viewer came from (falls back to the map view). */
  onBack: () => void;
  /**
   * Anonymous mode has no sidebar, so the brand logo lives in the app bar (left);
   * the authenticated mode keeps the sidebar and shows the mobile sidebar trigger
   * instead. The header title renders in both modes.
   */
  showLogo: boolean;
}>) {
  const { t } = useTranslation();

  const onCopyLink = async () => {
    if (!item) return;
    const ok = await copyTextToClipboard(buildProfileShareUrl(item));
    if (ok) toast.success(t('share.copied', 'Link copied to clipboard'));
    else toast.error(t('share.copy_failed', 'Could not copy the link'));
  };

  return (
    <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur sm:px-6">
      {showLogo && <PortalHeader />}
      {!showLogo && <SidebarTrigger className="md:hidden" />}
      {/* Anonymous mode has the logo in the app bar (no sidebar edge), so add a
          full-height divider after it — mirroring the sidebar's right border in
          the authenticated layout. The back button + title then sit in the
          "content" region, same slot as the logged-in view. */}
      {showLogo && <span className="w-px shrink-0 self-stretch bg-border" aria-hidden="true" />}
      <button
        type="button"
        onClick={onBack}
        aria-label={t('public_profile.back', 'Back to map')}
        title={t('public_profile.back', 'Back to map')}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-foreground hover:bg-muted"
      >
        <ArrowLeft className="h-5 w-5" aria-hidden="true" />
      </button>
      <span className="text-lg font-semibold text-foreground">
        {t('public_profile.app_bar_title', 'Profile preview')}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <ThemeModeToggle />
        <button
          type="button"
          onClick={onCopyLink}
          disabled={!item}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Copy className="h-4 w-4" aria-hidden="true" />
          {t('public_profile.copy_link', 'Copy link')}
        </button>
        <a
          href={`/?network=${encodeURIComponent(networkId ?? '')}`}
          className="inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
          style={{ background: 'var(--primary)' }}
        >
          {t('public_profile.open_in_app', 'Explore more')}
        </a>
        {isAuthenticated && <UserMenu />}
      </div>
    </header>
  );
}

/** Centered content well used by every non-hero state (loading / error / unavailable). */
function StateWell({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-[60dvh] items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm text-center">{children}</div>
    </div>
  );
}

function UnavailableState({ networkId }: Readonly<{ networkId?: string }>) {
  const { t } = useTranslation();
  const { theme } = useNetworkTheme();
  return (
    <StateWell>
      <AlertCircle className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden="true" />
      <h1 className="mt-4 text-lg font-semibold text-foreground">
        {t('public_profile.unavailable_title', 'Profile unavailable')}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t(
          'public_profile.unavailable_body',
          'This profile is no longer available, or the link is invalid.'
        )}
      </p>
      <a
        href={`/?network=${encodeURIComponent(networkId ?? '')}`}
        className="mt-5 inline-flex items-center rounded-lg px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
        style={{ background: 'var(--primary)' }}
      >
        {t('public_profile.explore', 'Explore {{brand}}', { brand: theme.name })}
      </a>
    </StateWell>
  );
}

/**
 * Apply/Connect + See-Match-Score row shown to a logged-in viewer of SOMEONE
 * ELSE's live profile, using their active profile as the source (full parity
 * with the map/list card). Reuses the shared action flow (`ActionHandler` →
 * `performAction`) and match-score wiring — all already themed with the app's
 * Button variants, so colors match automatically.
 *
 * Renders one of three states, resolved from the active profile:
 *  - no active profile / no compatible interaction → a muted "switch profile" hint,
 *  - a draft active profile → a muted "complete profile" hint,
 *  - otherwise → the Match Score control + one ActionButton per available action.
 * Hooks run unconditionally above these branches. The route stays public and
 * all data stays masked; the action itself goes through the authenticated
 * server flow (interaction matrix + ownership + consent + guardian OTP).
 */
function ProfileActionRow({
  net,
  item,
  activeItem,
  viewedDomain,
  user,
  networkItemName,
}: Readonly<{
  net: DotNetworkSchema | null;
  item: Item;
  activeItem: Item | null;
  viewedDomain: string;
  user: User | null;
  networkItemName: string;
}>) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [matchOpen, setMatchOpen] = React.useState(false);

  // U18 minor status for the viewer (source profile owner), mirroring
  // home-page.tsx: only an authenticated user on a network has stored birth
  // data. On failure the status stays null (adult path) — never leave a minor
  // ungated, which the server also enforces regardless of this UI signal.
  const [u18Status, setU18Status] = React.useState<U18StatusResponse | null>(null);
  React.useEffect(() => {
    if (!user || !net) {
      setU18Status(null);
      return;
    }
    let cancelled = false;
    getU18Status(net.id)
      .then((s) => { if (!cancelled) setU18Status(s); })
      .catch(() => { if (!cancelled) setU18Status(null); });
    return () => { cancelled = true; };
  }, [user, net]);

  const {
    score,
    isLoading: matchLoading,
    error: matchError,
    calculate,
    recalculate,
  } = useMatchScore({ localItem: activeItem, networkItem: item });

  const actions = React.useMemo(
    () => getActionsForDomain(net, activeItem?.item_domain ?? '', viewedDomain),
    [net, activeItem?.item_domain, viewedDomain],
  );

  // Disable Apply/Connect when the active profile already has an OPEN action
  // (either direction) with the viewed item — parity with the list/map. Actions
  // only fetch for a signed-in user (the endpoint 401s anonymously; the hook
  // also self-gates on auth).
  const { data: myActionsData } = useActions('all', { enabled: !!user, limit: 100 });
  const hasOpenActionWithViewed = React.useMemo(() => {
    if (!activeItem) return false;
    return computeOpenActionItemIds(myActionsData?.actions ?? [], activeItem.item_id).has(
      item.item_id,
    );
  }, [myActionsData, activeItem, item.item_id]);

  const onActionSubmit = React.useCallback(
    async (
      actionType: string,
      _actionSchema: DotActionSchema,
      formData: Record<string, unknown>,
      _targetItemId: string,
      guardianOtp?: string,
    ) => {
      if (!activeItem) throw new ActionAbortedError('no active profile');
      // Draft source profile can't act — surface the "complete your profile"
      // hint and abort (ActionAbortedError suppresses the generic error toast).
      if (activeItem.lifecycle_status === 'draft') {
        toast.warning(
          t('public_profile.complete_profile_hint', 'Complete your active profile to apply or connect.'),
        );
        throw new ActionAbortedError('source profile is draft');
      }
      if (!user) {
        toast.error(t('public_profile.sign_in', 'Sign in'));
        throw new Error('No user');
      }

      // Extract the consent sentinel ConsentCheckbox smuggled through the form
      // data; it must not appear in requirements_snapshot sent to the server.
      const { [ACTION_CONSENT_SENTINEL]: consentRaw, ...requirementsSnapshot } = formData;
      const consent =
        consentRaw &&
        typeof consentRaw === 'object' &&
        (consentRaw as { acknowledged?: unknown }).acknowledged === true &&
        typeof (consentRaw as { version?: unknown }).version === 'number'
          ? {
              acknowledged: true as const,
              version: (consentRaw as { version: number }).version,
              brand: (consentRaw as { brand?: string | null }).brand,
            }
          : undefined;

      const currentApiUrl = apiConfig.getUrl();
      const sourceInstanceUrl = activeItem.item_instance_url?.includes('localhost')
        ? currentApiUrl
        : resolveTargetInstanceUrl(activeItem, net, currentApiUrl);
      const targetInstanceUrl = item.item_instance_url?.includes('localhost')
        ? currentApiUrl
        : resolveTargetInstanceUrl(item, net, currentApiUrl);

      await performAction(
        {
          action_type: actionType,
          source_item: {
            item_network: activeItem.item_network,
            item_domain: activeItem.item_domain,
            item_type: activeItem.item_type,
            item_id: activeItem.item_id,
          },
          target_item: {
            item_network: item.item_network,
            item_domain: item.item_domain,
            item_type: item.item_type,
            item_id: item.item_id,
            item_instance_url: targetInstanceUrl,
          },
          requirements_snapshot: requirementsSnapshot,
          ...(consent ? { consent } : {}),
        },
        sourceInstanceUrl, // call the SOURCE instance (where the active profile lives)
        guardianOtp,
      );

      // Surface the new action without waiting for the 60s poll.
      queryClient.invalidateQueries({ queryKey: queryKeys.actions.all });
      toast.success(
        t('public_profile.action_sent', '{{action}} request sent', {
          action: actionType.charAt(0).toUpperCase() + actionType.slice(1),
        }),
      );
    },
    [activeItem, item, net, user, queryClient, t],
  );

  // A draft active profile can't act at all — completing it is the blocker, so
  // that hint takes precedence over the compatibility hint below.
  if (activeItem?.lifecycle_status === 'draft') {
    return (
      <p className="mt-4 text-sm text-muted-foreground">
        {t('public_profile.complete_profile_hint', 'Complete your active profile to apply or connect.')}
      </p>
    );
  }

  if (!activeItem || actions.length === 0) {
    return (
      <p className="mt-4 text-sm text-muted-foreground">
        {t('public_profile.switch_profile_hint', 'Switch to a compatible profile in the sidebar to apply or connect.')}
      </p>
    );
  }

  return (
    <>
      <ActionHandler
        onActionSubmit={onActionSubmit}
        // Parity with home-page: only confirm-before-OTP when the viewer is
        // actually a minor AND their active-profile domain requires guardian
        // consent — an adult on such a domain gets no extra dialog.
        guardianConfirmRequired={
          u18Status?.isMinor === true &&
          !!net &&
          !!activeItem &&
          isGuardianConsentRequiredDomain(net, activeItem.item_domain)
        }
      >
        {(triggerAction) => (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <MatchScoreButton
              localItem={activeItem}
              networkItem={item}
              score={score}
              isLoading={matchLoading}
              error={matchError}
              onCalculate={() => {
                if (!score) void calculate();
                setMatchOpen(true);
              }}
              onViewDetails={() => setMatchOpen(true)}
              disabled={false}
            />
            <div className="flex flex-wrap gap-2">
              {actions.map((a) => (
                <ActionButton
                  key={a.action_type}
                  actionType={a.action_type}
                  actionSchema={a}
                  variant="default"
                  disabled={hasOpenActionWithViewed}
                  disabledReason={t('actions.pair_open_disabled', 'A request is already open with this profile.')}
                  onAction={(type, schema) => triggerAction(type, schema, item.item_id)}
                />
              ))}
            </div>
          </div>
        )}
      </ActionHandler>
      <MatchScoreModal
        isOpen={matchOpen}
        onClose={() => setMatchOpen(false)}
        score={score}
        isLoading={matchLoading}
        localItemName={String((activeItem.item_state?.name as string | number | undefined) ?? t('public_profile.your_profile', 'Your Profile'))}
        networkItemName={networkItemName}
        onRecalculate={() => void recalculate()}
        onProceed={undefined}
      />
    </>
  );
}

/**
 * Public, auth-aware single-profile view for a shared link
 * (`/public/:network/:domain/:itemType/:itemId`). Fetches the one profile via the
 * public, masked, jittered, live-only item endpoint (through `useItemDetail`)
 * and renders a schema-driven hero + details grid built entirely from the
 * resolved network's card config and item schema — no field name, section
 * title, or location is hardcoded here. Never exposes PII or a raw error:
 * empty/invalid/non-live → "unavailable"; transient failure → "try again".
 *
 * Rendered inside the Signals app shell (lean app bar + optional sidebar) in 3
 * auth-aware modes: anonymous (app-bar-only, no sidebar), signed in viewing
 * someone else's profile (full AppSidebar + an Apply/Connect + match-score
 * action row sourced from the viewer's active profile), and signed in viewing
 * one's own shared link (full AppSidebar + an own-preview banner, no actions).
 * Data is the masked public projection in every mode — no PII, and the route
 * itself stays unauthenticated (no RequireAuth). The action row runs only for
 * an authenticated non-owner and goes through the normal server-guarded action
 * flow; a share link is never a credential.
 */
export function PublicProfilePage() {
  const { t } = useTranslation();
  const { network, domain, itemType, itemId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { isAuthenticated, user } = useAuth();
  // Network display name for copy that references the brand (e.g. the contact
  // note) — resolves per the link's ?network= (Blue Dots / Purple Dot / …), so
  // it's never hardcoded to one network.
  const { theme } = useNetworkTheme();

  // Back button: return to the previous in-app page when the viewer navigated
  // here within the app (history exists); for a freshly-opened share link
  // (no in-app history — `location.key === 'default'`) land on the map view.
  const handleBack = React.useCallback(() => {
    if (location.key !== 'default') navigate(-1);
    else navigate(`/?network=${encodeURIComponent(network ?? '')}&view=map`);
  }, [location.key, navigate, network]);

  // Keep the theme aligned to the link's network (the theme provider reads the
  // `?network=` query param; our own links include it, but sync it defensively
  // for links that lost the query string).
  React.useEffect(() => {
    if (network && searchParams.get('network') !== network) {
      const next = new URLSearchParams(searchParams);
      next.set('network', network);
      setSearchParams(next, { replace: true });
    }
  }, [network, searchParams, setSearchParams]);

  const keyValid = Boolean(network && domain && itemType && itemId && UUID_RE.test(itemId));

  const { data: net, isLoading: netLoading, isError: netError } = useResolvedNetwork(keyValid ? network! : null);
  const { item, isLoading: itemLoading, isError } = useItemDetail(
    keyValid ? network! : null,
    keyValid ? { item_id: itemId!, item_domain: domain!, item_type: itemType! } : null,
  );

  const { data: myItems } = useMyItems(net ?? null);
  const { activeProfileId, setActiveProfile, activeItem } = useActiveProfile(net ?? null, myItems ?? []);
  const isOwnProfile = isAuthenticated && !!itemId && (myItems ?? []).some((i) => i.item_id === itemId);

  // Build domain → schema map for the sidebar's own-profile title resolution
  // (first item_schema per domain), mirroring home-page's userSchemas.
  const userSchemas = React.useMemo(() => {
    if (!net) return {};
    const map: Record<string, RJSFSchema> = {};
    for (const d of net.domains) {
      const schema = d.item_schemas ? Object.values(d.item_schemas)[0] : undefined;
      if (schema) map[d.id] = schema;
    }
    return map;
  }, [net]);

  // Live-only endpoint: any returned item is already live. The masked public
  // projection does NOT include `lifecycle_status`, so `=== 'live'` alone would
  // wrongly reject every profile — treat a missing status as live (and still
  // reject an explicit non-live status defensively).
  const isLive = Boolean(item && (!item.lifecycle_status || item.lifecycle_status === 'live'));

  let content: React.ReactNode;

  if (!keyValid) {
    content = <UnavailableState networkId={network} />;
  } else if (netLoading || itemLoading) {
    content = (
      <StateWell>
        <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />
        <p className="mt-3 text-sm text-muted-foreground">
          {t('public_profile.loading', 'Loading profile…')}
        </p>
      </StateWell>
    );
  } else if (netError || !net) {
    // Unknown / unresolvable network in the URL — we can't theme or build the
    // schema-driven view, so treat it as unavailable rather than rendering an
    // empty card. (No PII either way; this is just a cleaner dead-end.)
    content = <UnavailableState networkId={network} />;
  } else if (isError) {
    content = (
      <StateWell>
        <AlertCircle className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden="true" />
        <h1 className="mt-4 text-lg font-semibold text-foreground">
          {t('public_profile.error_title', 'Something went wrong')}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('public_profile.error_body', "We couldn't load this profile. Please try again.")}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-5 rounded-lg px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
          style={{ background: 'var(--primary)' }}
        >
          {t('public_profile.retry', 'Try again')}
        </button>
      </StateWell>
    );
  } else if (!isLive) {
    content = <UnavailableState networkId={network} />;
  } else {
    // `isLive` guarantees `item` is set here.
    const liveItem = item!;
    const domainCfg = net?.domains.find((d) => d.id === domain);
    const schema = (domainCfg?.item_schemas?.[itemType!] ??
      (domainCfg?.item_schemas ? Object.values(domainCfg.item_schemas)[0] : undefined)) as
      | RJSFSchema
      | undefined;
    const resolved = resolveCardFields(schema, liveItem.item_state, domainCfg?.card ?? null);
    // Every non-empty resolved row. Masked-stub values (e.g. "H***", "1***")
    // the API returns for coarsened fields are shown as-is — they're the
    // masked public projection, safe to display.
    const rows = [...resolved.defaultRows, ...resolved.extraRows].filter(
      (row) => !row.isEmpty
    );

    content = (
      <div className="mx-auto max-w-2xl px-5 py-10 sm:py-14">
        {/* Hero — left-aligned avatar + title, with domain/meta below the title. */}
        <div className="flex items-start gap-4">
          <div
            className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full text-xl font-bold text-white shadow-sm"
            style={{ background: HERO_GRADIENT }}
            aria-hidden="true"
          >
            {resolved.initials}
          </div>
          <div className="min-w-0 pt-1">
            <h1 className="text-3xl font-bold leading-tight text-foreground">{resolved.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="inline-flex items-center rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                {titleCaseDomain(domain!)}
              </span>
              {resolved.subtitle && <span>{resolved.subtitle}</span>}
            </div>
          </div>
        </div>

        {/* Own-profile preview banner — only shown to the signed-in owner of
            this exact profile, so they know this is the masked view others see. */}
        {isOwnProfile && (
          <div className="mt-6 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-foreground">
            {t(
              'public_profile.own_preview',
              'This is the public view others see when you share your profile — contact details stay hidden until someone connects.'
            )}
          </div>
        )}

        {/* Details — every non-empty, non-masked resolved row, schema-driven end to end. */}
        <p className="mt-8 mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('public_profile.details', 'Details')}
        </p>
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="grid grid-cols-1 sm:grid-cols-2">
            {rows.map((row, index) => (
              <div
                key={row.key}
                className={[
                  'min-w-0 px-4 py-3',
                  index >= 2 ? 'border-t border-border' : '',
                  index % 2 === 1 ? 'sm:border-l sm:border-border' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {row.label}
                </div>
                <div className="mt-1 text-sm font-semibold text-foreground [overflow-wrap:anywhere]">
                  {row.isUri ? <UriValue value={row.value} /> : formatCardValue(row.value, row.type)}
                </div>
              </div>
            ))}
            {/* Odd field count → fill the empty trailing cell (sm+ two-col grid)
                so the table's borders close cleanly instead of cutting off. */}
            {rows.length % 2 === 1 && (
              <div
                aria-hidden="true"
                className={[
                  'hidden min-w-0 px-4 py-3 sm:block',
                  rows.length >= 2 ? 'border-t border-border' : '',
                  'sm:border-l sm:border-border',
                ]
                  .filter(Boolean)
                  .join(' ')}
              />
            )}
          </div>
        </div>

        {/* Apply/Connect + See Match Score — only for a logged-in viewer of
            someone ELSE's profile, sourced from their active profile. Own
            profile keeps the preview banner above; anonymous gets nothing. */}
        {isAuthenticated && !isOwnProfile && (
          <ProfileActionRow
            net={net ?? null}
            item={liveItem}
            activeItem={activeItem}
            viewedDomain={domain!}
            user={user}
            networkItemName={resolved.title}
          />
        )}

        <p className="mt-6 text-center text-xs text-muted-foreground">
          {t(
            'public_profile.contact_note',
            'Contact details are shared only after you connect on {{brand}}.',
            { brand: theme.name }
          )}
        </p>
      </div>
    );
  }

  // Anonymous view: no sidebar at all — an app-bar-only, full-width column with
  // the brand logo moved into the app bar. Authenticated view keeps the full
  // sidebar shell (AppSidebar + sidebar trigger) exactly as before.
  if (!isAuthenticated) {
    // No SidebarProvider here (anonymous has no sidebar), so its built-in
    // TooltipProvider is gone too — the app-bar's ThemeModeToggle renders a
    // Radix Tooltip that throws without a provider ancestor. Supply one.
    return (
      <TooltipProvider>
        <div className="flex h-svh min-w-0 flex-1 flex-col">
          <ProfileTopBar
            networkId={network}
            item={isLive ? item : null}
            isAuthenticated={false}
            showLogo
            onBack={handleBack}
          />
          <main id="main-content" className="flex-1 overflow-y-auto bg-muted/30">
            {content}
          </main>
        </div>
      </TooltipProvider>
    );
  }

  return (
    <SidebarProvider>
      <AppSidebar
        networks={[]}
        domains={[]}
        selectedDomain={null}
        onDomainSelect={() => {}}
        myItems={myItems ?? []}
        activeProfileId={activeProfileId}
        onActiveProfileChange={setActiveProfile}
        userSchemas={userSchemas}
        selectedNetwork={network ?? undefined}
        onProfilesChanged={() => {
          if (net) queryClient.invalidateQueries({ queryKey: queryKeys.myItems(net.id) });
        }}
      />
      <div className="flex h-svh min-w-0 flex-1 flex-col">
        <ProfileTopBar
          networkId={network}
          item={isLive ? item : null}
          isAuthenticated={isAuthenticated}
          showLogo={false}
          onBack={handleBack}
        />
        <main id="main-content" className="flex-1 overflow-y-auto bg-muted/30">
          {content}
        </main>
      </div>
    </SidebarProvider>
  );
}

export default PublicProfilePage;
