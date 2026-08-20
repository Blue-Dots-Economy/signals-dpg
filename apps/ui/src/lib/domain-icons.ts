import {
  GraduationCap,
  UserCheck,
  Building2,
  Accessibility,
  HandHeart,
  Search,
  Briefcase,
  Box,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * Icons keyed by `<network_id>:<domain_id>` are tried first so a single
 * domain id (e.g. `seeker`) can render differently per network. The plain
 * domain-id key is the network-agnostic fallback. Anything unmapped renders
 * as the generic `Box` outline.
 */
export const domainIcons: Record<string, LucideIcon> = {
  // ── blue_dot / opportunities network ────────────────────────────────
  'blue_dot:seeker': Search,
  'blue_dot:provider': Briefcase,
  'blue_dot:service_provider': Building2,

  // ── purple_dot / disability services network ────────────────────────
  'purple_dot:seeker': Accessibility,
  'purple_dot:provider': HandHeart,

  // ── network-agnostic fallbacks (used when no scoped key matches) ────
  // yellow_dot / education
  student_profile: GraduationCap,
  learner_profile: GraduationCap,
  student: GraduationCap,
  tutor_counsellor_profile: UserCheck,
  tutor_counsellor: UserCheck,
  coaching_center: Building2,
  // generic seeker/provider when a network hasn't been mapped — disability
  // icon set used to be the global default; switched to neutral icons so
  // we don't imply disability for networks that aren't about that.
  seeker: Search,
  provider: Briefcase,
  service_provider: Building2,
};

export function getDomainIcon(
  domainId: string | null | undefined,
  networkId?: string | null,
): LucideIcon {
  if (!domainId) return Box;
  if (networkId) {
    const scoped = domainIcons[`${networkId}:${domainId}`];
    if (scoped) return scoped;
  }
  return domainIcons[domainId] ?? Box;
}

export function formatDomainLabel(
  domainId: string | null | undefined,
  domains?: ReadonlyArray<{ id: string; label?: string }> | null,
): string {
  if (!domainId) return '';
  // Prefer the network.json display label (e.g. id `provider` shown as
  // "Service Provider"); else title-case the id.
  const configured = domains?.find((d) => d.id === domainId)?.label?.trim();
  if (configured) return configured;
  return domainId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
