import * as React from 'react';
import { formatDistanceToNow } from 'date-fns';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  ChevronDown,
  ChevronUp,
  Check,
  X,
  CheckCircle2,
  Clock,
  AlertCircle,
  ArrowRight,
  User,
  MapPin,
} from 'lucide-react';
import type { Action } from '@/lib/action-api';

interface ActionCardProps {
  action: Action;
  ownershipRole: 'initiated' | 'received';
  onStatusUpdate?: (action: Action) => void;
}

const statusConfig: Record<
  string,
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; icon: React.ReactNode }
> = {
  created: {
    label: 'Pending',
    variant: 'secondary',
    icon: <Clock className="h-3 w-3" />,
  },
  pending: {
    label: 'Pending',
    variant: 'secondary',
    icon: <Clock className="h-3 w-3" />,
  },
  accepted: {
    label: 'Accepted',
    variant: 'default',
    icon: <Check className="h-3 w-3" />,
  },
  rejected: {
    label: 'Rejected',
    variant: 'destructive',
    icon: <X className="h-3 w-3" />,
  },
  completed: {
    label: 'Completed',
    variant: 'default',
    icon: <CheckCircle2 className="h-3 w-3" />,
  },
  cancelled: {
    label: 'Cancelled',
    variant: 'outline',
    icon: <AlertCircle className="h-3 w-3" />,
  },
};

const actionTypeColors: Record<string, string> = {
  connect: 'bg-blue-100 text-blue-800 border-blue-200',
  apply: 'bg-green-100 text-green-800 border-green-200',
  share: 'bg-purple-100 text-purple-800 border-purple-200',
  bookmark: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  message: 'bg-pink-100 text-pink-800 border-pink-200',
};

function getStatusConfig(status: string) {
  return statusConfig[status] ?? { label: status, variant: 'outline', icon: null };
}

function getActionTypeClass(actionType: string): string {
  return (
    actionTypeColors[actionType.toLowerCase()] ??
    'bg-gray-100 text-gray-800 border-gray-200'
  );
}

function formatItemLocation(
  latitude: number | null | undefined,
  longitude: number | null | undefined
): string | null {
  if (latitude == null || longitude == null) return null;
  return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
}

export function ActionCard({ action, ownershipRole, onStatusUpdate }: ActionCardProps) {
  const [isExpanded, setIsExpanded] = React.useState(false);
  const [showRequirements, setShowRequirements] = React.useState(false);

  const status = getStatusConfig(action.action_status);
  const actionTypeClass = getActionTypeClass(action.action_type);

  // Determine which item is "the other party" based on ownership
  const otherParty =
    ownershipRole === 'initiated'
      ? {
          itemId: action.target_item_id,
          network: action.target_item_network,
          domain: action.target_item_domain,
          type: action.target_item_type,
          owner: action.target_item_owner,
          latitude: action.target_item_latitude,
          longitude: action.target_item_longitude,
          label: 'To',
        }
      : {
          itemId: action.source_item_id,
          network: action.source_item_network,
          domain: action.source_item_domain,
          type: action.source_item_type,
          owner: action.source_item_owner,
          latitude: action.source_item_latitude,
          longitude: action.source_item_longitude,
          label: 'From',
        };

  const myItem =
    ownershipRole === 'initiated'
      ? {
          itemId: action.source_item_id,
          network: action.source_item_network,
          domain: action.source_item_domain,
          type: action.source_item_type,
        }
      : {
          itemId: action.target_item_id,
          network: action.target_item_network,
          domain: action.target_item_domain,
          type: action.target_item_type,
        };

  const location = formatItemLocation(otherParty.latitude, otherParty.longitude);

  // Determine available actions based on status and ownership
  const canAccept =
    ownershipRole === 'received' &&
    (action.action_status === 'created' || action.action_status === 'pending');
  const canReject =
    ownershipRole === 'received' &&
    (action.action_status === 'created' || action.action_status === 'pending');
  const canComplete =
    ownershipRole === 'received' && action.action_status === 'accepted';
  const canCancel =
    ownershipRole === 'initiated' &&
    (action.action_status === 'created' || action.action_status === 'pending');

  return (
    <Card className="w-full">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={actionTypeClass}>
              {action.action_type}
            </Badge>
            <Badge variant={status.variant} className="gap-1">
              {status.icon}
              {status.label}
            </Badge>
          </div>
          <span className="text-muted-foreground text-xs">
            {formatDistanceToNow(new Date(action.created_at), { addSuffix: true })}
          </span>
        </div>
        <CardTitle className="text-base font-medium pt-2">
          {myItem.domain} → {otherParty.domain}
        </CardTitle>
        <CardDescription className="text-xs">
          Action #{action.action_id.slice(0, 8)} • Update #{action.update_count}
        </CardDescription>
      </CardHeader>

      <CardContent className="pb-3 space-y-3">
        {/* Flow visualization */}
        <div className="flex items-center gap-2 text-sm">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1 text-muted-foreground text-xs">
              <User className="h-3 w-3" />
              <span>Your {myItem.domain}</span>
            </div>
            <p className="font-medium truncate">{myItem.type}</p>
            <p className="text-muted-foreground text-xs truncate">
              ID: {myItem.itemId.slice(0, 8)}...
            </p>
          </div>

          <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1 text-muted-foreground text-xs">
              <span className="font-medium">{otherParty.label}</span>
              {otherParty.domain}
            </div>
            <p className="font-medium truncate">{otherParty.type}</p>
            <p className="text-muted-foreground text-xs truncate">
              ID: {otherParty.itemId.slice(0, 8)}...
            </p>
          </div>
        </div>

        {/* Location info if available */}
        {location && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <MapPin className="h-3 w-3" />
            <span>{location}</span>
          </div>
        )}

        <Separator />

        {/* Requirements snapshot */}
        {Object.keys(action.requirements_snapshot).length > 0 && (
          <Collapsible open={showRequirements} onOpenChange={setShowRequirements}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="w-full justify-between p-0 h-auto">
                <span className="text-xs font-medium">Requirements</span>
                {showRequirements ? (
                  <ChevronUp className="h-3 w-3" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="bg-muted rounded-md p-2 mt-2">
                <pre className="text-xs overflow-auto max-h-32">
                  {JSON.stringify(action.requirements_snapshot, null, 2)}
                </pre>
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Expanded details */}
        {isExpanded && (
          <div className="text-xs text-muted-foreground space-y-1 pt-2">
            <p>Created: {new Date(action.created_at).toLocaleString()}</p>
            <p>Updated: {new Date(action.updated_at).toLocaleString()}</p>
            <p>Action ID: {action.action_id}</p>
            <p>Updates: {action.update_count}</p>
          </div>
        )}
      </CardContent>

      <CardFooter className="pt-0 flex flex-wrap gap-2">
        {/* Action buttons for target user (received) */}
        {canAccept && (
          <Button
            size="sm"
            onClick={() => onStatusUpdate?.(action)}
            className="flex-1"
          >
            <Check className="h-3 w-3 mr-1" />
            Accept
          </Button>
        )}
        {canReject && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onStatusUpdate?.(action)}
            className="flex-1"
          >
            <X className="h-3 w-3 mr-1" />
            Reject
          </Button>
        )}
        {canComplete && (
          <Button
            size="sm"
            onClick={() => onStatusUpdate?.(action)}
            className="flex-1"
          >
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Complete
          </Button>
        )}

        {/* Action buttons for source user (initiated) */}
        {canCancel && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onStatusUpdate?.(action)}
            className="flex-1"
          >
            <AlertCircle className="h-3 w-3 mr-1" />
            Cancel
          </Button>
        )}

        {/* Details toggle */}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setIsExpanded(!isExpanded)}
          className="ml-auto"
        >
          {isExpanded ? 'Less' : 'Details'}
        </Button>
      </CardFooter>
    </Card>
  );
}
