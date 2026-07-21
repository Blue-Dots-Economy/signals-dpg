import * as React from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Wallet, OctagonX } from 'lucide-react';
import type { RJSFSchema } from '@rjsf/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { SchemaForm } from '@/components/forms/schema-form';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { AuthShell } from '@/components/layout/auth-shell';
import { NetworkConstellation } from '@/components/layout/network-constellation';
import { RoleCard } from '@/components/cards/role-card';
import { useNetworkTheme } from '@/theme/theme-provider';
import { useConsentConfig } from '@/hooks/use-consent-config';
import { ConsentCheckbox } from '@/components/actions/consent-checkbox';
import { WalletImportModal } from '@/components/wallet/wallet-import-modal';
import { resolveNetworkRefs } from '@/engine/schema/resolve-schema';
import type { DotNetworkSchema } from '@/engine/types';
import { getConfiguredWalletProviders } from '@/engine/wallet/wallet-registry';
import type { WalletImportResult } from '@/engine/wallet/types';
import { useAuth } from '@/contexts/auth-context';
import { mergeImportedDataIntoSchema } from '@/lib/import-mapping';
import { getServedScope } from '@/lib/served-binding';
import { getStoredSignupDomain, clearStoredSignupDomain } from '@/lib/signup-domain';
import { getUserDomains } from '@/lib/user-api';
import { isGuardianConsentRequiredDomain } from '@/lib/guardian-consent';
import { GuardianOtpDialog } from '@/components/actions/guardian-otp-dialog';
import { U18GuardianFlow } from '@/components/consent/u18/u18-guardian-flow';
import {
  getU18Status,
  issueProfilePrecreateOtp,
  verifyProfilePrecreateOtp,
  finalizeProfileConsent,
} from '@/lib/consent-api';
import axios from 'axios';

import {
  createItem,
  fetchItems,
  updateItem,
  type CreateItemPayload,
  type UpdateItemPayload,
  type Item,
} from '@/lib/item-api';
import { fetchNetworkConfig, fetchNetworkConfigs } from '@/lib/network-api';
import { parseLocationFields, buildLocationQueries } from '@dpg/schemas/location_fields';
import { getGeoProvider } from '@/lib/geo/provider';
import type { GeoComponents } from '@/lib/geo/types';
import { apiConfig } from '@/lib/api-config';

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
  const { user, signOut } = useAuth();
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
  const [resolvedNetwork, setResolvedNetwork] = React.useState<DotNetworkSchema | null>(null);
  const [existingItem, setExistingItem] = React.useState<Item | null>(null);
  const [initialData, setInitialData] = React.useState<Record<string, unknown> | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(isEdit);
  const [availableNetworkIds, setAvailableNetworkIds] = React.useState<string[] | null>(null);
  const [isWalletModalOpen, setIsWalletModalOpen] = React.useState(false);
  const [formError, setFormError] = React.useState<{ title: string; description?: string } | null>(null);
  const [resolvedLocations, setResolvedLocations] = React.useState<
    Array<{ lat: number; lng: number; label?: string; components?: GeoComponents }>
  >([]);
  const [formValid, setFormValid] = React.useState(false);
  const [consentChecked, setConsentChecked] = React.useState(false);

  // U18 guardian gate, run at the consent tick (BEFORE the profile is created,
  // like the self-signup materialize-after-verify flow). Null until the stored
  // status loads; a minor must have their guardian OTP-verify a pre-create
  // token before "Create profile" is allowed.
  const [u18IsMinor, setU18IsMinor] = React.useState<boolean | null>(null);
  // Interstitial shown at the consent tick BEFORE any OTP is sent, so a minor
  // is told what's about to happen (a code goes to their guardian).
  const [guardianConfirmOpen, setGuardianConfirmOpen] = React.useState(false);
  const [guardianOtpOpen, setGuardianOtpOpen] = React.useState(false);
  const [guardianSetupOpen, setGuardianSetupOpen] = React.useState(false);
  const [guardianVerifiedForCreate, setGuardianVerifiedForCreate] = React.useState(false);

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
    if (servedScope?.network) return servedScope.network;
    if (availableNetworkIds === null) return null;
    if (networkFromUrl && availableNetworkIds.includes(networkFromUrl)) {
      return networkFromUrl;
    }
    return availableNetworkIds[0] ?? null;
  }, [servedScope?.network, availableNetworkIds, networkFromUrl]);

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
          toast.error(t('home.toast_profile_not_found'), {
            description: t('profile.toast_not_found_desc'),
          });
          navigate(`/?network=${resolvedNetwork.id}`);
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to load profile:', err);
          toast.error(t('profile.toast_load_error'), {
            description: t('profile.toast_load_error_desc'),
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
  const domains = network?.domains ?? [];

  // The user's role(s), persisted on `user.domains` — the single source of
  // truth for which domain they may create profiles in (set at signup /
  // bootstrapped on first create; backfilled for existing users). One entry
  // today = single role; the server enforces the same set (create_item's
  // DOMAIN_LOCKED guard reads user.domains too), so the picker and the server
  // can't disagree. Empty → fall back to the served set.
  const [userDomains, setUserDomainsState] = React.useState<string[]>([]);
  React.useEffect(() => {
    if (isEdit || !user) return;
    let cancelled = false;
    getUserDomains()
      .then((d) => { if (!cancelled) setUserDomainsState(d); })
      .catch(() => { if (!cancelled) setUserDomainsState([]); });
    return () => { cancelled = true; };
  }, [isEdit, user]);

  // Domains offered in the picker: the served set (when a scope is configured),
  // then narrowed to the user's persisted role(s).
  const selectableDomains = React.useMemo(() => {
    let list = servedScope
      ? domains.filter((d) => servedScope.domains.includes(d.id))
      : domains;
    if (userDomains.length > 0) list = list.filter((d) => userDomains.includes(d.id));
    return list;
  }, [domains, servedScope, userDomains]);

  // Single-role users skip the picker — the one selectable domain is chosen for
  // them (covers both the stored-role case and a single served domain).
  const roleLocked = selectableDomains.length <= 1;
  React.useEffect(() => {
    if (isEdit || selectedDomain || selectableDomains.length !== 1) return;
    setSelectedDomain(selectableDomains[0].id);
  }, [isEdit, selectedDomain, selectableDomains]);

  // Domain confirmed at Signals self-signup (see pages/auth/login-page.tsx +
  // otp-page.tsx): a brand-new user who hasn't created any profile yet, so
  // without this they'd be asked to pick a domain a second time. One-shot:
  // cleared once consumed so it never leaks into a later, unrelated
  // profile-creation flow.
  React.useEffect(() => {
    // Wait for the network's domain list to actually load before consuming —
    // otherwise an empty `domains` on the first render (network still
    // fetching) would fail the validity check below and clear the stored
    // value before it ever got a chance to apply.
    if (isEdit || selectedDomain || !targetNetworkId || domains.length === 0) return;
    const stored = getStoredSignupDomain(targetNetworkId);
    if (!stored) return;
    clearStoredSignupDomain(targetNetworkId);
    if (domains.some((d) => d.id === stored)) {
      setSelectedDomain(stored);
    }
  }, [isEdit, selectedDomain, targetNetworkId, domains]);

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
  // The profile_creation consent tick only applies when the selected domain
  // gates go-live on `consent_required` (mirrors `go_live_required` in
  // network.json). A domain that goes live on completeness alone (e.g. a
  // provider configured `["schema_required"]`) shows no consent step. Absent
  // config ⇒ require (safe default, matches the login/create-enforcement gates).
  const selectedDomainGates = network?.domains.find(
    (d) => d.id === selectedDomain,
  )?.go_live_required;
  const domainNeedsConsent = selectedDomainGates
    ? selectedDomainGates.includes('consent_required')
    : true;
  const consentRequired = !isEdit && !!statement && domainNeedsConsent;

  // Stored U18 status: whether THIS ward is a minor. Fetched in create mode so
  // the consent tick can route a minor through guardian verification before the
  // profile row is ever written. Adults / edit mode are unaffected.
  React.useEffect(() => {
    if (isEdit || !user || !network) { setU18IsMinor(null); return; }
    let cancelled = false;
    getU18Status(network.id)
      .then((s) => { if (!cancelled) setU18IsMinor(s.isMinor); })
      // On failure leave it null — the server re-checks on finalize, so a
      // transient error can't let a minor create a live profile ungated.
      .catch(() => { if (!cancelled) setU18IsMinor(null); });
    return () => { cancelled = true; };
  }, [isEdit, user, network]);

  // A minor creating a profile on a guardian-gated domain: the consent tick
  // triggers guardian OTP; "Create profile" stays blocked until it's verified.
  const minorGatedCreate = Boolean(
    !isEdit && u18IsMinor === true && network && selectedDomain &&
    isGuardianConsentRequiredDomain(network, selectedDomain),
  );

  // Re-arm the guardian gate whenever the target domain changes.
  React.useEffect(() => {
    setGuardianVerifiedForCreate(false);
    setGuardianOtpOpen(false);
    setGuardianSetupOpen(false);
  }, [selectedDomain]);

  const precreateRef = React.useCallback(
    () => ({
      network: network?.id ?? '',
      brand: brand === 'standard' ? null : brand,
      item_domain: selectedDomain ?? '',
    }),
    [network?.id, brand, selectedDomain],
  );

  // Issue the pre-create guardian OTP and open the OTP dialog. If no guardian is
  // on file yet (409 GUARDIAN_REQUIRED), run the capture flow first, then retry.
  const beginGuardianPrecreate = React.useCallback(async () => {
    try {
      const { otpSent } = await issueProfilePrecreateOtp(precreateRef());
      if (otpSent) setGuardianOtpOpen(true);
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const code = axios.isAxiosError(err)
        ? (err.response?.data as { error?: string } | undefined)?.error
        : undefined;
      if (status === 409 && code === 'GUARDIAN_REQUIRED') {
        setGuardianSetupOpen(true);
      } else if (status === 429) {
        toast.error(t('u18.guardian_error_rate_limited', 'Too many attempts. Please try again shortly.'));
      } else if (status === 503) {
        toast.error(t('u18.guardian_error_otp_unavailable', "Guardian confirmation isn't available on this instance right now."));
      } else {
        toast.error(t('profile.error_generic_desc'));
      }
    }
  }, [precreateRef, t]);

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

        const created = await createItem(createPayload);
        // Minor on a gated domain: the guardian already OTP-verified a
        // pre-create token at the consent tick. Consume it now to record the
        // GUARDIAN profile_creation consent and promote the fresh item to live
        // (the create above wrote a draft with source='profile').
        if (minorGatedCreate) {
          await finalizeProfileConsent({
            network: network.id,
            brand: brand === 'standard' ? null : brand,
            item_domain: selectedDomain,
            item_type: defaultItemType ?? 'profile',
            item_id: created.item_id,
          });
        }
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

  if (availableNetworkIds === null || isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-muted-foreground">
          {isLoading ? t('profile.loading_profile') : t('profile.loading_schemas')}
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
              onClick={() => (selectedDomain && !isEdit && !roleLocked && !singleServedDomain ? setSelectedDomain(null) : navigate(`/?network=${resolvedNetwork?.id ?? ''}`))}
              className="flex items-center gap-1.5 text-sm text-white/70 hover:text-white transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              {selectedDomain && !isEdit && !roleLocked && !singleServedDomain ? t('profile.choose_different_role') : t('common.back')}
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
                      // For a minor on a gated domain, ticking the consent is the
                      // trigger: it fires the guardian OTP BEFORE the profile is
                      // created (no draft is written until "Create profile").
                      onCheckedChange={(v) => {
                        setConsentChecked(v);
                        // Don't fire the OTP straight away — show the "you're
                        // under 18, a code goes to your guardian" interstitial
                        // first, then issue on confirm.
                        if (v && minorGatedCreate && !guardianVerifiedForCreate) {
                          setGuardianConfirmOpen(true);
                        }
                      }}
                    />
                  )
                )}
                {minorGatedCreate && consentChecked && (
                  <p className="text-sm text-muted-foreground">
                    {guardianVerifiedForCreate
                      ? t('u18.guardian_verified_for_create', 'Guardian verified. You can now create your profile.')
                      : t('u18.guardian_pending_for_create', "You're under 18 — your guardian must verify with a one-time code before you can create this profile.")}
                  </p>
                )}
                <button
                  type="submit"
                  form="profile-form"
                  disabled={
                    !formValid ||
                    (!isEdit && consentLoading) ||
                    (consentRequired && !consentChecked) ||
                    (minorGatedCreate && !guardianVerifiedForCreate)
                  }
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

        {/* Interstitial: tell the minor what's about to happen before any code
            is sent. Confirming issues the guardian OTP. */}
        <Dialog
          open={guardianConfirmOpen}
          onOpenChange={(open) => {
            if (open) return;
            setGuardianConfirmOpen(false);
            // Backed out → untick so re-ticking re-opens this notice.
            if (!guardianVerifiedForCreate) setConsentChecked(false);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {t('profile.guardian_confirm_title', 'Guardian confirmation needed')}
              </DialogTitle>
              <DialogDescription>
                {t(
                  'profile.guardian_confirm_desc',
                  "You're under 18, so a one-time code will be sent to your guardian. Once they verify it, you can create your profile.",
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setGuardianConfirmOpen(false);
                  setConsentChecked(false);
                }}
              >
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                onClick={() => {
                  setGuardianConfirmOpen(false);
                  void beginGuardianPrecreate();
                }}
              >
                {t('profile.guardian_confirm_proceed', 'Send code to guardian')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Pre-create guardian OTP: verified BEFORE the profile row is written. */}
        <GuardianOtpDialog
          open={guardianOtpOpen}
          onOpenChange={(open) => {
            if (open) return;
            setGuardianOtpOpen(false);
            // Closed without verifying → untick consent so re-ticking re-issues
            // the OTP (otherwise the create button stays stuck-disabled).
            if (!guardianVerifiedForCreate) setConsentChecked(false);
          }}
          onLogout={() => { void signOut(); }}
          onSubmitOtp={async (otp) => {
            // Throws on an invalid/expired code → the dialog shows the inline
            // error and stays open for a retry.
            await verifyProfilePrecreateOtp({ ...precreateRef(), otp });
            setGuardianVerifiedForCreate(true);
            setGuardianOtpOpen(false);
          }}
        />

        {/* No guardian on file yet → capture (details + setup OTP), then retry. */}
        {guardianSetupOpen && network && selectedDomain && (
          <U18GuardianFlow
            network={network.id}
            brand={brand === 'standard' ? null : brand}
            initialStep="guardian"
            onComplete={() => {
              setGuardianSetupOpen(false);
              void beginGuardianPrecreate();
            }}
            onNotMinor={() => { setGuardianSetupOpen(false); }}
            onLogout={() => { void signOut(); }}
          />
        )}
      </div>
    </div>
  );
}
