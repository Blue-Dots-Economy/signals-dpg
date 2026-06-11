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
import { cn } from '@/lib/utils';

interface LanguageSwitcherProps {
  /**
   * When true, hide the current-language label on small screens (icon only),
   * showing it again at sm+. Lets tight mobile toolbars (e.g. the tourist app
   * bar) keep everything on one line. Defaults to false → label always shown
   * (signals behaviour unchanged).
   */
  compact?: boolean;
}

export function LanguageSwitcher({ compact = false }: LanguageSwitcherProps) {
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
        <span className={cn(compact && 'hidden sm:inline')}>
          <SelectValue />
        </span>
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
