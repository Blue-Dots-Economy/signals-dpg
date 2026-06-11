import type { RJSFSchema } from '@rjsf/utils';
import type { DotCardConfig } from '@/engine/types';
import { ItemCard } from '@/components/cards/item-card';
import { PractitionerActions } from './practitioner-actions';
import { getPrimaryLocation } from './practitioner-data';
import type { ItemLocation } from '@/lib/item-api';

export interface PractitionerCardProps {
  data: Record<string, unknown>;
  schema?: RJSFSchema | null;
  cardConfig?: DotCardConfig | null;
  title?: string;
  variant?: 'popup' | 'list';
  className?: string;
}

/** ItemCard for an orange practitioner with Call/Website/Get Directions actions. */
export function PractitionerCard({
  data,
  schema,
  cardConfig,
  title,
  variant = 'list',
  className,
}: PractitionerCardProps) {
  const phone = typeof data.contact_phone === 'string' ? data.contact_phone : null;
  const website = typeof data.website === 'string' ? data.website : null;
  const location = getPrimaryLocation(data.item_locations as ItemLocation[] | undefined);

  return (
    <ItemCard
      schema={schema}
      cardConfig={cardConfig}
      data={data}
      title={title}
      variant={variant}
      className={className}
      actions={<PractitionerActions phone={phone} website={website} location={location} />}
    />
  );
}
