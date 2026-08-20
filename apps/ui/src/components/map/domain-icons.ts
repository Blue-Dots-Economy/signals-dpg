/**
 * domain-icons.ts
 *
 * Single source of truth for the domain → lucide icon mapping used by all
 * map providers. The mapping is intentionally generic (keyed on common domain
 * name substrings) so it works for any network — not just blue_dot / purple_dot.
 *
 * Design: precision-based COLOR is preserved on the marker background; the
 * domain-based ICON is used as the glyph on top. This retains the existing
 * precision signal while adding domain differentiation.
 *
 * Icon sizing for divIcon HTML: 16 × 16 px, white stroke.
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

/**
 * Maps a domain id substring → lucide icon component.
 * Keys are lowercase substrings; matched via `domain.toLowerCase().includes(key)`.
 * Order matters: first match wins.
 */
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

/** Fallback icon when no domain rule matches or domain is absent. */
export const FALLBACK_ICON: LucideIcon = MapPin;

/**
 * Returns the lucide icon component for a given domain string.
 * Falls back to FALLBACK_ICON for any unknown / missing domain.
 */
export function getIconForDomain(domain: string | undefined): LucideIcon {
  if (!domain) return FALLBACK_ICON;
  const lower = domain.toLowerCase();
  for (const rule of DOMAIN_ICON_RULES) {
    if (lower.includes(rule.key)) return rule.icon;
  }
  return FALLBACK_ICON;
}
