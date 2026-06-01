import * as React from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/auth-context';
import { useNavigate } from 'react-router-dom';
import { useNetworkTheme } from '@/theme/theme-provider';
import { useNetworkConfig } from '@/hooks/use-network-config';
import { useMyNetworks, useJoinNetwork } from '@/hooks/use-my-networks';

/**
 * Top-level gate shown when a logged-in user lands on a network they
 * haven't joined yet (no matching "network/domain" in user.domains).
 * Asks them to pick a role once; on submit appends to user.domains via
 * POST /api/v1/me/domains and never asks again for that network.
 */
export function NetworkJoinGate() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { themeId, theme } = useNetworkTheme();
  const { data: memberships, isLoading: membershipsLoading } = useMyNetworks(
    Boolean(user),
  );
  const { data: networkConfig } = useNetworkConfig(themeId);
  const join = useJoinNetwork();
  const [domain, setDomain] = React.useState<string>('');

  if (!user) return null;
  if (membershipsLoading) return null;
  if (!networkConfig) return null;

  const hasMembership = memberships?.some((m) => m.network === themeId);
  if (hasMembership) return null;

  const domainOptions = networkConfig.domains ?? [];
  const open = !hasMembership;

  const onConfirm = async () => {
    if (!domain) return;
    try {
      await join.mutateAsync({ network: themeId, domain });
      toast.success(`Welcome to ${theme.name}`, {
        description: `You're now registered as ${domain}.`,
      });
    } catch (err: unknown) {
      const e = err as {
        response?: { status?: number; data?: { code?: string; message?: string } };
      };
      const status = e?.response?.status;
      const code = e?.response?.data?.code;
      const message = e?.response?.data?.message ?? 'Could not register membership';
      // better-auth's APIError('CONFLICT', …) serialises as HTTP 409 with
      // body.code === 'CONFLICT'. Earlier we keyed on a custom string that
      // never appeared, so the friendly toast was unreachable.
      if (status === 409 || code === 'CONFLICT') {
        toast.error('Already registered in this network', {
          description: message,
        });
      } else {
        toast.error('Could not join network', { description: message });
      }
    }
  };

  return (
    <Dialog open={open}>
      <DialogContent
        // Block escape + outside-click — the gate must be answered before
        // anything else on the page becomes interactive. Bump z-index past
        // Leaflet/Google map panes (which sit above the default z-50).
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>Confirm your role in {theme.name}</DialogTitle>
        </DialogHeader>
        <div className="py-2">
          <Select
            value={domain}
            onValueChange={setDomain}
            disabled={join.isPending || domainOptions.length === 0}
          >
            <SelectTrigger className="h-11 w-full">
              <SelectValue
                placeholder={
                  domainOptions.length === 0
                    ? 'Loading roles…'
                    : 'Select your role'
                }
              >
                {domain ? <span className="capitalize">{domain}</span> : null}
              </SelectValue>
            </SelectTrigger>
            <SelectContent
              position="popper"
              className="w-[var(--radix-select-trigger-width)] max-w-[var(--radix-select-trigger-width)]"
            >
              {domainOptions.map((d) => (
                <SelectItem
                  key={d.id}
                  value={d.id}
                  textValue={d.id}
                  className="py-2"
                >
                  <div className="flex flex-col gap-0.5 text-left">
                    <span className="capitalize font-medium leading-tight">
                      {d.id}
                    </span>
                    {d.description ? (
                      <span className="text-xs text-muted-foreground leading-snug whitespace-normal break-words">
                        {d.description}
                      </span>
                    ) : null}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
          <Button
            onClick={onConfirm}
            disabled={!domain || join.isPending}
            className="w-full"
          >
            {join.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
            Confirm
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="w-full text-muted-foreground hover:text-foreground"
            onClick={async () => {
              await signOut();
              navigate('/auth/login');
            }}
          >
            Sign out instead
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
