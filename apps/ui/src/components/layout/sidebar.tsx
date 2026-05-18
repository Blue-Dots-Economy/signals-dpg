import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
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
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarSeparator,
} from '@/components/ui/sidebar';
import { LayoutGrid, Box, Plus, Pencil, GraduationCap, UserCheck, Building2, Network, ChevronRight, Activity } from 'lucide-react';
import { usePendingActionsCount } from '@/hooks/use-actions';
import type { LucideIcon } from 'lucide-react';

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
  userSchemas?: Record<string, RJSFSchema>;
}

const domainIcons: Record<string, LucideIcon> = {
  student: GraduationCap,
  tutor: UserCheck,
  coaching_center: Building2,
};

function findTitleField(schema: RJSFSchema): string | null {
  if (!schema.properties) return null;
  const candidates = ['name', 'full_name', 'title', 'provider_id', 'learner_id', 'student_id'];
  for (const key of candidates) {
    if (key in schema.properties) return key;
  }
  return Object.keys(schema.properties)[0] ?? null;
}

function getDomainLabel(domainId: string): string {
  return domainId
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
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

export function AppSidebar({
  networks = [],
  selectedNetwork,
  onNetworkSelect,
  domains,
  selectedDomain,
  onDomainSelect,
  currentDomainLabel,
  myItems = [],
  activeProfileId,
  onActiveProfileChange,
  userSchemas,
}: AppSidebarProps) {
  const navigate = useNavigate();

  // Group profiles by domain
  const profilesByDomain = myItems.reduce<Record<string, Item[]>>((acc, item) => {
    const key = item.item_domain;
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});

  const domainKeys = Object.keys(profilesByDomain);

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
      <SidebarHeader className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">
          {currentDomainLabel ?? 'Domains'}
        </h2>
      </SidebarHeader>
      <SidebarContent>
        {showNetworkSelector && (
          <SidebarGroup>
            <SidebarGroupLabel>Networks</SidebarGroupLabel>
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
        <SidebarGroup>
          <SidebarGroupLabel>Browse</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={selectedDomain === null}
                  onClick={() => onDomainSelect(null)}
                >
                  <LayoutGrid className="h-4 w-4" />
                  <span>All</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {domains.map((domain) => {
                const Icon = domainIcons[domain.id] ?? Box;
                return (
                  <SidebarMenuItem key={domain.id}>
                    <SidebarMenuButton
                      isActive={selectedDomain === domain.id}
                      onClick={() => onDomainSelect(domain.id)}
                    >
                      <Icon className="h-4 w-4" />
                      <span>{domain.description}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <SidebarGroup>
          <SidebarGroupLabel>My Profile(s)</SidebarGroupLabel>
          <SidebarGroupContent>
            {domainKeys.length === 0 ? (
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton onClick={() => navigate(`/profile/new?network=${selectedNetwork ?? ''}`)}>
                    <Plus className="h-4 w-4" />
                    <span>Create Profile</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            ) : (
              <div className="space-y-1">
                {domainKeys.map((domainId) => {
                  const profiles = profilesByDomain[domainId];
                  const Icon = domainIcons[domainId] ?? Box;
                  const label = getDomainLabel(domainId);
                  const isExpanded = expandedDomains.has(domainId);
                  const hasActiveProfile = profiles.some((p) => p.item_id === activeProfileId);

                  return (
                    <div key={domainId}>
                      {/* Accordion header */}
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

                      {/* Accordion body */}
                      {isExpanded && (
                        <div className="ml-3 mt-0.5 border-l border-border pl-2">
                          <SidebarMenu>
                            {profiles.map((profile) => {
                              const schema = userSchemas?.[profile.item_domain];
                              const titleKey = schema ? findTitleField(schema) : null;
                              const title = titleKey
                                ? String(profile.item_state[titleKey] ?? 'Profile')
                                : 'Profile';
                              const isActiveProfile = profile.item_id === activeProfileId;

                              return (
                                <SidebarMenuItem key={profile.item_id}>
                                  <SidebarMenuButton
                                    onClick={() => onActiveProfileChange?.(profile.item_id)}
                                    className={
                                      isActiveProfile
                                        ? 'relative bg-primary/10 text-primary font-medium border-l-2 border-primary rounded-l-none pl-2 hover:bg-primary/15'
                                        : ''
                                    }
                                  >
                                    <span className="truncate">{title}</span>
                                    {isActiveProfile && (
                                      <span className="ml-auto shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground leading-none">
                                        active
                                      </span>
                                    )}
                                  </SidebarMenuButton>
                                  <SidebarMenuAction
                                    onClick={() => navigate(`/profile/${profile.item_id}/edit?network=${encodeURIComponent(profile.item_network)}`)}
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </SidebarMenuAction>
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
                      <span>Create Profile</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </div>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <SidebarGroup>
          <SidebarGroupLabel>Actions</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => navigate('/my-actions')}>
                  <Activity className="h-4 w-4" />
                  <span>My Actions</span>
                  <PendingActionsBadge />
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </ShadcnSidebar>
  );
}
