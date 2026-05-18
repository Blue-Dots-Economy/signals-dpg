import * as React from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, GraduationCap, UserCheck, Building2, Wallet } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { RJSFSchema } from '@rjsf/utils';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { SchemaForm } from '@/components/forms/schema-form';
import { WalletImportModal } from '@/components/wallet/wallet-import-modal';
import { resolveNetworkRefs } from '@/engine/schema/resolve-schema';
import type { DotNetworkSchema } from '@/engine/types';
import { getConfiguredWalletProviders } from '@/engine/wallet/wallet-registry';
import type { WalletImportResult } from '@/engine/wallet/types';
import { useAuth } from '@/contexts/auth-context';
import { mergeImportedDataIntoSchema } from '@/lib/import-mapping';

import {
  createItem,
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

const domainIcons: Record<string, LucideIcon> = {
  student_profile: GraduationCap,
  learner_profile: GraduationCap,
  tutor_counsellor_profile: UserCheck,
  coaching_center: Building2,
};

export function ProfileFormPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const isEdit = !!id;

  const [selectedDomain, setSelectedDomain] = React.useState<string | null>(null);
  const [resolvedNetwork, setResolvedNetwork] = React.useState<DotNetworkSchema | null>(null);
  const [existingItem, setExistingItem] = React.useState<Item | null>(null);
  const [initialData, setInitialData] = React.useState<Record<string, unknown> | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(isEdit);
  const [availableNetworkIds, setAvailableNetworkIds] = React.useState<string[] | null>(null);
  const [isWalletModalOpen, setIsWalletModalOpen] = React.useState(false);

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
          toast.error('Profile not found on selected network');
          navigate(`/?network=${resolvedNetwork.id}`);
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to load profile:', err);
          toast.error('Failed to load profile');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    loadExistingProfile();
    return () => { cancelled = true; };
  }, [isEdit, id, resolvedNetwork]);

  const network = resolvedNetwork;
  const domains = network?.domains ?? [];

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
        toast.error('No active profile schema available for import');
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
        toast.success('Profile updated!');
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

        const result = await createItem(createPayload);
        toast.success('Profile created!', { description: `ID: ${result.item_id}` });
      }

      navigate(`/?network=${resolvedNetwork?.id ?? ''}`);
    } catch (err: unknown) {
      console.error('Failed to save profile:', err);

      const axiosError = err as { response?: { status?: number; data?: { error?: string; message?: string } } };
      const status = axiosError?.response?.status;
      const error = axiosError?.response?.data;

      if (status === 403 && error?.error === 'UNSERVED_DOMAIN_BINDING') {
        toast.error('Domain not served by this API instance', {
          description: error.message,
        });
      } else if (status === 401) {
        const redirectTo = `${location.pathname}${location.search}`;
        toast.error('Please sign in to continue', {
          description: 'Your session has expired or you are not signed in.',
        });
        navigate(`/auth/login?redirect=${encodeURIComponent(redirectTo)}`);
      } else if (status === 409) {
        toast.error('Profile already exists', {
          description: 'A profile with this combination already exists',
        });
      } else {
        toast.error(isEdit ? 'Failed to update profile' : 'Failed to create profile', {
          description: error?.message ?? 'Something went wrong',
        });
      }
    } finally {
      setIsSubmitting(false);
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
      <div className="min-h-screen bg-background p-4 sm:p-6">
        <div className="mx-auto max-w-2xl">
          <Button
            variant="ghost"
            className="mb-4 gap-2"
            onClick={() => navigate(`/?network=${targetNetworkId}`)}
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <div className="mb-6">
            <h1 className="text-2xl font-bold">Create Profile</h1>
            <p className="text-muted-foreground mt-1">
              Choose your role on the network
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {domains.map((domain) => {
              const Icon = domainIcons[domain.id] ?? GraduationCap;
              return (
                <Card
                  key={domain.id}
                  className="cursor-pointer hover:shadow-md transition-shadow"
                  onClick={() => setSelectedDomain(domain.id)}
                >
                  <CardHeader>
                    <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                      <Icon className="h-5 w-5 text-primary" />
                    </div>
                    <CardTitle className="text-lg capitalize">
                      {domain.id.replace(/_/g, ' ')}
                    </CardTitle>
                    <CardDescription>{domain.description}</CardDescription>
                  </CardHeader>
                </Card>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-4 sm:p-6">
      <div className="mx-auto max-w-2xl">
        <Button
          variant="ghost"
          className="mb-4 gap-2"
          onClick={() => (selectedDomain && !isEdit ? setSelectedDomain(null) : navigate(`/?network=${resolvedNetwork?.id ?? ''}`))}
        >
          <ArrowLeft className="h-4 w-4" />
          {selectedDomain && !isEdit ? 'Choose different role' : 'Back'}
        </Button>
        <Card>
          <CardHeader>
            <CardTitle>
              {isEdit ? 'Edit Profile' : `Create ${selectedDomainInfo?.description ?? 'Profile'}`}
            </CardTitle>
            <CardDescription>
              {selectedDomainInfo?.description ?? 'Fill in your profile details'}
            </CardDescription>
            {canImportCredentials ? (
              <div>
                <Button variant="outline" className="mt-2" onClick={() => setIsWalletModalOpen(true)}>
                  <Wallet className="h-4 w-4" />
                  Import Credentials
                </Button>
              </div>
            ) : null}
          </CardHeader>
          <CardContent>
            {profileSchema && (
              <SchemaForm
                schema={profileSchema}
                onSubmit={handleSubmit}
                disabled={isSubmitting}
                formData={initialData ?? undefined}
                submitButtonText={isEdit ? 'Update' : undefined}
              />
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
