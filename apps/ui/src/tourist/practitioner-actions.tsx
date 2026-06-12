import { Phone, Compass, Navigation } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { LatLng } from '@/lib/geo/types';
import { telHref, normalizeWebsiteUrl, openDirections } from '@/lib/geo/directions';

export interface PractitionerActionsProps {
  phone?: string | null;
  website?: string | null;
  location?: (LatLng & { label?: string }) | null;
}

/** Call / Website / Get Directions. Each button is omitted if its field is absent. */
export function PractitionerActions({ phone, website, location }: PractitionerActionsProps) {
  const { t } = useTranslation();
  if (!phone && !website && !location) return null;

  // flex-wrap + a min width per button: on a wide card all three sit on one
  // row (flex-1 shares the space); on a narrow card (small phones) they wrap to
  // the next row instead of overflowing and getting clipped by the card edge.
  // On mobile the buttons are shorter/smaller text so the card stays compact;
  // sm+ restores the regular size (desktop unchanged).
  const btn = 'h-8 min-w-[5rem] flex-1 text-xs sm:h-9 sm:min-w-[7rem] sm:text-sm';
  return (
    <div className="flex w-full flex-wrap gap-1.5 sm:gap-2">
      {phone && (
        <Button asChild variant="outline" size="sm" className={btn}>
          <a href={telHref(phone)}>
            <Phone className="mr-1.5 h-3.5 w-3.5" />
            {t('tourist.call')}
          </a>
        </Button>
      )}
      {website && (
        <Button asChild variant="outline" size="sm" className={btn}>
          <a href={normalizeWebsiteUrl(website)} target="_blank" rel="noopener noreferrer">
            <Compass className="mr-1.5 h-3.5 w-3.5" />
            {t('tourist.website')}
          </a>
        </Button>
      )}
      {location && (
        <Button
          variant="default"
          size="sm"
          className={btn}
          onClick={() => openDirections(location, location.label)}
        >
          <Navigation className="mr-1.5 h-3.5 w-3.5" />
          {t('tourist.directions')}
        </Button>
      )}
    </div>
  );
}
