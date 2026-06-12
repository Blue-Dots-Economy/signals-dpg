import { Phone, Globe, Navigation } from 'lucide-react';
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
  return (
    <div className="flex w-full flex-wrap gap-2">
      {phone && (
        <Button asChild variant="outline" size="sm" className="min-w-[7rem] flex-1">
          <a href={telHref(phone)}>
            <Phone className="mr-1.5 h-3.5 w-3.5" />
            {t('tourist.call')}
          </a>
        </Button>
      )}
      {website && (
        <Button asChild variant="outline" size="sm" className="min-w-[7rem] flex-1">
          <a href={normalizeWebsiteUrl(website)} target="_blank" rel="noopener noreferrer">
            <Globe className="mr-1.5 h-3.5 w-3.5" />
            {t('tourist.website')}
          </a>
        </Button>
      )}
      {location && (
        <Button
          variant="default"
          size="sm"
          className="min-w-[7rem] flex-1"
          onClick={() => openDirections(location, location.label)}
        >
          <Navigation className="mr-1.5 h-3.5 w-3.5" />
          {t('tourist.directions')}
        </Button>
      )}
    </div>
  );
}
