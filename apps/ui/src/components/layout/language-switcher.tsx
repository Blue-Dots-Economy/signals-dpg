import { useTranslation } from 'react-i18next';
import { Languages } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { getAvailableLanguages } from '@/i18n';

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const languages = getAvailableLanguages();
  const currentCode = i18n.resolvedLanguage ?? i18n.language;

  function handleChange(code: string) {
    void i18n.changeLanguage(code);
  }

  return (
    <Select value={currentCode} onValueChange={handleChange}>
      <SelectTrigger
        size="sm"
        className="w-auto gap-1.5 border-0 bg-transparent shadow-none hover:bg-accent px-2"
        aria-label={t('language.label')}
      >
        <Languages className="h-4 w-4 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {languages.map(({ code, name }) => (
          <SelectItem key={code} value={code}>
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
