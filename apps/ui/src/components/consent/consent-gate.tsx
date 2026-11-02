/**
 * Guided-read consent gate body: all documents in one scroll, a progress
 * tracker above, and one agreement that unlocks only after the end of the last
 * document. The dialog shell lives in `consent-modal.tsx`.
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
  /** Also the `data-consent-section` anchor. */
  id: string;
  /** Fallback tracker-dot label, used until `consent.cap_<id>` exists. */
  cap: string;
  title: string;
  body: string;
}

export interface ConsentGateBodyProps {
  docs: ConsentGateDoc[];
  /** Called when the reader accepts, after the checkbox has been ticked. */
  onAccept: () => void;
}

export function ConsentGateBody({
  docs,
  onAccept,
}: Readonly<ConsentGateBodyProps>): React.JSX.Element {
  const { t } = useTranslation();
  const readerRef = useRef<HTMLElement>(null);
  const [checked, setChecked] = useState(false);
  const docIds = useMemo(() => docs.map((d) => d.id), [docs]);
  const progress = useReadProgress(readerRef, docIds);
  /**
   * Both controls below report these via `aria-disabled` and guard their
   * handlers on them. Not `disabled`, so they stay focusable and a
   * screen-reader user can discover why they cannot proceed.
   */
  const canTick = progress.allRead;
  const canAccept = progress.allRead && checked;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 sm:gap-4">
      <ConsentProgressTracker docs={docs} progress={progress} />

      {/*
       * `tabIndex={0}` so keyboard users can focus and scroll the pane; the
       * gate cannot be completed without scrolling. Radix FocusScope only
       * treats `tabIndex >= 0` as tabbable, and `-1` would drop the pane out
       * of the tab order so a user could not tab back to keep reading. A
       * named `<section>` has the implicit `region` role.
       */}
      <section
        ref={readerRef}
        data-testid="consent-reader"
        aria-label={t('consent.reader_label')}
        tabIndex={0}
        // `relative` makes the scroller the offset parent as a safeguard;
        // read-progress.ts uses rect deltas and does not depend on it.
        className="relative min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-muted/20 p-4 sm:p-5"
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
      </section>

      <div className="flex shrink-0 flex-col gap-3 border-t border-border pt-3 sm:pt-4">
        {/*
          * Live region: announces the unlock, which moves no focus. Only two
          * strings, so it fires once, not on every scroll.
          */}
        <p
          id="consent-scroll-hint"
          aria-live="polite"
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
            aria-disabled={!canTick}
            aria-describedby="consent-scroll-hint"
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            onCheckedChange={(value) => {
              // `aria-disabled` alone leaves the control operable.
              if (!canTick) return;
              setChecked(value === true);
            }}
          />
          <Label htmlFor="consent-agree" className="text-sm leading-snug cursor-pointer">
            {t('consent.agree_label')}
          </Label>
        </div>

        <button
          type="button"
          aria-disabled={!canAccept}
          aria-describedby="consent-scroll-hint"
          onClick={() => {
            // See the checkbox: `aria-disabled` does not block activation.
            if (!canAccept) return;
            onAccept();
          }}
          className="flex w-full items-center justify-center rounded-md py-3 text-sm font-semibold text-[var(--brand-cta-foreground)] transition-all aria-disabled:opacity-60 aria-disabled:cursor-not-allowed bg-brand-cta hover:brightness-110 h-11"
        >
          {t('consent.accept_continue')}
        </button>
      </div>
    </div>
  );
}
