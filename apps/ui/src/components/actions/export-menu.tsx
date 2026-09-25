import { useTranslation } from 'react-i18next';
import { ChevronDown, Download, Loader2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** One downloadable counterparty type in the current selection. */
export interface ExportMenuGroup {
  /** Stable group id handed back to `onDownload`. */
  key: string;
  /** Display name of the counterparty type (plural), e.g. "Seekers". */
  label: string;
  count: number;
}

interface ExportMenuProps {
  /** Selected, exportable engagements grouped by counterparty type. */
  groups: readonly ExportMenuGroup[];
  /** A download is running — the control is disabled. */
  pending?: boolean;
  onDownload: (key: string) => void;
}

/**
 * The Download control in the My Actions bulk bar (#771). One button whatever
 * the selection: with one counterparty type it downloads straight away; with
 * several it opens a menu, one item per type (the server returns one type per
 * file). Renders nothing until an exportable card is selected.
 */
export function ExportMenu({ groups, pending = false, onDownload }: Readonly<ExportMenuProps>) {
  const { t } = useTranslation();
  if (groups.length === 0) return null;

  const total = groups.reduce((sum, g) => sum + g.count, 0);
  const Icon = pending ? Loader2 : Download;
  const label = t('actions.export_download_count', { count: total });
  const buttonClass =
    'flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs font-bold text-primary-foreground disabled:opacity-60';
  const icon = <Icon className={`h-3.5 w-3.5 ${pending ? 'animate-spin' : ''}`} />;

  if (groups.length === 1) {
    return (
      <button type="button" className={buttonClass} disabled={pending} onClick={() => onDownload(groups[0].key)}>
        {icon}
        {label}
      </button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={buttonClass} disabled={pending}>
          {icon}
          {label}
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-[1200]">
        {groups.map((g) => (
          <DropdownMenuItem key={g.key} onSelect={() => onDownload(g.key)}>
            {t('actions.export_menu_item', { label: g.label, count: g.count })}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
