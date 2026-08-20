import * as React from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { Wallet, OctagonX } from 'lucide-react';
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
import { PageShell } from '@/components/layout/page-shell';
import { NetworkConstellation } from '@/components/layout/network-constellation';
import { useMyItems } from '@/hooks/use-my-items';
import { getStoredActiveProfileId, setStoredActiveProfileId } from '@/lib/active-profile';
import type { DotNetworkSchema } from '@/engine/types';
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
import { useEditItem } from '@/hooks/use-edit-item';
import { queryKeys } from '@/lib/query-keys';
import { getStoredSignupDomain, clearStoredSignupDomain } from '@/lib/signup-domain';
import { getUserDomains } from '@/lib/user-api';
import { isGuardianConsentRequiredDomain } from '@/lib/guardian-consent';
import { GuardianOtpDialog } from '@/components/actions/guardian-otp-dialog';
import { U18GuardianFlow } from '@/components/consent/u18/u18-guardian-flow';
import { useProfileConsentAccept } from '@/hooks/use-profile-consent-accept';
import {
  getU18Status,
  issueProfilePrecreateOtp,
  verifyProfilePrecreateOtp,
  finalizeProfileConsent,
} from '@/lib/consent-api';
import axios from 'axios';

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

import { getDomainIcon, formatDomainLabel } from '@/lib/domain-icons';

export function ProfileFormPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const { user, signOut } = useAuth();
  const queryClient = useQueryClient();
  const { theme, brand } = useNetworkTheme();
  const { config: consentConfig, isLoading: consentLoading } = useConsentConfig();
  // Shared profile_creation-consent accept flow (adult self-accept OR minor
  // guardian-OTP). Used by the EDIT-of-draft submit path below; `dialogs` is
  // rendered once in the tree. Create keeps its own pre-create guardian flow.
  const { accept: acceptProfileConsentFlow, dialogs: consentAcceptDialogs } =
    useProfileConsentAccept();
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
  // Lifecycle controls (pause/resume/retire, #346/#347) live on the "My
  // Profiles" sidebar rows now — NOT in this editor — so no pause UI state here.
  // `isLoading`/`availableNetworkIds` come from React Query (#295) below.
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

  // Consent config derivations. `profile_creation` consent is captured on CREATE
  // and now also when EDITing a still-draft profile (which promotes it to live).
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

  // Has THIS draft already recorded profile_creation consent? The home-page
  // consent gate populates this set; read it (a plain cache read, no
  // subscription) so re-opening an already-consented draft doesn't re-prompt.
  const alreadyConsented = network
    ? queryClient.getQueryData<Set<string>>(queryKeys.profileConsent(network.id))
    : undefined;

  // Create, or editing a not-yet-live (draft) profile. A live profile edit never
  // re-captures consent.
  const isDraft = !isEdit || editItem.data?.lifecycle_status === 'draft';
  // Consent is needed when a statement is configured, we're on the draft path,
  // and this specific item hasn't already consented. For create (existingItem
  // null) this reduces to `!!statement`, matching the old `consentRequired`.
  const needsConsent =
    !!statement && isDraft && !(existingItem && alreadyConsented?.has(existingItem.item_id));

  // Stored U18 status: whether THIS ward is a minor. Fetched whenever consent
  // may be captured — create, OR editing a still-draft profile — so the accept
  // flow routes a minor through guardian verification. A live edit (no consent)
  // leaves it null.
  React.useEffect(() => {
    if (!isDraft || !user || !network) { setU18IsMinor(null); return; }
    let cancelled = false;
    getU18Status(network.id)
      .then((s) => { if (!cancelled) setU18IsMinor(s.isMinor); })
      // On failure leave it null — the server re-checks on finalize, so a
      // transient error can't let a minor create a live profile ungated.
      .catch(() => { if (!cancelled) setU18IsMinor(null); });
    return () => { cancelled = true; };
  }, [isDraft, user, network]);

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
  const roleLabel = formatDomainLabel(selectedDomain, domains);
  // #376: the "why complete your profile" prompt — shown when creating, or when
  // completing a still-draft profile (not when editing an already-live one).
  const showCompletionPrompt = !isEdit || editItem.data?.lifecycle_status === 'draft';
  const completionPrompt = selectedDomainInfo?.profile_completion_prompt;

  // ── App-shell sidebar props ──────────────────────────────────────────────
  // The form now renders inside the main app shell (PageShell), so it feeds the
  // same sidebar (networks / domains / "My Profiles") home-page does. Selecting
  // anything in the sidebar navigates back to home — this page only edits the
  // one profile it's opened for.
  const allNetworks = React.useMemo<DotNetworkSchema[]>(() => {
    if (!networksData) return [];
    return configuredNetworkIds.length > 0
      ? networksData.filter((n) => configuredNetworkIds.includes(n.id))
      : networksData;
  }, [networksData, configuredNetworkIds]);
  const showNetworkSelector = !servedScope && allNetworks.length > 1;
  const { data: myItems } = useMyItems(network ?? null);
  const activeProfileId = getStoredActiveProfileId(network?.id ?? '');
  const userSchemas = React.useMemo<Record<string, RJSFSchema>>(() => {
    if (!network) return {};
    const map: Record<string, RJSFSchema> = {};
    for (const domain of network.domains) {
      const schema = domain.item_schemas ? Object.values(domain.item_schemas)[0] : undefined;
      if (schema) map[domain.id] = schema;
    }
    return map;
  }, [network]);

  // Back / Cancel: in a multi-role create flow, step back to the role picker;
  // otherwise leave the form for home (mirrors the pre-shell back nav).
  const handleBack = React.useCallback(() => {
    if (selectedDomain && !isEdit && !roleLocked && !singleServedDomain) {
      setSelectedDomain(null);
    } else {
      navigate(`/?network=${resolvedNetwork?.id ?? ''}`);
    }
  }, [selectedDomain, isEdit, roleLocked, singleServedDomain, navigate, resolvedNetwork?.id]);

  const handleSidebarNetworkSelect = React.useCallback(
    (networkId: string) => navigate(`/?network=${networkId}`),
    [navigate],
  );
  const handleSidebarDomainSelect = React.useCallback(
    (domainId: string | null) =>
      navigate(
        domainId
          ? `/?network=${resolvedNetwork?.id ?? ''}&domain=${domainId}`
          : `/?network=${resolvedNetwork?.id ?? ''}`,
      ),
    [navigate, resolvedNetwork?.id],
  );
  const handleSidebarProfileChange = React.useCallback(
    (profileId: string) => {
      if (network?.id) setStoredActiveProfileId(network.id, profileId);
      navigate(`/?network=${resolvedNetwork?.id ?? ''}`);
    },
    [network?.id, navigate, resolvedNetwork?.id],
  );
  const handleProfilesChanged = React.useCallback(() => {
    if (network) queryClient.invalidateQueries({ queryKey: queryKeys.myItems(network.id) });
  }, [network, queryClient]);

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
        // Bust the by-id caches for THIS item, else re-opening the editor within
        // the 60s own-data window seeds the form from the pre-edit copy — and the
        // seed-once guard then pins that stale value so the background refetch
        // can't correct it. removeQueries (not invalidate) for editItem so the
        // next open has no stale copy to seed from and refetches fresh via the
        // same masked read path; itemDetail (marker click-through / detail popup)
        // can just be invalidated.
        queryClient.removeQueries({
          queryKey: queryKeys.editItem(network.id, existingItem.item_id),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.itemDetail(network.id, existingItem.item_id),
        });

        // Refresh the browse / my-items lists (§C5). IMPORTANT: when a draft is
        // about to be promoted to live via consent below, do NOT invalidate
        // my-items here — that kicks off a refetch of the still-`draft` status
        // that wins the race and leaves the sidebar showing "Draft" even though
        // the profile is live server-side. Invalidate only AFTER the promotion
        // (in the accept flow's onDone). This mirrors the create path.
        const refreshLists = () => {
          queryClient.invalidateQueries({ queryKey: queryKeys.myItems(network.id) });
          queryClient.invalidateQueries({ queryKey: ['browse-items', network.id] });
        };

        // Editing a still-draft profile with a configured statement: record
        // profile_creation consent, which promotes the draft to live. For an
        // adult this resolves synchronously → `onDone`; for a minor on a gated
        // domain the hook opens the guardian-OTP flow and `onDone` runs only
        // after OTP success. Either way the list refresh + navigation are
        // deferred to `onDone`, so we return here rather than falling through.
        if (needsConsent && profileDoc) {
          await acceptProfileConsentFlow({
            network: network.id,
            brand: brand === 'standard' ? null : brand,
            item: {
              item_id: existingItem.item_id,
              item_domain: selectedDomain,
              item_type: existingItem.item_type,
            },
            version: profileDoc.current_version,
            isMinor: u18IsMinor === true,
            // The guardian flow may reclassify the ward as an adult (or capture a
            // guardian); re-sync U18 status so a not-minor outcome doesn't
            // dead-end and a retry runs with the corrected status.
            onGuardianStatusChanged: () => {
              getU18Status(network.id)
                .then((s) => setU18IsMinor(s.isMinor))
                .catch(() => setU18IsMinor(null));
            },
            onDone: () => {
              refreshLists();
              navigate(`/?network=${resolvedNetwork?.id ?? ''}`);
            },
          });
          return;
        }

        // Plain edit (already live / no statement configured): reflect the field
        // edits in the lists now.
        refreshLists();
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
        // Make the freshly-created profile the active one so the home sidebar
        // selects it (and the discover list anchors to it) instead of keeping
        // the previously-stored profile. Home reads this on load.
        setStoredActiveProfileId(network.id, created.item_id);
        // NOTE: my-items / browse-items invalidation runs AFTER
        // finalizeProfileConsent below — NOT here. A minor's item is created
        // `draft` and only flips to `live` in finalize; invalidating here would
        // refetch the still-draft status and leave the sidebar showing "Draft".
        if (consentRequired && profileDoc) {
          // This create recorded profile_creation consent. Optimistically add
          // the new item to the profileConsent cache so returning to home sees
          // it as consented IMMEDIATELY. A plain invalidate is not enough: the
          // profileConsent query is stale-while-revalidate, so the home gate
          // would read the old set (without this profile) during the refetch
          // window and spuriously re-prompt. Mirrors the accept handler's
          // setQueryData approach.
          queryClient.setQueryData<Set<string>>(
            queryKeys.profileConsent(network.id),
            (prev) => new Set([...(prev ?? []), created.item_id]),
          );
        }
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
        // Reflect the write in cached lists (§C5) — invalidate AFTER the minor
        // promotion above, not right after createItem. A minor's item is created
        // `draft` and only flips to `live` in finalizeProfileConsent; invalidating
        // before that made my-items refetch the still-`draft` status, so the
        // sidebar showed "Draft" until the next interaction even though the
        // profile was live server-side.
        queryClient.invalidateQueries({ queryKey: queryKeys.myItems(network.id) });
        // Network-level prefix of the browse-items key (React Query matches
        // prefixes) — invalidates every domain's browse cache for this network.
        queryClient.invalidateQueries({ queryKey: ['browse-items', network.id] });
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
      <div className="flex h-svh items-center justify-center">
        <p className="text-muted-foreground">
          {editLoading ? t('profile.loading_profile') : t('profile.loading_schemas')}
        </p>
      </div>
    );
  }

  if (!targetNetworkId) {
    return (
      <div className="flex h-svh items-center justify-center">
        <p className="text-muted-foreground">{t('profile.no_networks')}</p>
      </div>
    );
  }

  if (!network) {
    return (
      <div className="flex h-svh items-center justify-center">
        <p className="text-muted-foreground">{t('profile.loading_schemas')}</p>
      </div>
    );
  }

  // Shared sidebar wiring for both the role-picker and the form itself — the
  // page lives inside the main app shell now (Task 3), so the sidebar mirrors
  // home-page's; every selection navigates back to home.
  const shellSidebarProps = {
    networks: showNetworkSelector ? allNetworks : [],
    selectedNetwork: targetNetworkId,
    onNetworkSelect: handleSidebarNetworkSelect,
    domains,
    selectedDomain: null as string | null,
    onDomainSelect: handleSidebarDomainSelect,
    myItems,
    activeProfileId,
    onActiveProfileChange: handleSidebarProfileChange,
    onProfilesChanged: handleProfilesChanged,
    userSchemas,
    // On a create/edit form there is nothing to browse — hide the Browse
    // (domain selector) group, and label the return control "Browse" (it goes
    // to the browse view, not the prior route).
    hideBrowse: true,
    backLabel: t('nav.browse_group'),
  };

  // Domain selection step
  if (!selectedDomain && !isEdit) {
    return (
      <PageShell
        variant="form"
        title={t('profile.create_heading')}
        onBack={handleBack}
        {...shellSidebarProps}
      >
        <div className="mx-auto max-w-[1040px] pb-24">
          <div className="mb-6">
            <p className="mb-2 inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">
              {theme.portalLabel}
            </p>
            <p className="text-muted-foreground mt-1">{t('profile.choose_role')}</p>
            <p className="text-sm text-muted-foreground/80 mt-2">{theme.subline}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {selectableDomains.map((domain, idx) => {
              const Icon = getDomainIcon(domain.id, network?.id);
              const label = formatDomainLabel(domain.id, [domain]);
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
        </div>
      </PageShell>
    );
  }

  // When consent is being captured (create, or promoting a draft) the primary
  // action publishes; otherwise it's a plain create/update.
  const editPrimaryLabel = isEdit ? t('profile.btn_update') : t('profile.btn_create');
  const primaryLabel = needsConsent
    ? t('profile.btn_save_publish')
    : editPrimaryLabel;
  const submitDisabled = isEdit
    ? // Live edit: unchanged (formValid only). Draft-with-consent: wait for the
      // consent config to load, then require the acknowledgement tick.
      !formValid || (isDraft && consentLoading) || (needsConsent && !consentChecked)
    : !formValid ||
      consentLoading ||
      (needsConsent && !consentChecked) ||
      (minorGatedCreate && !guardianVerifiedForCreate);

  // Action bar rendered as PageShell's pinned footer (below the scroll area, via
  // footerSlot) — NOT a sticky element inside the scroll, which floated
  // mid-content when the form was short and produced a second scrollbar. The
  // submit is `type=submit form=profile-form`, so it still drives the (hidden-
  // submit) SchemaForm even though it now lives outside the form's DOM subtree.
  const actionBar = (
    <div data-testid="profile-action-bar" className="mx-auto max-w-[1040px] space-y-3 px-4 py-3 sm:px-6">
      {/* Consent gets its OWN full-width row above the buttons — the
          ConsentCheckbox is a bordered block, so cramming it into the horizontal
          button cluster wrapped and broke the bar (esp. with the minor status
          line). Shown for CREATE and EDIT-of-draft (the `needsConsent` path). The
          minor pre-create interstitial is create-only; an edit-of-draft minor is
          routed through the guardian flow by the accept hook. */}
      {formValid && needsConsent && (
        <div className="space-y-2">
          <ConsentCheckbox
            text={statement}
            checked={consentChecked}
            onCheckedChange={(v) => {
              setConsentChecked(v);
              if (v && minorGatedCreate && !guardianVerifiedForCreate) {
                setGuardianConfirmOpen(true);
              }
            }}
          />
          {!isEdit && minorGatedCreate && consentChecked && (
            <p className="text-sm text-muted-foreground">
              {guardianVerifiedForCreate
                ? t('u18.guardian_verified_for_create', 'Guardian verified. You can now create your profile.')
                : t('u18.guardian_pending_for_create', "You're under 18 — your guardian must verify with a one-time code before you can create this profile.")}
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-sm">
          {formValid ? (
            <span className="text-emerald-600">{t('profile.required_complete')}</span>
          ) : (
            <span className="text-amber-700">{t('profile.fill_required_hint')}</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" onClick={handleBack}>
            {t('common.cancel')}
          </Button>
          <button
            type="submit"
            form="profile-form"
            disabled={submitDisabled}
            className="h-11 rounded-md bg-brand-cta px-5 font-semibold text-white disabled:opacity-50"
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <PageShell
      variant="form"
      // No app-bar title here: the branded hero strip below already shows the
      // role heading, so a title in the bar would duplicate it. (The role-picker
      // step above keeps its bar title — it has no hero.)
      onBack={handleBack}
      footerSlot={actionBar}
      {...shellSidebarProps}
    >
      <div className="mx-auto max-w-[1040px]">
        {/* Branded hero strip — sits flush above the form Card. This hero heading
            is the page's <h1> now (the app-bar title was dropped to avoid
            duplicating it). Uses the network's primary brand color. */}
        <div className="relative overflow-hidden rounded-t-xl bg-primary">
          <div className="pointer-events-none absolute inset-0 opacity-15">
            <NetworkConstellation className="h-full w-full" />
          </div>
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-black/50 via-black/20 to-transparent" />
          <div className="relative z-10 flex items-center gap-4 px-5 pb-6 pt-6 sm:px-6">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-white/20 backdrop-blur-sm ring-1 ring-white/20">
              <DomainIcon className="h-6 w-6 text-white" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/50">
                {theme.portalLabel}
              </p>
              <h1 className="text-xl font-bold text-white leading-tight truncate">
                {isEdit ? t('profile.edit_role_heading', { role: roleLabel }) : t('profile.create_role_heading', { role: roleLabel })}
              </h1>
              <p className="mt-0.5 text-xs text-white/70 leading-snug">
                {selectedDomainInfo?.description ?? t('profile.fill_details')}
              </p>
            </div>
          </div>
        </div>

        {/* Form card — connects flush to the hero strip. */}
        <Card className="rounded-t-none border-t-0 shadow-lg">
          <CardContent className="pt-6">
            {/* #376: motivating "why complete your profile" prompt — per-domain
                from network.json (role-specific), with a generic i18n fallback. */}
            {showCompletionPrompt && selectedDomain && (
              <div className="mb-5 rounded-lg border border-brand-cta/30 bg-brand-cta/[0.06] p-4">
                <p className="text-sm font-semibold text-foreground">
                  {completionPrompt?.heading ?? t('profile.completion_prompt_default_heading')}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {completionPrompt?.body ?? t('profile.completion_prompt_default_body')}
                </p>
              </div>
            )}

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
                hideSubmit
                onValidityChange={setFormValid}
                // The page heading is the hero <h1>; render section titles as
                // <h2> so the heading chain (h1 → h2) has no skip.
                sectionHeadingLevel={2}
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
          <DialogContent className="max-h-[90dvh] overflow-y-auto">
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
          purpose={{ kind: 'profile' }}
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
            purpose={{ kind: 'profile' }}
            initialStep="guardian"
            onComplete={() => {
              setGuardianSetupOpen(false);
              void beginGuardianPrecreate();
            }}
            onNotMinor={() => { setGuardianSetupOpen(false); }}
            onLogout={() => { void signOut(); }}
          />
        )}

        {/* Guardian-OTP + capture dialogs for the EDIT-of-draft consent path
            (driven by separate state from the create pre-create flow above). */}
        {consentAcceptDialogs}
      </div>
    </PageShell>
  );
}
