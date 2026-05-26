import {
  GraduationCap,
  UserCheck,
  Building2,
  Accessibility,
  HandHeart,
  Box,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export const domainIcons: Record<string, LucideIcon> = {
  // yellow_dot / education network
  student_profile: GraduationCap,
  learner_profile: GraduationCap,
  student: GraduationCap,
  tutor_counsellor_profile: UserCheck,
  tutor_counsellor: UserCheck,
  coaching_center: Building2,
  // purple_dot / disability services network
  seeker: Accessibility,
  provider: HandHeart,
};

export function getDomainIcon(domainId: string | null | undefined): LucideIcon {
  if (!domainId) return Box;
  return domainIcons[domainId] ?? Box;
}

export function formatDomainLabel(domainId: string | null | undefined): string {
  if (!domainId) return '';
  return domainId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
