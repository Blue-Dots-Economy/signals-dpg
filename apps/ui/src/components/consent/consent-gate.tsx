/**
 * Guided-read consent gate body: every document in one continuous scroll, a
 * progress tracker above it, and a single agreement at the foot that unlocks
 * only once the reader has reached the end of the last document.
 *
 * Renders the body only — no dialog shell. `ResponsiveDialog` and
 * `DialogHeader` stay in `consent-modal.tsx`, which wires this in for gate
 * mode; this component only needs to work inside that flex column (desktop
 * dialog or, on phones, a vaul Drawer).
 */
import { useMemo, useRef, useState } from 'react';
import { ArrowDown, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Markdown } from '@/components/consent/markdown';
import { ConsentProgressTracker } from '@/components/consent/consent-progress-tracker';
import { useReadProgress } from '@/components/consent/read-progress';

/** One document to read before the gate can be accepted. */
export interface ConsentGateDoc {
  /** Stable id, also used as the `data-consent-section` anchor. */
  id: string;
  /** Fallback tracker-dot label, used until `consent.cap_<id>` exists. */
  cap: string;
  /** Heading rendered above the document body. */
  title: string;
  /** Markdown body content. */
  body: string;
}

/** Props for {@link ConsentGateBody}. */
export interface ConsentGateBodyProps {
  /** Documents to read, in order. */
  docs: ConsentGateDoc[];
  /** Called when the reader accepts, after the checkbox has been ticked. */
  onAccept: () => void;
}

/**
 * Renders the scrollable multi-document reader, its progress tracker, and
 * the footer (hint, checkbox, accept button) that gates on read progress.
 *
 * @param props - Documents and the accept callback.
 * @returns The gate body.
 */
export function ConsentGateBody({ docs, onAccept }: ConsentGateBodyProps): React.JSX.Element {
  const { t } = useTranslation();
  const readerRef = useRef<HTMLDivElement>(null);
  const [checked, setChecked] = useState(false);
  const docIds = useMemo(() => docs.map((d) => d.id), [docs]);
  const progress = useReadProgress(readerRef, docIds);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 sm:gap-4">
      <ConsentProgressTracker docs={docs} progress={progress} />

      {/*
       * Keyboard reachability: with the checkbox/button disabled until
       * `progress.allRead`, and no close button in gate mode, this pane is
       * the ONLY tabbable candidate inside the dialog on first open. A
       * plain, tabindex-less div is invisible to
       * @radix-ui/react-focus-scope's `getTabbableCandidates` (it only
       * accepts `tabIndex >= 0`), so without this the dialog's FocusScope
       * falls back to focusing its own non-scrollable container and Tab is
       * swallowed (no candidates to cycle to) — a keyboard-only user could
       * never reach or scroll the reading pane, and the gate cannot be
       * completed without scrolling. `tabIndex={0}` (not `-1`) is
       * deliberate: `-1` would make it focusable exactly once via an
       * imperative `.focus()` call but drop it out of the tab sequence, so
       * after tabbing forward to the checkbox a user could never tab BACK
       * to keep reading — the same trap in a quieter form. `role="region"`
       * plus an accessible name keeps this from announcing as an anonymous
       * scroller to a screen reader.
       */}
      <div
        ref={readerRef}
        data-testid="consent-reader"
        role="region"
        aria-label={t('consent.reader_label')}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-muted/20 p-4 sm:p-5"
      >
        {docs.map((doc, i) => (
          <section
            key={doc.id}
            data-consent-section={doc.id}
            className={i > 0 ? 'mt-6 border-t border-border pt-5' : undefined}
          >
            <h3 className="mb-2 text-base font-semibold text-foreground">{doc.title}</h3>
            <Markdown>{doc.body}</Markdown>
          </section>
        ))}
      </div>

      <div className="flex shrink-0 flex-col gap-3 border-t border-border pt-3 sm:pt-4">
        <p
          className={`flex items-center gap-1.5 text-xs ${
            progress.allRead ? 'font-semibold text-success' : 'text-muted-foreground'
          }`}
        >
          {progress.allRead ? (
            <Check className="h-3 w-3 shrink-0" aria-hidden="true" />
          ) : (
            <ArrowDown className="h-3 w-3 shrink-0" aria-hidden="true" />
          )}
          {progress.allRead ? t('consent.hint_done') : t('consent.hint_scroll')}
        </p>

        <div className="flex items-start gap-2">
          <Checkbox
            id="consent-agree"
            checked={checked}
            disabled={!progress.allRead}
            onCheckedChange={(value) => setChecked(value === true)}
          />
          <Label htmlFor="consent-agree" className="text-sm leading-snug cursor-pointer">
            {t('consent.agree_label')}
          </Label>
        </div>

        <button
          type="button"
          disabled={!progress.allRead || !checked}
          onClick={onAccept}
          className="flex w-full items-center justify-center rounded-md py-3 text-sm font-semibold text-[var(--brand-cta-foreground)] transition-all disabled:opacity-60 bg-brand-cta hover:brightness-110 h-11"
        >
          {t('consent.accept_continue')}
        </button>
      </div>
    </div>
  );
}
