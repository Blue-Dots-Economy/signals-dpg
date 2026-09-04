import type * as React from 'react';
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { RJSFSchema } from '@rjsf/utils';
import type { DotNetworkDomain, DotNetworkSchema } from '@/engine/types';
import type { Item } from '@/lib/item-api';
import {
  Sidebar as ShadcnSidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarSeparator,
} from '@/components/ui/sidebar';
import { SidebarBrandFooter } from './sidebar-brand-footer';
import { PortalHeader } from './portal-header';
import { LayoutGrid, Plus, Network, ChevronRight, Activity } from 'lucide-react';
import { usePendingActionsCount } from '@/hooks/use-actions';
import { getServedScope } from '@/lib/served-binding';

interface AppSidebarProps {
  networks?: DotNetworkSchema[];
  selectedNetwork?: string | null;
  onNetworkSelect?: (networkId: string) => void;
  domains: DotNetworkDomain[];
  selectedDomain: string | null;
  onDomainSelect: (domainId: string | null) => void;
  currentDomainLabel?: string;
  myItems?: Item[];
  activeProfileId?: string | null;
  onActiveProfileChange?: (profileId: string) => void;
  onProfilesChanged?: () => void;
  userSchemas?: Record<string, RJSFSchema>;
  /** Hide the Browse (domain selector) group — used on the create/edit form
   * page, where browsing has no meaning. */
  hideBrowse?: boolean;
}

import { getDomainIcon, formatDomainLabel } from '@/lib/domain-icons';
import { ProfileRowActions } from './profile-row-actions';

function findTitleField(schema: RJSFSchema): string | null {
  if (!schema.properties) return null;
  const candidates = ['name', 'full_name', 'title', 'provider_id', 'learner_id', 'student_id'];
  for (const key of candidates) {
    if (key in schema.properties) return key;
  }
  return Object.keys(schema.properties)[0] ?? null;
}

function PendingActionsBadge() {
  const { data: count = 0 } = usePendingActionsCount();
  if (count === 0) return null;
  return (
    <span className="ml-auto shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground leading-none">
      {count > 99 ? '99+' : count}
    </span>
  );
}

/**
 * Which domain's `my_items_label` (network.json) should title the "My items"
 * group — e.g. blue_dot provider → "My Jobs".
 *
 * The viewer's own profiles decide it when they are all in one domain. Before
 * sign-in there are none, and the group used to fall back to the generic
 * "My Profile(s)" — but a per-domain portal already knows its domain from
 * VITE_SERVED_BINDINGS (the same signal the login form uses to auto-select the
 * domain when only one is served), so a seeker portal can say "My Profiles"
 * and a provider portal "My Jobs" to a signed-out visitor too.
 *
 * Own profiles win over the portal binding: a viewer holding items is the
 * stronger signal, and the two can disagree while a mis-routed user is being
 * bounced to the right portal.
 */
export function resolveMyItemsDomainId(
  profileDomainIds: string[],
  servedDomainIds: string[] | null,
): string | null {
  if (profileDomainIds.length === 1) return profileDomainIds[0];
  if (profileDomainIds.length > 1) return null; // mixed — the generic label covers it
  return servedDomainIds && servedDomainIds.length === 1 ? servedDomainIds[0] : null;
}

export function AppSidebar({
  networks = [],
  selectedNetwork,
  onNetworkSelect,
  domains,
  selectedDomain,
  onDomainSelect,
  myItems = [],
  activeProfileId,
  onActiveProfileChange,
  onProfilesChanged,
  userSchemas,
  hideBrowse = false,
}: Readonly<AppSidebarProps>) {
  const navigate = useNavigate();
  const { t } = useTranslation();

  // Group profiles by domain
  const profilesByDomain = myItems.reduce<Record<string, Item[]>>((acc, item) => {
    const key = item.item_domain;
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});

  const domainKeys = Object.keys(profilesByDomain);
  const hasNoProfiles = domainKeys.length === 0;

  // "My items" group label is domain-aware: a network can override the generic
  // "My Profile(s)" heading per domain via `my_items_label` in network.json
  // (e.g. blue_dot provider → "My Jobs"). Only applied when the group holds a
  // single domain; otherwise the generic label covers the mix. Falls back to the
  // generic label when the domain sets no override.
  const labelDomainId = resolveMyItemsDomainId(domainKeys, getServedScope()?.domains ?? null);
  const myItemsGroupLabel =
    domains.find((d) => d.id === labelDomainId)?.my_items_label ??
    t('nav.my_profiles_group');

  // Find which domain the active profile belongs to
  const activeDomain = myItems.find((i) => i.item_id === activeProfileId)?.item_domain ?? null;

  // Expanded state: default open the domain of the active profile (or all if none)
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(() => {
    if (activeDomain) return new Set([activeDomain]);
    return new Set(domainKeys);
  });

  // When active profile changes, ensure its domain is expanded
  useEffect(() => {
    if (activeDomain) {
      setExpandedDomains((prev) => {
        if (prev.has(activeDomain)) return prev;
        return new Set([...prev, activeDomain]);
      });
    }
  }, [activeDomain]);

  function toggleDomain(domainId: string) {
    setExpandedDomains((prev) => {
      const next = new Set(prev);
      if (next.has(domainId)) {
        next.delete(domainId);
      } else {
        next.add(domainId);
      }
      return next;
    });
  }

  const showNetworkSelector = networks.length > 0;

  return (
    <ShadcnSidebar>
      <SidebarHeader className="flex h-14 justify-center border-b px-4">
        <PortalHeader />
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Primary" className="flex flex-1 flex-col gap-2">
        {showNetworkSelector && (
          <SidebarGroup>
            <SidebarGroupLabel>{t('nav.networks_group')}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {networks.map((network) => (
                  <SidebarMenuItem key={network.id}>
                    <SidebarMenuButton
                      isActive={selectedNetwork === network.id}
                      onClick={() => onNetworkSelect?.(network.id)}
                    >
                      <Network className="h-4 w-4" />
                      <span>{network.display_name || network.id}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        {showNetworkSelector && <SidebarSeparator />}
        {/* The Browse domain selector only appears when there is MORE THAN ONE
            browseable domain (i.e. >1 distinct interaction `to_domain`). With a
            single target domain there is no choice to make — a lone tab (and an
            "All") is redundant — so the whole selector and its separator are
            hidden, and that domain's listings render directly in the main view.
            Driven by the network's interactions; not network-specific. */}
        {!hideBrowse && domains.length > 1 && (
          <>
            <SidebarGroup>
              <SidebarGroupLabel>{t('nav.browse_group')}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      isActive={selectedDomain === null}
                      onClick={() => onDomainSelect(null)}
                    >
                      <LayoutGrid className="h-4 w-4" />
                      <span>{t('common.all')}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  {domains.map((domain) => {
                    const Icon = getDomainIcon(domain.id, selectedNetwork);
                    const label = formatDomainLabel(domain.id, domains);
                    return (
                      <SidebarMenuItem key={domain.id}>
                        <SidebarMenuButton
                          isActive={selectedDomain === domain.id}
                          onClick={() => onDomainSelect(domain.id)}
                          title={domain.description}
                        >
                          <Icon className="h-4 w-4" />
                          <span>{label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarSeparator />
          </>
        )}
        {/* With NO profiles yet, this group is stretched to the exact height of
            the browse toolbar (`--dpg-toolbar-h`, measured and published by
            PageShell) and owns the divider itself, so the sidebar's rule and
            the toolbar's bottom border form one continuous line across the
            viewport — the same way the sidebar header's border meets the top
            bar's above it.

            Only in the empty state. Once profiles exist the group is taller
            than the toolbar and no alignment is possible or expected, so it
            falls back to its natural height and the shared `<SidebarSeparator />`
            below. `hasNoProfiles` therefore also suppresses that separator, or
            the empty state would draw two rules. */}
        <SidebarGroup
          className={hasNoProfiles ? 'border-b border-sidebar-border' : undefined}
          style={
            hasNoProfiles
              ? ({ minHeight: 'var(--dpg-toolbar-h, auto)' } as React.CSSProperties)
              : undefined
          }
        >
          <SidebarGroupLabel>{myItemsGroupLabel}</SidebarGroupLabel>
          <SidebarGroupContent>
            {domainKeys.length === 0 ? (
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton onClick={() => navigate(`/profile/new?network=${selectedNetwork ?? ''}`)}>
                    <Plus className="h-4 w-4" />
                    <span>{t('nav.create_profile')}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            ) : (
              <div className="space-y-1">
                {domainKeys.map((domainId) => {
                  const profiles = profilesByDomain[domainId];
                  const Icon = getDomainIcon(domainId, selectedNetwork);
                  const label = formatDomainLabel(domainId, domains);
                  // A single domain group (always the case in a domain-bound
                  // portal) needs no accordion header — show its profiles
                  // directly, always expanded.
                  const singleGroup = domainKeys.length === 1;
                  const isExpanded = singleGroup || expandedDomains.has(domainId);
                  const hasActiveProfile = profiles.some((p) => p.item_id === activeProfileId);

                  return (
                    <div key={domainId}>
                      {/* Accordion header — only when there's more than one
                          domain group; a single group is shown flat. */}
                      {!singleGroup && (
                        <button
                          onClick={() => toggleDomain(domainId)}
                          className={[
                            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                            'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                            hasActiveProfile
                              ? 'font-semibold text-primary'
                              : 'text-sidebar-foreground/70',
                          ].join(' ')}
                        >
                          <Icon className="h-3.5 w-3.5 shrink-0" />
                          <span className="flex-1 truncate text-left">{label}</span>
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {profiles.length}
                          </span>
                          <ChevronRight
                            className={[
                              'h-3.5 w-3.5 shrink-0 transition-transform duration-200',
                              isExpanded ? 'rotate-90' : '',
                            ].join(' ')}
                          />
                        </button>
                      )}

                      {/* Accordion body */}
                      {isExpanded && (
                        <div className={singleGroup ? 'mt-0.5' : 'ml-3 mt-0.5 border-l border-border pl-2'}>
                          <SidebarMenu>
                            {profiles.map((profile) => {
                              const schema = userSchemas?.[profile.item_domain];
                              const titleKey = schema ? findTitleField(schema) : null;
                              const title = titleKey
                                ? String(profile.item_state[titleKey] ?? t('nav.profile_fallback'))
                                : t('nav.profile_fallback');
                              const isActiveProfile = profile.item_id === activeProfileId;

                              return (
                                <SidebarMenuItem
                                  key={profile.item_id}
                                  className={[
                                    'flex items-center gap-1 rounded-md pr-1',
                                    isActiveProfile
                                      ? 'bg-primary/12 border-l-2 border-primary rounded-l-none hover:bg-primary/15'
                                      : 'hover:bg-sidebar-accent',
                                  ].join(' ')}
                                >
                                  <SidebarMenuButton
                                    onClick={() => onActiveProfileChange?.(profile.item_id)}
                                    className={[
                                      'min-w-0 flex-1 bg-transparent hover:bg-transparent',
                                      isActiveProfile ? 'text-primary font-medium pl-2' : '',
                                    ].join(' ')}
                                  >
                                    <span className="truncate" title={title}>{title}</span>
                                    {/* Lifecycle chip lives INSIDE the button pill
                                        (Active / Paused / Draft) so it reads as part
                                        of the profile, not floating on the row. */}
                                    {profile.lifecycle_status && (
                                      <span
                                        className={[
                                          'ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none capitalize',
                                          profile.lifecycle_status === 'live'
                                            ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300'
                                            : profile.lifecycle_status === 'paused'
                                              ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300'
                                              : 'bg-slate-200 text-slate-700 dark:bg-slate-500/25 dark:text-slate-300',
                                        ].join(' ')}
                                      >
                                        {t(
                                          `nav.status_${profile.lifecycle_status}`,
                                          profile.lifecycle_status === 'live'
                                            ? 'Active'
                                            : profile.lifecycle_status,
                                        )}
                                      </span>
                                    )}
                                  </SidebarMenuButton>
                                  {/* Per-profile actions (Edit · Pause/Resume ·
                                      Retire), icon-only, always visible. */}
                                  <ProfileRowActions
                                    profile={profile}
                                    pauseEnabled={
                                      networks?.find((n) => n.id === profile.item_network)?.pause_enabled !== false
                                    }
                                    onEdit={() => navigate(`/profile/${profile.item_id}/edit?network=${encodeURIComponent(profile.item_network)}`)}
                                    onChanged={() => onProfilesChanged?.()}
                                  />
                                </SidebarMenuItem>
                              );
                            })}
                          </SidebarMenu>
                        </div>
                      )}
                    </div>
                  );
                })}
                <SidebarMenu className="mt-1">
                  <SidebarMenuItem>
                    <SidebarMenuButton onClick={() => navigate(`/profile/new?network=${selectedNetwork ?? ''}`)}>
                      <Plus className="h-4 w-4" />
                      <span>{t('nav.create_profile')}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </div>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
        {/* Suppressed in the empty state — the group above draws its own
            bottom border there so it can line up with the browse toolbar. */}
        {!hasNoProfiles && <SidebarSeparator />}
        <SidebarGroup>
          <SidebarGroupLabel>{t('nav.actions_group')}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => navigate('/my-actions')}>
                  <Activity className="h-4 w-4" />
                  <span>{t('nav.my_actions')}</span>
                  <PendingActionsBadge />
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        </nav>
      </SidebarContent>
      <SidebarBrandFooter />
    </ShadcnSidebar>
  );
}
