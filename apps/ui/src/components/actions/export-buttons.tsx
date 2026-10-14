import { useTranslation } from 'react-i18next';
import { Download, Loader2 } from 'lucide-react';

/** One downloadable counterparty type in the current selection. */
export interface ExportButtonGroup {
  /** Stable group id handed back to `onDownload`. */
  key: string;
  /** Display name of the counterparty type (plural), e.g. "Seekers". */
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
 * The Download buttons in the My Actions bulk bar (#771): one per
 * counterparty type in the selection ("Download Seekers (2)", "Download
 * Service Providers (1)"), since the server returns one type per file and
 * each type has its own columns. Renders nothing until an exportable card is
 * selected.
 */
export function ExportButtons({ groups, pending = false, onDownload }: Readonly<ExportButtonsProps>) {
  const { t } = useTranslation();
  if (groups.length === 0) return null;

  const Icon = pending ? Loader2 : Download;
  return (
    <>
      {groups.map((g) => (
        <button
          key={g.key}
          type="button"
          disabled={pending}
          onClick={() => onDownload(g.key)}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs font-bold text-primary-foreground disabled:opacity-60"
        >
          <Icon className={`h-3.5 w-3.5 ${pending ? 'animate-spin' : ''}`} />
          {t('actions.export_download_type', { label: g.label, count: g.count })}
        </button>
      ))}
    </>
  );
}
