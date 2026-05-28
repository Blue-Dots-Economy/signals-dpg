import * as React from 'react';
import { formatDistanceToNow } from 'date-fns';
import {
  ChevronDown,
  Check,
  X,
  CheckCircle2,
  Clock,
  AlertCircle,
  Sparkles,
  ArrowRight,
  MessageSquare,
  Contact,
  MapPin,
  Network,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Action } from '@/lib/action-api';
import { ContactDetailsModal } from '@/components/actions/contact-details-modal';

interface ActionCardProps {
  action: Action;
  ownershipRole: 'initiated' | 'received';
  onStatusUpdate?: (action: Action) => void;
}

// Status pill: dot + label on a soft tint. Semantic colours (not brand) so
// state reads consistently across networks.
const statusStyles: Record<
  string,
  { label: string; cls: string; dot: string; icon: React.ReactNode }
> = {
  created: { label: 'Pending', cls: 'bg-amber-50 text-amber-700', dot: 'bg-amber-500', icon: <Clock className="h-3 w-3" /> },
  pending: { label: 'Pending', cls: 'bg-amber-50 text-amber-700', dot: 'bg-amber-500', icon: <Clock className="h-3 w-3" /> },
  new: { label: 'New', cls: 'bg-primary/10 text-primary', dot: 'bg-primary', icon: <Sparkles className="h-3 w-3" /> },
  accepted: { label: 'Accepted', cls: 'bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', icon: <Check className="h-3 w-3" /> },
  completed: { label: 'Completed', cls: 'bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', icon: <CheckCircle2 className="h-3 w-3" /> },
  rejected: { label: 'Rejected', cls: 'bg-red-50 text-red-700', dot: 'bg-red-500', icon: <X className="h-3 w-3" /> },
  cancelled: { label: 'Cancelled', cls: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400', icon: <AlertCircle className="h-3 w-3" /> },
};

function getStatusStyle(status: string) {
  return (
    statusStyles[status] ?? {
      label: status,
      cls: 'bg-slate-100 text-slate-600',
      dot: 'bg-slate-400',
      icon: null,
    }
  );
}

function formatItemLocation(
  latitude: number | null | undefined,
  longitude: number | null | undefined
): string | null {
  if (latitude == null || longitude == null) return null;
  return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
}

function formatRequirementValue(value: unknown): string {
  if (value == null) return '—';
  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const titleCase = (s: string) =>
  s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// Per-network chip colours pulled from each brand.json (colours.primary
// "<Dot> 500" + accent shades). Add a new entry per network as they ship.
const NETWORK_CHIP_COLOURS: Record<
  string,
  { background: string; color: string; borderColor: string }
> = {
  blue_dot: { background: '#e6f0ff', color: '#0050b3', borderColor: '#a4daff' },
  purple_dot: { background: '#f3e8ff', color: '#5a1fbf', borderColor: '#d8c2ff' },
};
const FALLBACK_CHIP = {
  background: '#eef1f6',
  color: '#2a3344',
  borderColor: '#cbd5e1',
};
const networkChipStyle = (networkId: string) =>
  NETWORK_CHIP_COLOURS[networkId] ?? FALLBACK_CHIP;

export function ActionCard({ action, ownershipRole, onStatusUpdate }: ActionCardProps) {
  const [showRequirements, setShowRequirements] = React.useState(true);
  const [showContactDetails, setShowContactDetails] = React.useState(false);
  const canRevealContact = action.action_status === 'accepted';

  const status = getStatusStyle(action.action_status);

  // Resolve the "other party" vs "me" from ownership.
  const otherParty =
    ownershipRole === 'initiated'
      ? {
          name: action.target_item_name,
          itemId: action.target_item_id,
          domain: action.target_item_domain,
          latitude: action.target_item_latitude,
          longitude: action.target_item_longitude,
        }
      : {
          name: action.source_item_name,
          itemId: action.source_item_id,
          domain: action.source_item_domain,
          latitude: action.source_item_latitude,
          longitude: action.source_item_longitude,
        };
  const myDomain =
    ownershipRole === 'initiated' ? action.source_item_domain : action.target_item_domain;

  const otherRole = titleCase(otherParty.domain);
  const myRole = titleCase(myDomain);
  const hasRealName = !!otherParty.name && otherParty.name !== otherParty.itemId;
  const rawName = hasRealName
    ? otherParty.name!
    : `#${otherParty.itemId.slice(0, 6)}`;
  const isMaskedOrFallback = !hasRealName || rawName.includes('*');
  // Avatar: first letter of a real public name, else the role's initial.
  const initial = (isMaskedOrFallback ? otherRole : rawName).charAt(0).toUpperCase() || '?';

  // Both sides format as "<Subject> (<Role>)" so the brackets consistently
  // contain the role on each end — avoids the mismatch where "You (Seeker)"
  // had role-in-brackets while "Provider (Name)" had name-in-brackets.
  const meLabel = `You (${myRole})`;
  const otherLabel = `${rawName} (${otherRole})`;
  const fromLabel = ownershipRole === 'initiated' ? meLabel : otherLabel;
  const toLabel = ownershipRole === 'initiated' ? otherLabel : meLabel;

  const location = formatItemLocation(otherParty.latitude, otherParty.longitude);

  const isPending =
    action.action_status === 'created' || action.action_status === 'pending';
  const canAccept = ownershipRole === 'received' && isPending;
  const canReject = ownershipRole === 'received' && isPending;
  const canComplete = ownershipRole === 'received' && action.action_status === 'accepted';
  const canCancel = ownershipRole === 'initiated' && isPending;

  // Message + structured requirement fields split out of the snapshot.
  const reqEntries = Object.entries(action.requirements_snapshot);
  const messageEntry = reqEntries.find(([k]) => k.toLowerCase() === 'message');
  const fieldEntries = reqEntries.filter(([k]) => k.toLowerCase() !== 'message');
  const message =
    messageEntry && typeof messageEntry[1] === 'string' ? messageEntry[1] : null;
  const hasRequirements = reqEntries.length > 0;

  return (
    <div className="group relative overflow-hidden rounded-[18px] border bg-card shadow-sm transition-all duration-200 hover:shadow-md">
      {/* Top accent strip — brand gradient */}
      <div className="h-[3px] w-full bg-gradient-to-r from-primary/40 via-primary to-primary/70" />

      <div className="p-5">
        {/* Row 1: network + type + status badges, time. Network chip
            disambiguates cross-network actions on the shared list. */}
        <div className="mb-4 flex items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {/* Each network's own brand palette (from brand.json) so the chip
                colour identifies the action's network — purple_dot purple,
                blue_dot blue — independent of the viewing context. */}
            <span
              className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-semibold"
              style={networkChipStyle(action.source_item_network)}
            >
              <Network className="h-3 w-3" />
              {titleCase(action.source_item_network)}
              {action.target_item_network !== action.source_item_network && (
                <>
                  {' '}
                  <ArrowRight className="h-2.5 w-2.5" />
                  {titleCase(action.target_item_network)}
                </>
              )}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-gradient-to-b from-background to-primary/5 px-2.5 py-1 text-[11px] font-semibold capitalize text-primary">
              {action.action_type}
            </span>
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${status.cls}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
              {status.label}
            </span>
          </div>
          <span className="whitespace-nowrap text-xs font-medium text-muted-foreground">
            {formatDistanceToNow(new Date(action.created_at), { addSuffix: true })}
          </span>
        </div>

        {/* Row 2: identity */}
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-base font-bold text-primary ring-1 ring-black/5">
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm font-semibold leading-snug text-foreground [overflow-wrap:anywhere]">
              <span>{fromLabel}</span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-primary/70" />
              <span>{toLabel}</span>
            </div>
          </div>
        </div>

        {/* Requirements */}
        {hasRequirements && (
          <>
            <button
              type="button"
              onClick={() => setShowRequirements((o) => !o)}
              className="flex w-full items-center justify-between border-t py-2.5"
            >
              <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                Requirements
              </span>
              <ChevronDown
                className={`h-4 w-4 text-muted-foreground transition-transform ${showRequirements ? 'rotate-180' : ''}`}
              />
            </button>

            {showRequirements && (
              <div className="mb-4 rounded-xl border bg-muted/50 p-3.5">
                {message && (
                  <div className="mb-3 flex items-start gap-3 border-b pb-3">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-card text-primary shadow-sm">
                      <MessageSquare className="h-3.5 w-3.5" />
                    </div>
                    <div className="min-w-0">
                      <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Message
                      </p>
                      <p className="text-[13px] leading-relaxed text-foreground [overflow-wrap:anywhere]">
                        {message}
                      </p>
                    </div>
                  </div>
                )}

                {fieldEntries.map(([key, value]) => (
                  <div
                    key={key}
                    className="grid grid-cols-1 gap-2 py-1.5 sm:grid-cols-[120px_1fr] sm:items-start sm:gap-3"
                  >
                    <div className="pt-1 text-xs font-medium text-muted-foreground">
                      {titleCase(key)}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {Array.isArray(value) ? (
                        value.length === 0 ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          value.map((v, i) => (
                            <span
                              key={i}
                              className="inline-flex items-center rounded-lg bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
                            >
                              {String(v)}
                            </span>
                          ))
                        )
                      ) : (
                        <span className="text-[13px] text-foreground [overflow-wrap:anywhere]">
                          {formatRequirementValue(value)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {location && (
          <div className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground">
            <MapPin className="h-3 w-3" />
            <span>{location}</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          {canRevealContact && (
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              onClick={() => setShowContactDetails(true)}
            >
              <Contact className="mr-1.5 h-3.5 w-3.5" />
              View contact
            </Button>
          )}

          {canAccept && (
            <Button size="sm" className="flex-1 shadow-sm" onClick={() => onStatusUpdate?.(action)}>
              <Check className="mr-1.5 h-3.5 w-3.5" />
              Accept
            </Button>
          )}
          {canReject && (
            <Button size="sm" variant="outline" className="flex-1" onClick={() => onStatusUpdate?.(action)}>
              <X className="mr-1.5 h-3.5 w-3.5" />
              Reject
            </Button>
          )}
          {canComplete && (
            <Button size="sm" className="flex-1 shadow-sm" onClick={() => onStatusUpdate?.(action)}>
              <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
              Complete
            </Button>
          )}
          {canCancel && (
            <Button size="sm" variant="outline" className="flex-1" onClick={() => onStatusUpdate?.(action)}>
              <X className="mr-1.5 h-3.5 w-3.5 text-destructive" />
              Cancel
            </Button>
          )}
        </div>
      </div>

      <ContactDetailsModal
        actionId={action.action_id}
        open={showContactDetails}
        onOpenChange={setShowContactDetails}
      />
    </div>
  );
}
