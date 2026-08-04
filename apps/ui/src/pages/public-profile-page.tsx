import * as React from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertCircle, Copy, Loader2 } from 'lucide-react';
import type { RJSFSchema } from '@rjsf/utils';
import { useResolvedNetwork } from '@/hooks/use-network-config';
import { useItemDetail } from '@/hooks/use-item-detail';
import { useMyItems } from '@/hooks/use-my-items';
import { useActiveProfile } from '@/hooks/use-active-profile';
import { useAuth } from '@/contexts/auth-context';
import { resolveCardFields, formatCardValue } from '@/components/cards/resolve-card-fields';
import { buildProfileShareUrl, copyTextToClipboard } from '@/lib/share-profile';
import { queryKeys } from '@/lib/query-keys';
import type { Item } from '@/lib/item-api';
import { AppSidebar } from '@/components/layout/sidebar';
import { PortalHeader } from '@/components/layout/portal-header';
import { ThemeModeToggle } from '@/components/layout/theme-mode-toggle';
import { UserMenu } from '@/components/auth/user-menu';
import {
  Sidebar,
  SidebarHeader,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HERO_GRADIENT =
  'linear-gradient(135deg, var(--primary), color-mix(in srgb, var(--primary), white 32%))';

function titleCaseDomain(id: string): string {
  return id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
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
}: {
  networkId?: string;
  item: Item | null;
  isAuthenticated: boolean;
}) {
  const { t } = useTranslation();

  const onCopyLink = async () => {
    if (!item) return;
    const ok = await copyTextToClipboard(buildProfileShareUrl(item));
    if (ok) toast.success(t('share.copied', 'Link copied to clipboard'));
    else toast.error(t('share.copy_failed', 'Could not copy the link'));
  };

  return (
    <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background/90 px-5 py-3 backdrop-blur">
      <SidebarTrigger className="md:hidden" />
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
        {isAuthenticated ? (
          <UserMenu />
        ) : (
          <Link
            to="/auth/login"
            className="inline-flex items-center rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
          >
            {t('public_profile.sign_in', 'Sign in')}
          </Link>
        )}
      </div>
    </header>
  );
}

/** Centered content well used by every non-hero state (loading / error / unavailable). */
function StateWell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[60dvh] items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm text-center">{children}</div>
    </div>
  );
}

function UnavailableState({ networkId }: { networkId?: string }) {
  const { t } = useTranslation();
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
        {t('public_profile.explore', 'Explore Blue Dots')}
      </a>
    </StateWell>
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
 * Rendered inside the same Signals app shell (sidebar + lean top bar) as every
 * other page, in 3 auth-aware modes: anonymous (branding-only sidebar, no My
 * Profiles), signed in viewing someone else's profile (full AppSidebar), and
 * signed in viewing one's own shared link (full AppSidebar + an own-preview
 * banner). Data is the masked public projection in every mode — no PII, and
 * the route itself stays unauthenticated (no RequireAuth). Apply/Connect is a
 * separate later stage and is intentionally not built here.
 */
export function PublicProfilePage() {
  const { t } = useTranslation();
  const { network, domain, itemType, itemId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { isAuthenticated } = useAuth();

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

  const { data: net, isLoading: netLoading } = useResolvedNetwork(keyValid ? network! : null);
  const { item, isLoading: itemLoading, isError } = useItemDetail(
    keyValid ? network! : null,
    keyValid ? { item_id: itemId!, item_domain: domain!, item_type: itemType! } : null,
  );

  const { data: myItems } = useMyItems(net ?? null);
  const { activeProfileId, setActiveProfile } = useActiveProfile(net ?? null, myItems ?? []);
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

  // Live-only endpoint: a returned item is live. Guard defensively anyway.
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
                  {formatCardValue(row.value, row.type)}
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

        <p className="mt-6 text-center text-xs text-muted-foreground">
          {t(
            'public_profile.contact_note',
            'Contact details are shared only after you connect on Blue Dots.'
          )}
        </p>
      </div>
    );
  }

  return (
    <SidebarProvider>
      {isAuthenticated ? (
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
      ) : (
        <Sidebar>
          <SidebarHeader className="flex h-14 justify-center border-b px-4">
            <PortalHeader />
          </SidebarHeader>
        </Sidebar>
      )}
      <div className="flex h-svh min-w-0 flex-1 flex-col">
        <ProfileTopBar
          networkId={network}
          item={isLive ? item : null}
          isAuthenticated={isAuthenticated}
        />
        <main id="main-content" className="flex-1 overflow-y-auto bg-muted/30">
          {content}
        </main>
      </div>
    </SidebarProvider>
  );
}

export default PublicProfilePage;
