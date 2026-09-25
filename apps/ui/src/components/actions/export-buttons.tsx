import { useTranslation } from 'react-i18next';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** One downloadable counterparty type in the current selection. */
export interface ExportButtonGroup {
  /** Stable group id handed back to `onDownload`. */
  key: string;
  /** Display name of the counterparty domain (plural), e.g. "Seekers". */
  label: string;
  count: number;
}

interface ExportButtonsProps {
  /** Selected, exportable engagements grouped by counterparty type. */
  groups: readonly ExportButtonGroup[];
  /** A download is running — every button is disabled. */
  pending?: boolean;
  onDownload: (key: string) => void;
}

/**
 * The My Actions download control (#771). Disabled until at least one
 * exportable card is selected; one button per counterparty type, since the
 * server returns one counterparty type per file.
 */
export function ExportButtons({
  groups,
  pending = false,
  onDownload,
}: Readonly<ExportButtonsProps>) {
  const { t } = useTranslation();
  const Icon = pending ? Loader2 : Download;
  const iconClass = `mr-2 h-4 w-4 ${pending ? 'animate-spin' : ''}`;

  if (groups.length === 0) {
    return (
      <Button variant="outline" size="sm" disabled title={t('actions.export_select_hint')}>
        <Download className="mr-2 h-4 w-4" />
        {t('actions.export_download')}
      </Button>
    );
  }

  return (
    <>
      {groups.map((g) => (
        <Button
          key={g.key}
          variant="default"
          size="sm"
          disabled={pending}
          onClick={() => onDownload(g.key)}
        >
          <Icon className={iconClass} />
          {groups.length === 1
            ? t('actions.export_download_count', { count: g.count })
            : t('actions.export_download_type', { label: g.label, count: g.count })}
        </Button>
      ))}
    </>
  );
}
