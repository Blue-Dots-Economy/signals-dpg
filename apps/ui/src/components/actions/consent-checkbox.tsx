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
    <div className="rounded-md border bg-muted/30 p-4">
      <p className="text-sm text-foreground mb-3 whitespace-pre-line">{text}</p>
      <div className="flex items-start gap-2">
        <Checkbox
          id={id}
          checked={checked}
          onCheckedChange={(value) => onCheckedChange(value === true)}
        />
        <Label htmlFor={id} className="text-sm font-medium cursor-pointer leading-snug">
          {t('consent.agree_short')}
        </Label>
      </div>
    </div>
  );
}
