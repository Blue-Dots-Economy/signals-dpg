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
   * Single source of truth for "may this be actioned". Both controls below
   * report it via `aria-disabled` AND guard their handler on it — they are
   * deliberately not `disabled`, which would drop them out of the
   * accessibility tree entirely and leave a screen-reader user with nothing to
   * land on to discover WHY they cannot proceed (WCAG 2.2 4.1.3). Kept as one
   * expression so the announced state and the enforced state cannot drift.
   */
  const canTick = progress.allRead;
  const canAccept = progress.allRead && checked;

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
       * to keep reading — the same trap in a quieter form. A `<section>`
       * with an accessible name carries the implicit `region` role, so this
       * doesn't announce as an anonymous scroller to a screen reader.
       */}
      <section
        ref={readerRef}
        data-testid="consent-reader"
        aria-label={t('consent.reader_label')}
        tabIndex={0}
        // `relative` is defense in depth, not the fix: read-progress.ts
        // measures section geometry with getBoundingClientRect deltas, which
        // are correct regardless of the positioned ancestor. But this class
        // makes THIS element that ancestor too, so offsetTop/offsetHeight
        // (should anyone reach for them here again) resolve against the
        // scroller, not the dialog/drawer's `fixed` wrapper several levels
        // up — the mistake that made the gate unreachable in every real
        // browser while every stubbed unit test stayed green.
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
          * Live region: the gate unlocking is a state change with no visual
          * focus move, so without this a screen-reader user reads to the end,
          * the controls silently become operable, and nothing tells them.
          * `polite` and only two possible strings — it announces the
          * transition once, not on every scroll tick.
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
              // Enforcement, not decoration: `aria-disabled` alone leaves the
              // control operable, so the gate would be bypassable without this.
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
