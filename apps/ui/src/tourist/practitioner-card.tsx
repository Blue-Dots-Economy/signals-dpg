import type { RJSFSchema } from '@rjsf/utils';
import type { DotCardConfig } from '@/engine/types';
import { ItemCard } from '@/components/cards/item-card';
import { PractitionerActions } from './practitioner-actions';
import { getPrimaryLocation, isRubixListing } from './practitioner-data';
import type { ItemLocation } from '@/lib/item-api';
import { useThemeMode } from '@/theme/mode-provider';
import rubixLightBg from '@/assets/rubix-light-bg.svg';
import rubixDarkBg from '@/assets/rubix-dark-bg.svg';

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
  const { resolved } = useThemeMode();
  const phone = typeof data.contact_phone === 'string' ? data.contact_phone : null;
  const website = typeof data.website === 'string' ? data.website : null;
  const location = getPrimaryLocation(data.item_locations as ItemLocation[] | undefined);

  const isRubix = isRubixListing(data);

  // RubiX listings: RubiX is the source of truth, so only the Explore action is
  // offered (Call + Get Directions are disabled), and the avatar becomes the
  // RubiX favicon — theme-matched (dark-bg icon on dark theme, light-bg on light).
  const avatarImageUrl = isRubix
    ? resolved === 'dark'
      ? rubixDarkBg
      : rubixLightBg
    : undefined;

  return (
    <ItemCard
      schema={schema}
      cardConfig={cardConfig}
      data={data}
      title={title}
      variant={variant}
      className={className}
      avatarImageUrl={avatarImageUrl}
      actions={
        <PractitionerActions
          phone={isRubix ? null : phone}
          website={website}
          location={isRubix ? null : location}
        />
      }
    />
  );
}
