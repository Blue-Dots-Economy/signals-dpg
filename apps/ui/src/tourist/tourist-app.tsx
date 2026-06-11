import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { RJSFSchema } from '@rjsf/utils';
import { fetchNetworkConfig, fetchNetworkItems } from '@/lib/network-api';
import type { Item } from '@/lib/item-api';
import { useBrowserLocation } from '@/hooks/use-browser-location';
import type { LatLng } from '@/lib/geo/types';
import { getEnumFilterFieldsForDomains, itemPassesEnumFilters } from '@/lib/enum-filters';
import { MapFiltersPanel } from '@/components/map/map-filters-panel';
import { Button } from '@/components/ui/button';
import type { ViewMode } from '@/engine/types';
import { TouristTopBar } from './tourist-top-bar';
import { TouristMap } from './tourist-map';
import { TouristList } from './tourist-list';
import { EnableLocationBanner } from './enable-location-banner';
import { itemToCardItem, matchesSearch, type CardItem } from './practitioner-data';

const ORANGE_NETWORK_ID = (import.meta.env.VITE_NETWORK_ID || 'orange_dot').split(',')[0].trim();
const ORANGE_DOMAIN_ID = 'practitioner';
const REGION_DEFAULT_CENTER: [number, number] = [13.3409, 74.7421]; // Udupi
const REGION_DEFAULT_ZOOM = 12;

export function TouristApp() {
  const { t } = useTranslation();
  const [search, setSearch] = React.useState('');
  const [viewMode, setViewMode] = React.useState<ViewMode>('map');
  const [selectedFields, setSelectedFields] = React.useState<Record<string, string[]>>({});

  const browser = useBrowserLocation();

  // No login/profile in the tourist UI — the visitor's location is purely the
  // browser geolocation. Auto-request once on mount (same trigger condition
  // useUserLocation used internally). request() is safe to call outside a user
  // gesture; the browser shows its native permission prompt.
  React.useEffect(() => {
    if (browser.isSupported && browser.status === 'idle') {
      void browser.request();
    }
  }, [browser.isSupported, browser.status, browser.request]);

  const userLocation: LatLng | null = browser.location
    ? { lat: browser.location.lat, lng: browser.location.lng }
    : null;

  const configQuery = useQuery({
    queryKey: ['tourist', 'config', ORANGE_NETWORK_ID],
    queryFn: () => fetchNetworkConfig(ORANGE_NETWORK_ID),
  });

  const network = configQuery.data ?? null;
  const domain = network?.domains.find((d) => d.id === ORANGE_DOMAIN_ID) ?? null;
  const itemType = domain?.item_schemas ? Object.keys(domain.item_schemas)[0] ?? 'profile_1.0' : 'profile_1.0';
  const schema = (domain?.item_schemas?.[itemType] ?? null) as RJSFSchema | null;
  const cardConfig = domain?.card ?? null;

  const itemsQuery = useQuery({
    enabled: !!network,
    queryKey: ['tourist', 'items', ORANGE_NETWORK_ID, ORANGE_DOMAIN_ID, itemType],
    queryFn: ({ signal }) =>
      fetchNetworkItems(
        { item_network: ORANGE_NETWORK_ID, item_domain: ORANGE_DOMAIN_ID, item_type: itemType, limit: 100 },
        signal,
      ),
  });

  const enumFields = React.useMemo(
    () => (domain ? getEnumFilterFieldsForDomains([domain]) : []),
    [domain],
  );

  const cardItems: CardItem[] = React.useMemo(() => {
    const items = (itemsQuery.data?.items ?? []) as Item[];
    return items
      .map(itemToCardItem)
      .filter((c) => matchesSearch(c.data, search))
      .filter((c) => itemPassesEnumFilters(c.data, selectedFields, enumFields));
  }, [itemsQuery.data, search, selectedFields, enumFields]);

  const filtersSlot = React.useMemo(
    () =>
      domain ? (
        <MapFiltersPanel
          domains={[domain]}
          selectedDomains={[]}
          onDomainsChange={() => {}}
          selectedFields={selectedFields}
          onFieldsChange={setSelectedFields}
          viewMode={viewMode}
        />
      ) : null,
    [domain, selectedFields, viewMode],
  );

  const locationDenied = browser.status === 'error' || !browser.isSupported;

  return (
    <div className="flex h-screen flex-col">
      <TouristTopBar
        search={search}
        onSearchChange={setSearch}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        filtersSlot={filtersSlot}
      />
      {locationDenied && <EnableLocationBanner onEnable={() => void browser.request()} />}

      <main className="min-h-0 flex-1 overflow-auto">
        {configQuery.isError || itemsQuery.isError ? (
          <div className="flex flex-col items-center gap-3 p-12 text-center">
            <p className="text-sm text-muted-foreground">{t('tourist.error')}</p>
            <Button variant="outline" size="sm" onClick={() => { void configQuery.refetch(); void itemsQuery.refetch(); }}>
              {t('tourist.retry')}
            </Button>
          </div>
        ) : !network || !schema ? (
          <p className="p-12 text-center text-sm text-muted-foreground">{t('tourist.loading')}</p>
        ) : viewMode === 'map' ? (
          <TouristMap
            items={cardItems}
            schema={schema}
            cardConfig={cardConfig}
            focusPoint={userLocation}
            center={userLocation ? [userLocation.lat, userLocation.lng] : REGION_DEFAULT_CENTER}
            zoom={REGION_DEFAULT_ZOOM}
            filtersSlot={filtersSlot}
          />
        ) : (
          <TouristList items={cardItems} schema={schema} cardConfig={cardConfig} userLocation={userLocation} />
        )}
      </main>
    </div>
  );
}
