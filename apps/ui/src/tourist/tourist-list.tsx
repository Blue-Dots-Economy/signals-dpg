import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { RJSFSchema } from '@rjsf/utils';
import type { DotCardConfig } from '@/engine/types';
import type { LatLng } from '@/lib/geo/types';
import { nearestDistanceMeters } from '@/lib/geo/distance';
import { PractitionerCard } from './practitioner-card';
import type { CardItem } from './practitioner-data';

export interface TouristListProps {
  items: CardItem[];
  schema: RJSFSchema | null;
  cardConfig: DotCardConfig | null;
  userLocation: LatLng | null;
}

function getLocations(data: Record<string, unknown>): Array<{ lat: number; lng: number }> {
  const raw = data.item_locations;
  return Array.isArray(raw) ? (raw as Array<{ lat: number; lng: number }>) : [];
}

export function TouristList({ items, schema, cardConfig, userLocation }: TouristListProps) {
  const { t } = useTranslation();

  const sorted = React.useMemo(() => {
    if (!userLocation) return items;
    return [...items].sort(
      (a, b) =>
        nearestDistanceMeters(userLocation, getLocations(a.data)) -
        nearestDistanceMeters(userLocation, getLocations(b.data)),
    );
  }, [items, userLocation]);

  if (sorted.length === 0) {
    return <p className="p-8 text-center text-sm text-muted-foreground">{t('tourist.empty')}</p>;
  }

  return (
    <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
      {sorted.map((item) => (
        <PractitionerCard key={item.id} data={item.data} schema={schema} cardConfig={cardConfig} variant="list" />
      ))}
    </div>
  );
}
