/**
 * Domain to lucide icon mapping for all map providers, keyed on common domain
 * name substrings so it works for any network.
 */

import {
  User,
  Building2,
  GraduationCap,
  Handshake,
  Briefcase,
  MapPin,
  type LucideIcon,
} from 'lucide-react';

/** Lowercase substrings matched with `includes`; first match wins. */
const DOMAIN_ICON_RULES: Array<{ key: string; icon: LucideIcon }> = [
  { key: 'seeker',    icon: User },
  { key: 'learner',   icon: GraduationCap },
  { key: 'student',   icon: GraduationCap },
  // service_provider must precede the 'provider' substring rule (it contains
  // "provider") so it gets Building2, not the provider Briefcase.
  { key: 'service_provider', icon: Building2 },
  { key: 'provider',  icon: Briefcase },
  { key: 'tutor',     icon: Briefcase },
  { key: 'coach',     icon: Briefcase },
  { key: 'counsellor', icon: Briefcase },
  { key: 'counselor', icon: Briefcase },
  { key: 'partner',   icon: Handshake },
  { key: 'center',    icon: Building2 },
  { key: 'centre',    icon: Building2 },
  { key: 'school',    icon: Building2 },
  { key: 'college',   icon: Building2 },
  { key: 'institute', icon: Building2 },
];

export const FALLBACK_ICON: LucideIcon = MapPin;

export function getIconForDomain(domain: string | undefined): LucideIcon {
  if (!domain) return FALLBACK_ICON;
  const lower = domain.toLowerCase();
  for (const rule of DOMAIN_ICON_RULES) {
    if (lower.includes(rule.key)) return rule.icon;
  }
  return FALLBACK_ICON;
}
