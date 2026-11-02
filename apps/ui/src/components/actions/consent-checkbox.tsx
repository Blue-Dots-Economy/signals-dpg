import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useTranslation } from 'react-i18next';

interface ConsentCheckboxProps {
  text: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  id?: string;
}

export function ConsentCheckbox({
  text,
  checked,
  onCheckedChange,
  id = 'consent-acknowledge',
}: ConsentCheckboxProps) {
  const { t } = useTranslation();
  return (
    // A permanent focus-style ring, since a plain border is nearly invisible
    // on the dark card.
    <div className="rounded-lg border border-ring ring-[3px] ring-ring/50 bg-muted/30 p-4">
      <p className="text-sm text-foreground mb-3 whitespace-pre-line">{text}</p>
      <div className="flex items-start gap-2">
        <Checkbox
          id={id}
          checked={checked}
          onCheckedChange={(value) => onCheckedChange(value === true)}
          // Same ring on the box, whose `border-input` blends into the dark
          // card. The primitive's checked style still wins on specificity.
          className="size-5 border-ring ring-2 ring-ring/50"
        />
        <Label htmlFor={id} className="text-sm font-medium cursor-pointer leading-snug">
          {t('consent.agree_short')}
        </Label>
      </div>
    </div>
  );
}
