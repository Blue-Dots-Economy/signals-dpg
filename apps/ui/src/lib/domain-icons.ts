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
 * `<network_id>:<domain_id>` keys are tried first so one domain id can render
 * differently per network; the plain domain id is the fallback, then `Box`.
 */
export const domainIcons: Record<string, LucideIcon> = {
  // blue_dot (opportunities)
  'blue_dot:seeker': Search,
  'blue_dot:provider': Briefcase,
  'blue_dot:service_provider': Building2,

  // purple_dot (disability services)
  'purple_dot:seeker': Accessibility,
  'purple_dot:provider': HandHeart,

  // Network-agnostic fallbacks; yellow_dot (education):
  student_profile: GraduationCap,
  learner_profile: GraduationCap,
  student: GraduationCap,
  tutor_counsellor_profile: UserCheck,
  tutor_counsellor: UserCheck,
  coaching_center: Building2,
  // Neutral seeker/provider icons, so an unmapped network does not imply disability services.
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

/**
 * Plural domain label for copy naming a set ("Showing Providers"). Prefers the
 * domain's `plural_label`, since English rules fail for labels like "Staff";
 * the fallback leaves an already-plural label unchanged, so an irregular label
 * at worst reads singular.
 */
export function pluralizeDomainLabel(
  domainId: string | null | undefined,
  domains?: ReadonlyArray<{ id: string; label?: string; plural_label?: string }> | null,
): string {
  if (!domainId) return '';

  const configured = domains?.find((d) => d.id === domainId)?.plural_label?.trim();
  if (configured) return configured;

  const singular = formatDomainLabel(domainId, domains);
  if (!singular) return '';
  // Already plural, or not pluralized with -s.
  if (/(?:s|ch|sh|x|z)$/i.test(singular)) return singular;
  // consonant + y -> ies ("Beneficiary" -> "Beneficiaries")
  if (/[^aeiou]y$/i.test(singular)) return `${singular.slice(0, -1)}ies`;
  return `${singular}s`;
}

export function formatDomainLabel(
  domainId: string | null | undefined,
  domains?: ReadonlyArray<{ id: string; label?: string }> | null,
): string {
  if (!domainId) return '';
  // Prefer the network.json `label`; else title-case the id.
  const configured = domains?.find((d) => d.id === domainId)?.label?.trim();
  if (configured) return configured;
  return domainId.replaceAll('_', ' ').replaceAll(/\b\w/g, (c) => c.toUpperCase());
}
