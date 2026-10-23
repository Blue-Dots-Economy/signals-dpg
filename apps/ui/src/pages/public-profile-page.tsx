import * as React from 'react';
import { useParams, useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertCircle, ArrowLeft, Loader2 } from 'lucide-react';
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
import { formatDomainLabel } from '@/lib/domain-icons';
import { ActionHandler } from '@/components/actions/action-handler';
import { ActionButton } from '@/components/cards/action-button';
import { MatchScoreButton, MatchScoreModal } from '@/components/match-score';
import { useMatchScore } from '@/hooks/use-match-score';
import { ShareProfileButton } from '@/components/share/share-profile-button';
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


/**
 * Lean top bar shared by every state on this page: the mobile sidebar trigger
 * (or the logo, anonymously), share, explore and auth controls. The share
 * button renders nothing until a live item has loaded.
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
   * Anonymous mode has no sidebar, so the logo goes in the app bar; signed in,
   * the bar shows the mobile sidebar trigger instead.
   */
  showLogo: boolean;
}>) {
  const { t } = useTranslation();

  // The caller passes null for a non-live item. `ShareProfileButton` gates on
  // `lifecycle_status`, which the masked public projection omits, so state it
  // here or a live profile loses its share button.
  const shareItem = item ? { ...item, lifecycle_status: 'live' as const } : null;

  return (
    <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur sm:px-6">
      {showLogo && <PortalHeader />}
      {!showLogo && <SidebarTrigger className="md:hidden" />}
      {/* Anonymous: a full-height divider after the logo, mirroring the
          sidebar's right border in the signed-in layout. */}
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
        <ShareProfileButton
          item={shareItem}
          label={t('share.button', 'Share profile')}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
        />
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
 * Apply/Connect and See-Match-Score row for a signed-in viewer of someone
 * else's live profile, sourced from their active profile. Shows a "switch
 * profile" hint when no interaction applies, a "complete profile" hint for a
 * draft, else the match score control and one button per action. Data stays
 * masked; the action goes through the authenticated server flow (interaction
 * matrix, ownership, consent, guardian OTP).
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

  // The viewer's U18 status, as on home-page. On failure it stays null (no
  // confirm-before-OTP dialog); the server enforces the guardian gate anyway.
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

  // Disable Apply/Connect when an action is already open with the viewed item
  // (either direction). Actions are fetched only for a signed-in user.
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
      // Draft source profile: show the "complete your profile" hint and abort
      // (ActionAbortedError suppresses the generic error toast).
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

      // The consent sentinel must not reach requirements_snapshot.
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
        sourceInstanceUrl, // the source instance, where the active profile lives
        guardianOtp,
      );

      // Surface the new action without waiting for the poll.
      queryClient.invalidateQueries({ queryKey: queryKeys.actions.all });
      toast.success(
        t('public_profile.action_sent', '{{action}} request sent', {
          action: actionType.charAt(0).toUpperCase() + actionType.slice(1),
        }),
      );
    },
    [activeItem, item, net, user, queryClient, t],
  );

  // A draft active profile cannot act at all, so that hint takes precedence.
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
        // Confirm before the guardian OTP only for a minor whose active
        // profile's domain requires guardian consent.
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
 * Public single-profile view for a shared link
 * (`/public/:network/:domain/:itemType/:itemId`). Fetches the profile from the
 * public masked, jittered, live-only endpoint and renders it entirely from the
 * network's card config and item schema. Never shows PII or a raw error:
 * empty/invalid/non-live → "unavailable"; transient failure → "try again".
 *
 * Modes: anonymous (app bar only), signed in viewing someone else's profile
 * (sidebar + action row from the viewer's active profile), and signed in
 * viewing one's own (sidebar + preview banner). The route has no RequireAuth;
 * a share link is never a credential.
 */
export function PublicProfilePage() {
  const { t } = useTranslation();
  const { network, domain, itemType, itemId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { isAuthenticated, user } = useAuth();
  // Network display name for copy, from the link's ?network=.
  const { theme } = useNetworkTheme();

  // Back: the previous in-app page when there is history; a freshly opened
  // share link (`location.key === 'default'`) lands on the map view.
  const handleBack = React.useCallback(() => {
    if (location.key !== 'default') navigate(-1);
    else navigate(`/?network=${encodeURIComponent(network ?? '')}&view=map`);
  }, [location.key, navigate, network]);

  // Keep the theme on the link's network (the provider reads `?network=`);
  // synced here for links that lost the query string.
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

  // Domain → schema map (first item_schema per domain) for sidebar titles.
  const userSchemas = React.useMemo(() => {
    if (!net) return {};
    const map: Record<string, RJSFSchema> = {};
    for (const d of net.domains) {
      const schema = d.item_schemas ? Object.values(d.item_schemas)[0] : undefined;
      if (schema) map[d.id] = schema;
    }
    return map;
  }, [net]);

  // The endpoint is live-only, and the masked projection omits
  // `lifecycle_status`, so a missing status counts as live; an explicit
  // non-live status is still rejected.
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
    // Unknown network in the URL: nothing to theme or render, so show
    // unavailable.
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
    // Every non-empty resolved row. Masked stubs (e.g. "H***") come from the
    // public projection and are safe to show.
    const rows = [...resolved.defaultRows, ...resolved.extraRows].filter(
      (row) => !row.isEmpty
    );

    content = (
      <div className="mx-auto max-w-2xl px-5 py-10 sm:py-14">
        {/* Hero: avatar and title, domain/meta below. */}
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
                {formatDomainLabel(domain!, net?.domains)}
              </span>
              {resolved.subtitle && <span>{resolved.subtitle}</span>}
            </div>
          </div>
        </div>

        {/* Own-profile preview banner: shows the owner the masked view others see. */}
        {isOwnProfile && (
          <div className="mt-6 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-foreground">
            {t(
              'public_profile.own_preview',
              'This is the public view others see when you share your profile — contact details stay hidden until someone connects.'
            )}
          </div>
        )}

        {/* Details: every non-empty resolved row, schema-driven. */}
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
            {/* Odd field count: fill the trailing cell so the grid's borders
                close cleanly. */}
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

        {/* Only for a signed-in viewer of someone else's profile. */}
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

  // Anonymous: no sidebar, logo in the app bar. Signed in: the sidebar shell.
  if (!isAuthenticated) {
    // No SidebarProvider here, so supply the TooltipProvider it would give:
    // ThemeModeToggle's Radix Tooltip throws without one.
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
