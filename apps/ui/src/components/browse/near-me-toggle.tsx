import { Navigation } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

export interface NearMeToggleProps {
  active: boolean;
  onChange: (active: boolean) => void;
}

/**
 * LIST view control (#203 List PR Task 5). OFF (the default) = the ranked
 * discover feed served globally; ON = proximity — results near the user's
 * location. The map is unaffected (it reads viewport markers). The caller owns
 * visibility (render only in list view).
 */
export function NearMeToggle({ active, onChange }: NearMeToggleProps) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      variant={active ? 'default' : 'outline'}
      size="sm"
      aria-pressed={active}
      onClick={() => onChange(!active)}
    >
      <Navigation className="mr-1.5 h-4 w-4" />
      {t('home.near_me')}
    </Button>
  );
}
