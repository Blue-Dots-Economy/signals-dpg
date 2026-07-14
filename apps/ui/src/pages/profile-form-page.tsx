import * as React from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Wallet, OctagonX } from 'lucide-react';
import type { RJSFSchema } from '@rjsf/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SchemaForm } from '@/components/forms/schema-form';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { AuthShell } from '@/components/layout/auth-shell';
import { NetworkConstellation } from '@/components/layout/network-constellation';
import { RoleCard } from '@/components/cards/role-card';
import { useNetworkTheme } from '@/theme/theme-provider';
import { useConsentConfig } from '@/hooks/use-consent-config';
import { ConsentCheckbox } from '@/components/actions/consent-checkbox';
import { WalletImportModal } from '@/components/wallet/wallet-import-modal';
import { getConfiguredWalletProviders } from '@/engine/wallet/wallet-registry';
import type { WalletImportResult } from '@/engine/wallet/types';
import { useAuth } from '@/contexts/auth-context';
import { mergeImportedDataIntoSchema } from '@/lib/import-mapping';
import { getServedScope } from '@/lib/served-binding';
import { useNetworkConfigs, useResolvedNetwork } from '@/hooks/use-network-config';
import { useMyItems } from '@/hooks/use-my-items';
import { useEditItem } from '@/hooks/use-edit-item';
import { queryKeys } from '@/lib/query-keys';

import {
  createItem,
  updateItem,
  type CreateItemPayload,
  type UpdateItemPayload,
  type Item,
} from '@/lib/item-api';
import { parseLocationFields, buildLocationQueries } from '@dpg/schemas/location_fields';
import { getGeoProvider } from '@/lib/geo/provider';
import type { GeoComponents } from '@/lib/geo/types';

function parseNetworkIds(networkEnv: string | undefined): string[] {
  if (!networkEnv) return [];
  return networkEnv.split(',').map(n => n.trim()).filter(Boolean);
}

import { getDomainIcon } from '@/lib/domain-icons';

export function ProfileFormPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { theme, brand } = useNetworkTheme();
  const { config: consentConfig, isLoading: consentLoading } = useConsentConfig();
  const isEdit = !!id;
  // The domains this deployment serves (VITE_SERVED_BINDINGS), or null = all.
  const servedScope = React.useMemo(() => getServedScope(), []);
  // Exactly one served domain ⇒ no picker; that domain is the form's domain.
  const singleServedDomain =
    servedScope && servedScope.domains.length === 1 ? servedScope.domains[0] : null;

  // With a single served domain, initialise the selected domain to it (create
  // mode) so the role-picker step is skipped entirely — the form renders
  // directly, no intermediate page or flash. With multiple served domains the
  // picker (restricted to the served set) is shown.
  const [selectedDomain, setSelectedDomain] = React.useState<string | null>(
    () => (!isEdit && singleServedDomain ? singleServedDomain : null),
  );
  const [existingItem, setExistingItem] = React.useState<Item | null>(null);
  const [initialData, setInitialData] = React.useState<Record<string, unknown> | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [isWalletModalOpen, setIsWalletModalOpen] = React.useState(false);
  const [formError, setFormError] = React.useState<{ title: string; description?: string } | null>(null);
  const [resolvedLocations, setResolvedLocations] = React.useState<
    Array<{ lat: number; lng: number; label?: string; components?: GeoComponents }>
  >([]);
  const [formValid, setFormValid] = React.useState(false);
  const [consentChecked, setConsentChecked] = React.useState(false);

  // Reset consent checkbox when form becomes invalid
  React.useEffect(() => {
    if (!formValid) setConsentChecked(false);
  }, [formValid]);

  // Clear stale locations whenever the user switches domain so a prior domain's
  // address suggestion is never submitted for a different domain.
  React.useEffect(() => {
    setResolvedLocations([]);
  }, [selectedDomain]);

  // Get network from URL query param, fallback to env config
  const configuredNetworkIds = React.useMemo(
    () => parseNetworkIds(import.meta.env.VITE_NETWORK_ID),
    []
  );
  const networkFromUrl = searchParams.get('network');

  // Networks list (config tier) — discover which network ids are available.
  const {
    data: networksData,
    isError: networksError,
  } = useNetworkConfigs();

  const availableNetworkIds = React.useMemo<string[] | null>(() => {
    if (networksError) return [];
    if (!networksData) return null;
    const filtered =
      configuredNetworkIds.length > 0
        ? networksData.filter((network) => configuredNetworkIds.includes(network.id))
        : networksData;
    return filtered.map((network) => network.id);
  }, [networksData, networksError, configuredNetworkIds]);

  const targetNetworkId = React.useMemo(() => {
    if (servedScope?.network) return servedScope.network;
    if (availableNetworkIds === null) return null;
    if (networkFromUrl && availableNetworkIds.includes(networkFromUrl)) {
      return networkFromUrl;
    }
    return availableNetworkIds[0] ?? null;
  }, [servedScope?.network, availableNetworkIds, networkFromUrl]);

  // Resolved network config (config tier) — fetch + $ref resolution, cached.
  const { data: resolvedNetwork, isError: resolvedNetworkError } = useResolvedNetwork(targetNetworkId);
  const network = resolvedNetwork;
  const domains = network?.domains ?? [];

  // My items across served domains (create mode only) → single-domain lock.
  // Edit mode reads the domain off the existing item, so skip the probe there.
  const { data: myItems } = useMyItems(isEdit ? null : network);

  // Existing profile for edit mode.
  const editItem = useEditItem(network, isEdit ? (id ?? null) : null);

  // Edit-mode loading screen: shown from mount through the networks-list and
  // network-config-resolve phases and while the item itself loads (old
  // `isLoading` was seeded to `isEdit` and cleared only once the item load
  // settled). Goes false when the networks-list fetch or the network resolve
  // errors, so a failure falls through to the terminal "no networks" /
  // "loading schemas" guards exactly as before.
  const editLoading =
    isEdit &&
    !networksError &&
    !resolvedNetworkError &&
    !editItem.isSuccess &&
    !editItem.isError;

  // Seed the edit form from the fetched item; redirect on a genuine miss.
  React.useEffect(() => {
    if (!isEdit) return;
    const item = editItem.data;
    if (item) {
      // Seed once per item — a background refetch of the same item must not
      // clobber the user's in-progress form edits.
      if (existingItem?.item_id === item.item_id) return;
      setExistingItem(item);
      setSelectedDomain(item.item_domain);
      setInitialData(item.item_state);
    } else if (editItem.isSuccess && item === null && !existingItem) {
      toast.error(t('home.toast_profile_not_found'), {
        description: t('profile.toast_not_found_desc'),
      });
      navigate(`/?network=${resolvedNetwork?.id ?? ''}`);
    } else if (editItem.isError && !existingItem) {
      console.error('Failed to load profile:', editItem.error);
      toast.error(t('profile.toast_load_error'), {
        description: t('profile.toast_load_error_desc'),
      });
    }
  }, [
    isEdit,
    editItem.data,
    editItem.isSuccess,
    editItem.isError,
    editItem.error,
    existingItem,
    resolvedNetwork?.id,
    navigate,
    t,
  ]);

  // Domain the user is locked to, or null when they hold no items yet.
  const lockedDomain = React.useMemo(
    () => (myItems.length > 0 ? myItems[0].item_domain : null),
    [myItems],
  );

  // Domains offered in the picker: restricted to the served set (when a scope
  // is configured), then to the locked domain when the user already holds one.
  const selectableDomains = React.useMemo(() => {
    let list = servedScope
      ? domains.filter((d) => servedScope.domains.includes(d.id))
      : domains;
    if (lockedDomain) list = list.filter((d) => d.id === lockedDomain);
    return list;
  }, [domains, servedScope, lockedDomain]);

  // Locked users skip the role picker — auto-select their held domain.
  React.useEffect(() => {
    if (isEdit || selectedDomain || !lockedDomain) return;
    setSelectedDomain(lockedDomain);
  }, [isEdit, selectedDomain, lockedDomain]);

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

  // Consent config derivations — only relevant in create mode.
  const profileDoc = consentConfig?.documents.profile_creation;
  const profileVersion = profileDoc?.versions.find((v) => v.version === profileDoc.current_version);
  const statement = profileVersion?.statement ?? '';
  const consentRequired = !isEdit && !!statement;

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
        toast.error(t('profile.toast_no_schema'), {
          description: t('profile.toast_no_schema_desc'),
        });
        return;
      }

      const { mergedData, mappedCount, skippedKeys } = mergeImportedDataIntoSchema(
        profileSchema,
        initialData,
        result
      );

      if (mappedCount === 0) {
        toast.error(t('profile.toast_import_no_match', { provider: result.providerLabel }));
        return;
      }

      setInitialData(mergedData);

      if (skippedKeys.length > 0) {
        toast.success(t('profile.toast_import_success', { count: mappedCount, provider: result.providerLabel }), {
          description: t('profile.toast_import_skipped', { count: skippedKeys.length }),
        });
        return;
      }

      toast.success(t('profile.toast_import_success', { count: mappedCount, provider: result.providerLabel }), {
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
      // Resolve the coordinates to submit, client-side, using the same (Google)
      // geocoder the autocomplete uses. We send the EXACT point for every field —
      // for a PRIVATE field the server jitters it (100–250 m) before storing, so
      // the exact coordinate is never persisted (see PII location jitter, #243).
      // Resolve from the picked suggestion(s) when available, else the typed text.
      const toPoint = (
        lat: number,
        lng: number,
        label: string | undefined,
      ): { lat: number; lng: number; label?: string } => (label ? { lat, lng, label } : { lat, lng });

      let item_locations: Array<{ lat: number; lng: number; label?: string }> = [];

      if (resolvedLocations.length > 0) {
        // A suggestion was picked in the widget.
        for (const place of resolvedLocations) {
          item_locations.push(toPoint(place.lat, place.lng, place.label));
        }
      } else if (profileSchema) {
        // No suggestion picked — geocode the marked field(s) from the typed text.
        const { primary } = parseLocationFields(profileSchema as Record<string, unknown>);
        const queries = buildLocationQueries(data, primary);
        for (const { query, label } of queries) {
          const [best] = await getGeoProvider().suggest(query);
          if (best) item_locations.push(toPoint(best.lat, best.lng, label));
        }
      }

      if (isEdit && existingItem) {
        // Update existing profile
        const updatePayload: UpdateItemPayload = {
          item_state: data,
        };

        // Only include item_locations when we have computed a non-empty array.
        // When item_locations is empty on edit (e.g. the user never re-selected
        // a suggestion for a private field whose value appears as "***"), omit
        // the field entirely so updateItemInternal preserves the stored coarse
        // coordinate rather than overwriting it with [].
        if (item_locations.length > 0) {
          updatePayload.item_locations = item_locations;
        }

        await updateItem(existingItem.item_id, updatePayload);
        // Reflect the write immediately in cached lists (§C5).
        queryClient.invalidateQueries({ queryKey: queryKeys.myItems(network.id) });
        // Network-level prefix of the browse-items key (React Query matches
        // prefixes) — invalidates every domain's browse cache for this network.
        queryClient.invalidateQueries({ queryKey: ['browse-items', network.id] });
        toast.success(t('profile.toast_updated'), {
          description: t('profile.toast_updated_desc'),
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

        createPayload.item_locations = item_locations;

        if (consentRequired && profileDoc) {
          createPayload.consent = {
            category: 'profile_creation',
            version: profileDoc.current_version,
            brand: brand === 'standard' ? null : brand,
          };
        }

        await createItem(createPayload);
        // Reflect the write immediately in cached lists (§C5).
        queryClient.invalidateQueries({ queryKey: queryKeys.myItems(network.id) });
        // Network-level prefix of the browse-items key (React Query matches
        // prefixes) — invalidates every domain's browse cache for this network.
        queryClient.invalidateQueries({ queryKey: ['browse-items', network.id] });
        // The create payload may record profile_creation consent; refresh the
        // consent-status cache so returning to home doesn't re-prompt the gate.
        queryClient.invalidateQueries({ queryKey: queryKeys.profileConsent(network.id) });
        toast.success(t('profile.toast_created'), {
          description: t('profile.toast_created_desc'),
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
          title: t('profile.error_role_unavailable'),
          description: error?.message ?? t('profile.error_role_unavailable_fallback_desc'),
        });
      } else if (status === 401) {
        const redirectTo = `${location.pathname}${location.search}`;
        toast.error(t('profile.toast_sign_in'), {
          description: t('profile.toast_sign_in_desc'),
        });
        navigate(`/auth/login?redirect=${encodeURIComponent(redirectTo)}`);
      } else if (status === 409) {
        setFormError({
          title: t('profile.error_already_exists'),
          description: t('profile.error_already_exists_desc'),
        });
      } else {
        setFormError({
          title: isEdit ? t('profile.error_update_failed') : t('profile.error_create_failed'),
          description: error?.message ?? t('profile.error_generic_desc'),
        });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (availableNetworkIds === null || editLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-muted-foreground">
          {editLoading ? t('profile.loading_profile') : t('profile.loading_schemas')}
        </p>
      </div>
    );
  }

  if (!targetNetworkId) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-muted-foreground">{t('profile.no_networks')}</p>
      </div>
    );
  }

  if (!network) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-muted-foreground">{t('profile.loading_schemas')}</p>
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
          {t('common.back')}
        </button>
        <div className="mb-6">
          <p className="mb-2 inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">
            {theme.portalLabel}
          </p>
          <h2 className="text-2xl font-bold">{t('profile.create_heading')}</h2>
          <p className="text-muted-foreground mt-1">{t('profile.choose_role')}</p>
          <p className="text-sm text-muted-foreground/80 mt-2">{theme.subline}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {selectableDomains.map((domain, idx) => {
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
              onClick={() => (selectedDomain && !isEdit && !lockedDomain && !singleServedDomain ? setSelectedDomain(null) : navigate(`/?network=${resolvedNetwork?.id ?? ''}`))}
              className="flex items-center gap-1.5 text-sm text-white/70 hover:text-white transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              {selectedDomain && !isEdit && !lockedDomain && !singleServedDomain ? t('profile.choose_different_role') : t('common.back')}
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
                {isEdit ? t('profile.edit_role_heading', { role: roleLabel }) : t('profile.create_role_heading', { role: roleLabel })}
              </h2>
              <p className="mt-0.5 text-xs text-white/70 leading-snug">
                {selectedDomainInfo?.description ?? t('profile.fill_details')}
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
                  {t('profile.import_credentials')}
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
                id="profile-form"
                schema={profileSchema}
                onSubmit={handleSubmit}
                disabled={isSubmitting}
                formData={initialData ?? undefined}
                submitButtonText={isEdit ? t('profile.btn_update') : undefined}
                hideSubmit={!isEdit}
                onValidityChange={!isEdit ? setFormValid : undefined}
                domainId={selectedDomain ?? undefined}
                networkId={network?.id}
                formContext={{
                  onLocationResolved: (
                    place: { lat: number; lng: number; components?: GeoComponents } | null,
                  ) => setResolvedLocations(place ? [place] : []),
                  onLocationsResolved: (coords: Array<{ lat: number; lng: number; label?: string }>) => setResolvedLocations(coords),
                }}
              />
            )}

            {!isEdit && (
              <div className="mt-6 space-y-4">
                {!formValid ? (
                  <div className="flex items-center gap-2.5 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
                    <span
                      aria-hidden="true"
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-400 text-xs font-bold text-white"
                    >
                      !
                    </span>
                    {t('profile.fill_required_hint')}
                  </div>
                ) : (
                  consentRequired && (
                    <ConsentCheckbox
                      text={statement}
                      checked={consentChecked}
                      onCheckedChange={setConsentChecked}
                    />
                  )
                )}
                <button
                  type="submit"
                  form="profile-form"
                  disabled={!formValid || (!isEdit && consentLoading) || (consentRequired && !consentChecked)}
                  className="mt-2 h-12 w-full rounded-md text-base font-semibold bg-brand-cta hover:brightness-110 transition-all active:scale-95 shadow-md text-white disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {t('profile.btn_create')}
                </button>
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
