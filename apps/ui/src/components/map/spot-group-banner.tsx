import { useTranslation } from 'react-i18next';
import { Map as MapIcon } from 'lucide-react';

/** Tells the viewer the list shows one same-spot group from the map, with a way back. */
export function SpotGroupBanner({ exact, onBackToMap }: Readonly<{ exact: boolean; onBackToMap: () => void }>) {
  const { t } = useTranslation();
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 font-medium">
        {t(exact ? 'browse.spot_banner_exact' : 'browse.spot_banner_near')}
      </span>
      <button
        type="button"
        onClick={onBackToMap}
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-semibold text-primary pointer-coarse:min-h-11 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MapIcon className="h-3.5 w-3.5" aria-hidden />
        {t('browse.spot_back_to_map')}
      </button>
    </div>
  );
}
