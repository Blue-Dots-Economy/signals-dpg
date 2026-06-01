import * as React from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Wallet, Trash2, OctagonX } from 'lucide-react';
import type { RJSFSchema } from '@rjsf/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SchemaForm } from '@/components/forms/schema-form';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { AuthShell } from '@/components/layout/auth-shell';
import { NetworkConstellation } from '@/components/layout/network-constellation';
import { RoleCard } from '@/components/cards/role-card';
import { useNetworkTheme } from '@/theme/theme-provider';
import { WalletImportModal } from '@/components/wallet/wallet-import-modal';
import { resolveNetworkRefs } from '@/engine/schema/resolve-schema';
import type { DotNetworkSchema } from '@/engine/types';
import { getConfiguredWalletProviders } from '@/engine/wallet/wallet-registry';
import type { WalletImportResult } from '@/engine/wallet/types';
import { useAuth } from '@/contexts/auth-context';
import { useMyNetworks } from '@/hooks/use-my-networks';
import { mergeImportedDataIntoSchema } from '@/lib/import-mapping';

import {
  createItem,
  deleteItem,
  fetchItems,
  updateItem,
  type CreateItemPayload,
  type UpdateItemPayload,
  type Item,
} from '@/lib/item-api';
import { fetchNetworkConfig, fetchNetworkConfigs } from '@/lib/network-api';
import { extractAndGeocode } from '@/lib/item-utils';
import { apiConfig } from '@/lib/api-config';

function parseNetworkIds(networkEnv: string | undefined): string[] {
  if (!networkEnv) return [];
  return networkEnv.split(',').map(n => n.trim()).filter(Boolean);
}

import { getDomainIcon } from '@/lib/domain-icons';

export function ProfileFormPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const { theme } = useNetworkTheme();
  const isEdit = !!id;

  const [selectedDomain, setSelectedDomain] = React.useState<string | null>(null);
  const [resolvedNetwork, setResolvedNetwork] = React.useState<DotNetworkSchema | null>(null);
  const [existingItem, setExistingItem] = React.useState<Item | null>(null);
  const [initialData, setInitialData] = React.useState<Record<string, unknown> | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(isEdit);
  const [availableNetworkIds, setAvailableNetworkIds] = React.useState<string[] | null>(null);
  const [isWalletModalOpen, setIsWalletModalOpen] = React.useState(false);
  const [formError, setFormError] = React.useState<{ title: string; description?: string } | null>(null);

  // Get network from URL query param, fallback to env config
  const configuredNetworkIds = React.useMemo(
    () => parseNetworkIds(import.meta.env.VITE_NETWORK_ID),
    []
  );
  const networkFromUrl = searchParams.get('network');

  React.useEffect(() => {
    const controller = new AbortController();

    fetchNetworkConfigs()
      .then((networks) => {
        if (controller.signal.aborted) return;
        const filteredNetworks = configuredNetworkIds.length > 0
          ? networks.filter((network) => configuredNetworkIds.includes(network.id))
          : networks;
        setAvailableNetworkIds(filteredNetworks.map((network) => network.id));
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        console.error('Failed to fetch networks:', err);
        setAvailableNetworkIds([]);
        setIsLoading(false);
      });

    return () => { controller.abort(); };
  }, [configuredNetworkIds]);

  const targetNetworkId = React.useMemo(() => {
    if (availableNetworkIds === null) return null;
    if (networkFromUrl && availableNetworkIds.includes(networkFromUrl)) {
      return networkFromUrl;
    }
    return availableNetworkIds[0] ?? null;
  }, [availableNetworkIds, networkFromUrl]);

  // Fetch and resolve network config from API
  React.useEffect(() => {
    if (!targetNetworkId) return;

    const controller = new AbortController();
    setResolvedNetwork(null);

    fetchNetworkConfig(targetNetworkId)
      .then((config) => {
        if (controller.signal.aborted) return;
        return resolveNetworkRefs(config, { baseUrl: apiConfig.getUrl() });
      })
      .then((resolved) => {
        if (controller.signal.aborted || !resolved) return;
        setResolvedNetwork(resolved as DotNetworkSchema);
      })
      .catch((err) => {
        console.error('Failed to fetch network config:', err);
        setIsLoading(false);
      });

    return () => { controller.abort(); };
  }, [targetNetworkId]);

  // Fetch existing profile for edit mode
  React.useEffect(() => {
    if (!isEdit || !id || !resolvedNetwork) return;

    let cancelled = false;

    const loadExistingProfile = async () => {
      try {
        let foundItem = false;
        // Search across all domains to find the item
        for (const domain of resolvedNetwork.domains ?? []) {
          const itemTypeKeys = domain.item_schemas ? Object.keys(domain.item_schemas) : [];
          const itemType = itemTypeKeys.length > 0 ? itemTypeKeys[0] : 'profile';

          const response = await fetchItems({
            item_network: resolvedNetwork.id,
            item_domain: domain.id,
            item_type: itemType,
            item_id: id,
            limit: 1,
          });

          if (response.items.length > 0) {
            if (cancelled) return;
            const item = response.items[0];
            setExistingItem(item);
            setSelectedDomain(item.item_domain);
            setInitialData(item.item_state);
            foundItem = true;
            break;
          }
        }

        if (!cancelled && !foundItem) {
          toast.error('Profile not found', {
            description: 'This profile doesn\'t exist on the selected network. You may have followed an outdated link.',
          });
          navigate(`/?network=${resolvedNetwork.id}`);
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to load profile:', err);
          toast.error('Couldn\'t load profile', {
            description: 'There was a problem fetching your profile data. Please check your connection and try again.',
          });
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    loadExistingProfile();
    return () => { cancelled = true; };
  }, [isEdit, id, resolvedNetwork]);

  const network = resolvedNetwork;

  // Filter network domains down to the user's membership for this network.
  // A user holds only one domain per network (app-enforced; user.domains
  // text[] stores at most one "network/X" entry per network); the picker
  // should reflect that — no point offering a role they're not allowed
  // to create items under.
  const { data: myMemberships } = useMyNetworks(Boolean(user));
  const allDomains = network?.domains ?? [];
  const myDomainHere = React.useMemo(() => {
    if (!network || !myMemberships) return null;
    return myMemberships.find((m) => m.network === network.id)?.domain ?? null;
  }, [network, myMemberships]);
  const domains = React.useMemo(() => {
    if (!myDomainHere) return allDomains;
    return allDomains.filter((d) => d.id === myDomainHere);
  }, [allDomains, myDomainHere]);

  // Auto-select the single allowed domain so the picker step is skipped.
  React.useEffect(() => {
    if (!selectedDomain && !isEdit && myDomainHere) {
      setSelectedDomain(myDomainHere);
    }
  }, [selectedDomain, isEdit, myDomainHere]);

  // Find the profile schema for the selected domain
  const profileSchema = React.useMemo<RJSFSchema | null>(() => {
    if (!selectedDomain || !domains.length) return null;
    const domain = domains.find((d) => d.id === selectedDomain);
    return domain?.item_schemas ? Object.values(domain.item_schemas)[0] : null;
  }, [selectedDomain, domains]);

  // Get the default item type name from domain config (e.g., "profile_1.0")
  const defaultItemType = React.useMemo<string | null>(() => {
    if (!selectedDomain || !domains.length) return null;
    const domain = domains.find((d) => d.id === selectedDomain);
    const itemTypeKeys = domain?.item_schemas ? Object.keys(domain.item_schemas) : [];
    return itemTypeKeys.length > 0 ? itemTypeKeys[0] : null;
  }, [selectedDomain, domains]);

  const selectedDomainInfo = domains.find((d) => d.id === selectedDomain);
  const DomainIcon = getDomainIcon(selectedDomain, network?.id);
  const roleLabel = (selectedDomain ?? '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const canImportCredentials = React.useMemo(
    () => Boolean(profileSchema) && getConfiguredWalletProviders().length > 0,
    [profileSchema]
  );

  // Get network-level instance URL and schema URL for the selected domain
  const domainInstance = React.useMemo(() => {
    if (!selectedDomain || !network) return null;
    return network.instances?.find((i) => i.domain_id === selectedDomain) ?? null;
  }, [selectedDomain, network]);

  const walletImportContext = React.useMemo(
    () => ({
      user: {
        email: user?.email ?? null,
        phoneNumber: user?.phoneNumber ?? null,
        name: user?.name ?? 'User',
      },
      networkId: network?.id ?? null,
      domainId: selectedDomain,
      schema: profileSchema,
      formData: initialData,
    }),
    [initialData, network?.id, profileSchema, selectedDomain, user?.email, user?.name, user?.phoneNumber]
  );

  const handleImportedCredentials = React.useCallback(
    (result: WalletImportResult) => {
      if (!profileSchema) {
        toast.error('No profile schema available', {
          description: 'Select a role first before importing credentials — the form needs to be ready to receive data.',
        });
        return;
      }

      const { mergedData, mappedCount, skippedKeys } = mergeImportedDataIntoSchema(
        profileSchema,
        initialData,
        result
      );

      if (mappedCount === 0) {
        toast.error(`Imported from ${result.providerLabel}, but none of the fields matched this form.`);
        return;
      }

      setInitialData(mergedData);

      if (skippedKeys.length > 0) {
        toast.success(`Imported ${mappedCount} field${mappedCount === 1 ? '' : 's'} from ${result.providerLabel}.`, {
          description: `${skippedKeys.length} field${skippedKeys.length === 1 ? '' : 's'} did not match this schema.`,
        });
        return;
      }

      toast.success(`Imported ${mappedCount} field${mappedCount === 1 ? '' : 's'} from ${result.providerLabel}.`, {
        description: result.summary,
      });
    },
    [initialData, profileSchema]
  );

  const handleSubmit = async (data: Record<string, unknown>) => {
    if (!selectedDomain || !network) return;

    setIsSubmitting(true);
    setFormError(null);

    try {
      // Geocode from domain-specific pincode field
      const { coordinates } = await extractAndGeocode(data, selectedDomain);

      if (isEdit && existingItem) {
        // Update existing profile
        const updatePayload: UpdateItemPayload = {
          item_state: data,
        };

        if (coordinates) {
          updatePayload.item_latitude = coordinates.lat;
          updatePayload.item_longitude = coordinates.lng;
        }

        await updateItem(existingItem.item_id, updatePayload);
        toast.success('Profile updated!', {
          description: 'Your changes have been saved and are now visible on the network.',
        });
      } else {
        // Create new profile
        const createPayload: CreateItemPayload = {
          item_network: network.id,
          item_domain: selectedDomain,
          item_type: defaultItemType ?? 'profile',
          item_state: data,
        };

        if (domainInstance?.instance_url) {
          createPayload.item_instance_url = domainInstance.instance_url;
        }

        const customSchemaUrls = domainInstance?.custom_item_schema_urls as Record<string, string> | undefined;
        if (defaultItemType && customSchemaUrls?.[defaultItemType]) {
          createPayload.item_schema_url = customSchemaUrls[defaultItemType];
        }

        if (coordinates) {
          createPayload.item_latitude = coordinates.lat;
          createPayload.item_longitude = coordinates.lng;
        }

        await createItem(createPayload);
        toast.success('Profile created!', {
          description: 'You\'re now visible on the network. Others can discover and connect with you.',
        });
      }

      navigate(`/?network=${resolvedNetwork?.id ?? ''}`);
    } catch (err: unknown) {
      console.error('Failed to save profile:', err);

      const axiosError = err as { response?: { status?: number; data?: { error?: string; message?: string } } };
      const status = axiosError?.response?.status;
      const error = axiosError?.response?.data;

      if (status === 403 && error?.error === 'UNSERVED_DOMAIN_BINDING') {
        setFormError({
          title: 'Role not available on this instance',
          description: error?.message ?? 'This profile type isn\'t supported here. Try a different role or contact your network administrator.',
        });
      } else if (status === 401) {
        const redirectTo = `${location.pathname}${location.search}`;
        toast.error('Please sign in to continue', {
          description: 'Your session has expired or you are not signed in.',
        });
        navigate(`/auth/login?redirect=${encodeURIComponent(redirectTo)}`);
      } else if (status === 409) {
        setFormError({
          title: 'Profile already exists',
          description: 'You already have a profile for this role. Return to the home page to view or edit your existing profile.',
        });
      } else {
        setFormError({
          title: isEdit ? 'Couldn\'t update your profile' : 'Couldn\'t create your profile',
          description: error?.message ?? 'An unexpected error occurred. Please try again — if the problem persists, contact support.',
        });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!existingItem) return;
    if (!window.confirm('Delete this profile? This cannot be undone.')) return;

    setIsDeleting(true);
    try {
      await deleteItem(existingItem.item_id);
      toast.success('Profile deleted', {
        description: 'Your profile has been permanently removed from the network.',
      });
      navigate(`/?network=${resolvedNetwork?.id ?? ''}`);
    } catch (err: unknown) {
      const axiosError = err as { response?: { status?: number; data?: { error?: string; message?: string } } };
      const status = axiosError?.response?.status;
      const error = axiosError?.response?.data;
      if (status === 404) {
        toast.error('Profile not found', {
          description: 'It may have already been deleted, or it does not belong to you.',
        });
      } else if (status === 401) {
        toast.error('Session expired', {
          description: 'Please sign in again to continue managing your profile.',
        });
      } else {
        toast.error('Failed to delete profile', {
          description: error?.message ?? 'Something went wrong',
        });
      }
    } finally {
      setIsDeleting(false);
    }
  };

  if (availableNetworkIds === null || isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-muted-foreground">
          {isLoading ? 'Loading profile...' : 'Loading network schemas...'}
        </p>
      </div>
    );
  }

  if (!targetNetworkId) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-muted-foreground">No networks available.</p>
      </div>
    );
  }

  if (!network) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading network schemas...</p>
      </div>
    );
  }

  // Domain selection step
  if (!selectedDomain && !isEdit) {
    return (
      <AuthShell>
        <button
          type="button"
          onClick={() => navigate(`/?network=${targetNetworkId}`)}
          className="mb-6 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        <div className="mb-6">
          <p className="mb-2 inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">
            {theme.portalLabel}
          </p>
          <h2 className="text-2xl font-bold">Create Profile</h2>
          <p className="text-muted-foreground mt-1">Choose your role on the network</p>
          <p className="text-sm text-muted-foreground/80 mt-2">{theme.subline}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {domains.map((domain, idx) => {
            const Icon = getDomainIcon(domain.id, network?.id);
            const label = domain.id
              .replace(/_/g, ' ')
              .replace(/\b\w/g, (c) => c.toUpperCase());
            return (
              <RoleCard
                key={domain.id}
                icon={Icon}
                title={label}
                description={domain.description ?? ''}
                onClick={() => setSelectedDomain(domain.id)}
                variant={idx % 2 === 0 ? 'primary' : 'secondary'}
              />
            );
          })}
        </div>
      </AuthShell>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-[var(--brand-hero-to)]/8 to-background p-4 sm:p-6">
      <div className="mx-auto max-w-2xl">
        {/* Branded hero strip — sits flush above the form Card */}
        <div className="relative overflow-hidden rounded-t-xl bg-brand-hero">
          <div className="pointer-events-none absolute inset-0 opacity-15">
            <NetworkConstellation className="h-full w-full" />
          </div>
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-black/50 via-black/20 to-transparent" />
          <div className="relative z-10 px-5 pt-4 sm:px-6">
            <button
              type="button"
              onClick={() => {
                // When the user has a fixed membership domain, the picker step
                // is skipped entirely — clearing selectedDomain would just be
                // re-applied by the auto-select effect, so go straight home.
                if (selectedDomain && !isEdit && !myDomainHere) {
                  setSelectedDomain(null);
                } else {
                  navigate(`/?network=${resolvedNetwork?.id ?? ''}`);
                }
              }}
              className="flex items-center gap-1.5 text-sm text-white/70 hover:text-white transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              {selectedDomain && !isEdit && !myDomainHere
                ? 'Choose different role'
                : 'Back'}
            </button>
          </div>
          <div className="relative z-10 flex items-center gap-4 px-5 pb-6 pt-3 sm:px-6">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-white/20 backdrop-blur-sm ring-1 ring-white/20">
              <DomainIcon className="h-6 w-6 text-white" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/50">
                {theme.portalLabel}
              </p>
              <h2 className="text-xl font-bold text-white leading-tight truncate">
                {isEdit ? `Edit ${roleLabel} Profile` : `Create ${roleLabel} Profile`}
              </h2>
              <p className="mt-0.5 text-xs text-white/70 leading-snug">
                {selectedDomainInfo?.description ?? 'Fill in your profile details'}
              </p>
            </div>
          </div>
        </div>

        {/* Form card — connects flush to the hero strip */}
        <Card className="rounded-t-none border-t-0 shadow-lg">
          <CardContent className="pt-6">
            {canImportCredentials && (
              <div className="mb-4">
                <Button variant="outline" size="sm" onClick={() => setIsWalletModalOpen(true)}>
                  <Wallet className="h-4 w-4" />
                  Import Credentials
                </Button>
              </div>
            )}

            {formError && (
              <Alert variant="destructive" className="mb-4">
                <OctagonX className="h-4 w-4" />
                <AlertTitle>{formError.title}</AlertTitle>
                {formError.description && <AlertDescription>{formError.description}</AlertDescription>}
              </Alert>
            )}

            {profileSchema && (
              <SchemaForm
                schema={profileSchema}
                onSubmit={handleSubmit}
                disabled={isSubmitting || isDeleting}
                formData={initialData ?? undefined}
                submitButtonText={isEdit ? 'Update' : undefined}
                domainId={selectedDomain ?? undefined}
              />
            )}
            {isEdit && existingItem && (
              <div className="mt-6 pt-4 border-t flex items-center justify-between gap-4">
                <p className="text-xs text-muted-foreground">
                  Removing the profile is permanent — applications and matches against this profile will no longer be visible.
                </p>
                <Button
                  variant="destructive"
                  size="sm"
                  className="shrink-0 gap-2"
                  onClick={handleDelete}
                  disabled={isSubmitting || isDeleting}
                >
                  <Trash2 className="h-4 w-4" />
                  {isDeleting ? 'Deleting…' : 'Delete profile'}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <WalletImportModal
          open={isWalletModalOpen}
          onOpenChange={setIsWalletModalOpen}
          context={walletImportContext}
          onImported={handleImportedCredentials}
        />
      </div>
    </div>
  );
}
