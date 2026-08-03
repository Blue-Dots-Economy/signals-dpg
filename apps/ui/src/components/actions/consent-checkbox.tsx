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
    // Highlight the whole consent box with the same blue focus-ring the form
    // fields use (border-ring + ring-ring halo), shown PERMANENTLY (not only on
    // focus) so it's clearly visible in both dark and light mode — the default
    // `border`/`bg-muted` was nearly invisible against the dark card (#434).
    <div className="rounded-lg border border-ring ring-[3px] ring-ring/50 bg-muted/30 p-4">
      <p className="text-sm text-foreground mb-3 whitespace-pre-line">{text}</p>
      <div className="flex items-start gap-2">
        <Checkbox
          id={id}
          checked={checked}
          onCheckedChange={(value) => onCheckedChange(value === true)}
          // Same blue ring on the checkbox itself: the primitive's `border-input`
          // blends into the dark card, so give the empty box a `border-ring` +
          // `ring-ring` halo. The checked state (bg-primary, set by the
          // primitive with attribute-selector specificity) still wins.
          className="size-5 border-ring ring-2 ring-ring/50"
        />
        <Label htmlFor={id} className="text-sm font-medium cursor-pointer leading-snug">
          {t('consent.agree_short')}
        </Label>
      </div>
    </div>
  );
}
