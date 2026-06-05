import {
  Handshake,
  CheckCircle2,
  XCircle,
  Ban,
  BadgeCheck,
  Clock,
  Sparkles,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface ActionDisplay {
  icon: LucideIcon;
  label: string;
  gradient: string;
  buttonClass: string;
  toneText: string;
  /**
   * When true, the modal header uses the active network theme gradient
   * (--brand-hero-from → --brand-hero-to) instead of the static `gradient`
   * class. Connect is themed per dot; semantic actions (accept/reject/…)
   * keep their fixed colours.
   */
  themed?: boolean;
}

// Visual treatment per action type / status. The gradient is used in the modal
// header band; buttonClass styles the primary CTA to match the tone.
const ACTION_DISPLAY: Record<string, ActionDisplay> = {
  connect: {
    icon: Handshake,
    label: 'Connect',
    gradient: 'from-violet-600 to-indigo-600',
    buttonClass: 'bg-brand-cta hover:brightness-110 text-white',
    toneText: 'text-white/85',
    themed: true,
  },
  accept: {
    icon: CheckCircle2,
    label: 'Accept',
    gradient: 'from-emerald-600 to-green-600',
    buttonClass: 'bg-emerald-600 hover:bg-emerald-700 text-white',
    toneText: 'text-emerald-50',
  },
  accepted: {
    icon: CheckCircle2,
    label: 'Accept',
    gradient: 'from-emerald-600 to-green-600',
    buttonClass: 'bg-emerald-600 hover:bg-emerald-700 text-white',
    toneText: 'text-emerald-50',
  },
  reject: {
    icon: XCircle,
    label: 'Reject',
    gradient: 'from-rose-600 to-red-600',
    buttonClass: 'bg-rose-600 hover:bg-rose-700 text-white',
    toneText: 'text-rose-50',
  },
  rejected: {
    icon: XCircle,
    label: 'Reject',
    gradient: 'from-rose-600 to-red-600',
    buttonClass: 'bg-rose-600 hover:bg-rose-700 text-white',
    toneText: 'text-rose-50',
  },
  cancel: {
    icon: Ban,
    label: 'Cancel',
    gradient: 'from-slate-600 to-zinc-600',
    buttonClass: 'bg-slate-600 hover:bg-slate-700 text-white',
    toneText: 'text-slate-50',
  },
  cancelled: {
    icon: Ban,
    label: 'Cancel',
    gradient: 'from-slate-600 to-zinc-600',
    buttonClass: 'bg-slate-600 hover:bg-slate-700 text-white',
    toneText: 'text-slate-50',
  },
  complete: {
    icon: BadgeCheck,
    label: 'Complete',
    gradient: 'from-sky-600 to-blue-600',
    buttonClass: 'bg-sky-600 hover:bg-sky-700 text-white',
    toneText: 'text-sky-50',
  },
  completed: {
    icon: BadgeCheck,
    label: 'Complete',
    gradient: 'from-sky-600 to-blue-600',
    buttonClass: 'bg-sky-600 hover:bg-sky-700 text-white',
    toneText: 'text-sky-50',
  },
  pending: {
    icon: Clock,
    label: 'Pending',
    gradient: 'from-amber-500 to-orange-500',
    buttonClass: 'bg-amber-600 hover:bg-amber-700 text-white',
    toneText: 'text-amber-50',
  },
};

const FALLBACK: ActionDisplay = {
  icon: Sparkles,
  label: 'Action',
  gradient: 'from-violet-600 to-indigo-600',
  buttonClass: 'bg-brand-cta hover:brightness-110 text-white',
  toneText: 'text-white/85',
  themed: true,
};

export function getActionDisplay(actionKey: string | null | undefined): ActionDisplay {
  if (!actionKey) return FALLBACK;
  const key = actionKey.toLowerCase();
  return ACTION_DISPLAY[key] ?? { ...FALLBACK, label: actionKey.charAt(0).toUpperCase() + actionKey.slice(1) };
}
