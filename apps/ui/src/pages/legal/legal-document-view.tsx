/**
 * Read-only public legal page: both documents (Privacy Policy and Terms of
 * Service), in order, in one continuous scroll — with a contents rail beside
 * the reading column. No checkbox, no scroll gating, no consent capture —
 * that is the separate, landed `ConsentGateBody` surface.
 *
 * `/privacy` and `/terms` render the exact same page; the route only decides
 * which document the reader lands on (see the arrival effect below). Nothing
 * in the rail navigates to another route any more — every entry is a
 * same-page anchor, because both documents already live on the page.
 *
 * Signals has one audience (plus the `u18` variant, which this read-only
 * page does not surface), so unlike the sibling aggregator repo the rail
 * lists just the two documents and their sections — no audience grouping.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { LanguageSwitcher } from '@/components/layout/language-switcher';
import { ThemeModeToggle } from '@/components/layout/theme-mode-toggle';
import { PortalHeader } from '@/components/layout/portal-header';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useConsentConfig } from '@/hooks/use-consent-config';
import { Markdown } from '@/components/consent/markdown';
import { cn } from '@/lib/utils';
import { extractSections, type LegalSection } from '@/pages/legal/legal-sections';

export type LegalDoc = 'privacy' | 'terms';

const DOC_ORDER: LegalDoc[] = ['privacy', 'terms'];

interface ContentVersion {
  version: number;
  title: string;
  content: string;
  effective_from: string;
}

/** One rendered section: its rail metadata plus the markdown body that follows it. */
interface RenderableSection extends LegalSection {
  body: string;
}

/** One document, fully resolved for rendering: its version, preamble, and sections. */
interface RenderableDoc {
  doc: LegalDoc;
  version: ContentVersion;
  preamble: string;
  sections: RenderableSection[];
}

/**
 * Structural id for a document's own heading — built from the route key
 * (`privacy` / `terms`), never from document content. This is what the rail's
 * group header links to, and what an arrival with no hash (e.g. `/terms`)
 * scrolls to.
 */
function docHeadingId(doc: LegalDoc): string {
  return `${doc}-document`;
}

/**
 * Normalizes heading text for a title comparison — case- and
 * whitespace-insensitive, so "Privacy Policy", "privacy policy", and
 * "Privacy   Policy" all match the same title.
 */
function normalizeHeadingText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * True when `heading` is the document's own title, repeated as a heading.
 *
 * Every real consent document's Markdown opens with a level-2 heading that
 * repeats the document's `title` field verbatim (`## Privacy Policy`,
 * `## Terms of Service`, …) — verified across all six network schemas.
 * Rendering that heading as an ordinary section would duplicate the page's
 * own document heading and give the rail a first entry that just repeats its
 * own group header. This checks the title specifically, not "is it the first
 * heading" — a document that legitimately opens with `## Overview` keeps
 * that section.
 */
function isDocumentTitleHeading(heading: string, title: string): boolean {
  return normalizeHeadingText(heading) === normalizeHeadingText(title);
}

/**
 * Splits a document's markdown into its heading-delimited sections, pairing
 * each with the id `extractSections` would assign it. Rendering the headings
 * ourselves (rather than leaving them to `Markdown`/`ReactMarkdown`) is what
 * lets each one carry an `id` an anchor can land on.
 *
 * The document's own leading title heading (see `isDocumentTitleHeading`) is
 * dropped from the section list; any prose directly under it is folded into
 * the preamble so it isn't lost.
 *
 * Note: markdown with no `##`/`###` headings at all (or only its own title
 * heading) yields an empty `sections` list and the whole body as `preamble`
 * — never a crash. Headings nested deeper than `###` are not treated as
 * section boundaries either; they stay put as ordinary content inside
 * whichever section (or the preamble) they fall under, and `Markdown` still
 * renders them.
 *
 * @param markdown - The document body.
 * @param title - The document's title, so its own repeated heading can be
 *   told apart from a real first section.
 * @returns Any content before the first real section, plus the sections in order.
 */
function splitIntoSections(
  markdown: string,
  title: string,
): { preamble: string; sections: RenderableSection[] } {
  const ids = extractSections(markdown);
  const lines = markdown.split('\n');
  let inFence = false;
  const preambleLines: string[] = [];
  const bodies: string[][] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      (current ?? preambleLines).push(line);
      continue;
    }
    if (!inFence && /^(#{2,3})\s+(.*)$/.exec(line.trim())) {
      current = [];
      bodies.push(current);
      continue;
    }
    (current ?? preambleLines).push(line);
  }

  let sections: RenderableSection[] = ids.map((section, i) => ({
    ...section,
    body: (bodies[i] ?? []).join('\n').trim(),
  }));
  let preamble = preambleLines.join('\n').trim();

  const [leading] = sections;
  if (leading && isDocumentTitleHeading(leading.heading, title)) {
    preamble = [preamble, leading.body].filter(Boolean).join('\n\n');
    sections = sections.slice(1);
  }

  return { preamble, sections };
}

/**
 * Guarantees every section id on the page is unique once both documents are
 * rendered together.
 *
 * `extractSections` only dedupes *within* a single document's markdown, so
 * two documents that happen to share a heading (e.g. both open a "Grievances"
 * subsection) would otherwise produce two elements with the same `id` —
 * invalid HTML, and an anchor that could land on the wrong document's
 * heading. This never fires for the common case (no shared headings, which
 * is true of every real consent document today) — ids are only rewritten on
 * an actual collision, and only for the later document in `DOC_ORDER`, so
 * existing deep links are unaffected unless a genuine collision exists.
 *
 * @param docs - Documents in rendering order.
 * @returns The same documents, with any colliding section ids renumbered.
 */
function dedupeSectionIdsAcrossDocs(
  docs: { preamble: string; sections: RenderableSection[] }[],
): { preamble: string; sections: RenderableSection[] }[] {
  const seen = new Set<string>();
  return docs.map((doc) => ({
    ...doc,
    sections: doc.sections.map((section) => {
      if (!seen.has(section.id)) {
        seen.add(section.id);
        return section;
      }
      let suffix = 2;
      let candidate = `${section.id}-${suffix}`;
      while (seen.has(candidate)) {
        suffix += 1;
        candidate = `${section.id}-${suffix}`;
      }
      seen.add(candidate);
      return { ...section, id: candidate };
    }),
  }));
}

function getCurrentVersion(
  doc: { current_version: number; versions: ContentVersion[] } | undefined,
): ContentVersion | undefined {
  return doc?.versions.find((v) => v.version === doc.current_version);
}

/**
 * Whether the browser has asked for reduced motion — checked at click/scroll
 * time (not cached) so a user who changes the OS setting mid-session is
 * respected immediately.
 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  );
}

/**
 * The rail entry to highlight when no heading has actually scrolled past the
 * reading line yet — either a document with no sections at all, or (see
 * `computeActiveId` below) the very top of the page before any heading has
 * passed. Shared by the arrival landing and the scroll-spy so both fall back
 * to the same entry: the document's own first section, or its own heading if
 * it has none.
 */
function pillFallbackId(renderableDoc: RenderableDoc | undefined, doc: LegalDoc): string {
  return renderableDoc?.sections[0]?.id ?? docHeadingId(doc);
}

/**
 * How close to the top of the viewport a heading must have scrolled to count
 * as "passed" — matches the `scroll-mt-6` (24px) offset headings already
 * carry, plus a little slack for the rest of the reading column's own top
 * padding, so the highlighted entry is the one actually sitting at the top of
 * the reading area, not one still a full viewport away.
 */
const READING_LINE_PX = 96;

/**
 * How long to wait, after the most recent scroll event, before treating a
 * click-triggered scroll as settled and handing the highlight back to the
 * spy. Deliberately a fixed debounce rather than a "smooth scroll finished"
 * callback (no such event is universally available) — each scroll event
 * in flight pushes the release out again, so a long smooth scroll is
 * protected for its whole duration, while a reduced-motion jump (at most one
 * scroll event) releases almost immediately.
 */
const SCROLL_SETTLE_MS = 150;

/**
 * Renders the shared layout for `/privacy` and `/terms`: loading state,
 * unavailable fallback, the app bar (back link + language/theme controls),
 * the two-document contents rail, and the reading column holding both
 * documents in order.
 *
 * @param props.doc - Which document this route lands the reader on:
 *   `privacy` or `terms`. Both documents render on the page either way.
 */
export function LegalDocumentView({ doc }: { doc: LegalDoc }): React.JSX.Element {
  const { t } = useTranslation();
  const { config, isLoading } = useConsentConfig();
  const location = useLocation();
  const [activeId, setActiveId] = useState<string>(docHeadingId(doc));

  const routedVersion = getCurrentVersion(config?.documents[doc]);

  const availableDocs: RenderableDoc[] = useMemo(() => {
    const resolved = DOC_ORDER.map((d) => {
      const version = getCurrentVersion(config?.documents[d]);
      if (!version) return null;
      return { doc: d, version, ...splitIntoSections(version.content, version.title) };
    }).filter((d): d is NonNullable<typeof d> => d !== null);

    const deduped = dedupeSectionIdsAcrossDocs(resolved);
    return resolved.map((d, i) => ({ ...d, sections: deduped[i]!.sections }));
  }, [config]);

  const contentReady = availableDocs.some((d) => d.sections.length > 0 || Boolean(d.preamble));

  const spyTargetIds = useMemo(
    () => availableDocs.flatMap((d) => [docHeadingId(d.doc), ...d.sections.map((s) => s.id)]),
    [availableDocs],
  );

  // Scroll-spy: the rail's highlight follows whichever heading has most
  // recently scrolled past the reading line. Position-based (each heading's
  // own `getBoundingClientRect().top`), not an IntersectionObserver
  // percentage band — a band has to assume something about how tall a
  // section is, and a section shorter than the band lets the *next* heading
  // enter the band before the current one has genuinely been read, so the
  // pill jumps to it early. Comparing raw top-edge position makes no such
  // assumption: the active entry is just the last heading (in document
  // order) at or above `READING_LINE_PX`, which holds regardless of section
  // length.

  // Kept alongside `activeId` so `computeActiveId`'s no-candidate branch (an
  // empty page, defensively) has a same-render value to fall back to without
  // needing `activeId` itself in its dependency list.
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const computeActiveId = useCallback((): string => {
    const elements = spyTargetIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return activeIdRef.current;

    // The last element (in document order) that has scrolled up past the
    // reading line — a document's own heading counts here too, so this
    // still finds something the moment a document's intro prose reaches the
    // top, before any of its `##`/`###` headings have.
    let lastPassed: HTMLElement | null = null;
    for (const el of elements) {
      if (el.getBoundingClientRect().top <= READING_LINE_PX) {
        lastPassed = el;
      } else {
        break;
      }
    }

    // Nothing has passed yet — genuinely at the very top of the page. Same
    // "first document's first section" fallback as the "own heading, no
    // section yet" branch below, just spelled out for the empty case.
    if (!lastPassed) return pillFallbackId(availableDocs[0], DOC_ORDER[0]);

    const currentDoc = availableDocs.find((d) => docHeadingId(d.doc) === lastPassed!.id);
    if (!currentDoc) {
      // `lastPassed` is a section id, not a document heading — it is
      // already the entry to highlight.
      return lastPassed.id;
    }
    // `lastPassed` is a document's own heading with none of its sections
    // reached yet (its intro prose is still what's on screen) — highlight
    // its first section instead of leaving the pill on a bare doc heading,
    // which would be the same "nothing really highlighted" gap this whole
    // fallback exists to close.
    return pillFallbackId(currentDoc, currentDoc.doc);
  }, [spyTargetIds, availableDocs]);

  // A just-clicked rail entry, or a programmatic (arrival/deep-link) scroll,
  // is pinned for the duration of its scroll — otherwise the effect below
  // would recompute from transient mid-scroll geometry and the pill would
  // flicker across whichever entries the scroll passes through before
  // resting on the intended one.
  const pinnedIdRef = useRef<string | null>(null);
  const pinReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const armPinRelease = useCallback(() => {
    if (pinReleaseTimerRef.current) clearTimeout(pinReleaseTimerRef.current);
    pinReleaseTimerRef.current = setTimeout(() => {
      pinnedIdRef.current = null;
      setActiveId(computeActiveId());
    }, SCROLL_SETTLE_MS);
  }, [computeActiveId]);

  /**
   * Scrolls `targetElId` into view (if it exists) and pins the rail's
   * highlight to `pillId` for the duration of that scroll. The two can
   * differ: a no-hash arrival at `/terms` scrolls to the *document* heading
   * (`terms-document`) but pills its *first section* — otherwise the
   * pinned value itself would be the bare doc heading the fallback above
   * exists to avoid.
   */
  const scrollAndPin = useCallback(
    (targetElId: string, pillId: string) => {
      setActiveId(pillId);
      pinnedIdRef.current = pillId;
      armPinRelease();
      const el = document.getElementById(targetElId);
      if (el) {
        el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
      }
    },
    [armPinRelease],
  );

  useEffect(() => {
    if (!contentReady || spyTargetIds.length === 0) return;

    function handleScroll() {
      if (pinnedIdRef.current) {
        // Still mid-flight: keep pushing the release out rather than acting
        // on this event, so a long smooth scroll stays pinned for its whole
        // duration.
        armPinRelease();
        return;
      }
      setActiveId(computeActiveId());
    }

    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleScroll);
    return () => {
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleScroll);
    };
  }, [contentReady, spyTargetIds, computeActiveId, armPinRelease]);

  // Release a pin left over from an unmounted click (e.g. navigating away
  // mid-scroll) rather than leaking the timer.
  useEffect(() => {
    return () => {
      if (pinReleaseTimerRef.current) clearTimeout(pinReleaseTimerRef.current);
    };
  }, []);

  // Deep-link / arrival landing. Two ways a target section fails to scroll
  // into view without this:
  //   (a) a rail click is a same-page anchor, not a full navigation — so the
  //       browser's own one-shot fragment-scroll never fires at all.
  //   (b) a cold `/privacy#retention` load, or a plain `/terms` load: the
  //       content this needs to scroll to only renders once the
  //       consent-config fetch resolves, which is almost always after the
  //       browser's one-shot fragment-scroll attempt (if any) has already run
  //       and found nothing.
  // The target is either the hash (deep link) or, absent a hash, this
  // route's own document heading — UNLESS that document is already the first
  // one on the page, in which case it is already at the top and there is
  // nothing to scroll to.
  //
  // No-hash arrival never highlights a section on its own: every document
  // opens with intro prose before its first heading, so the scroll-spy
  // has nothing "passed" at scroll-top and highlights nothing (see
  // `pillFallbackId`). Rather than land with the rail showing no pill at
  // all, default the highlight to the routed document's own first section
  // (or its own heading, for a document with no sections) — the same
  // fallback the spy uses once real scrolling starts. `scrollAndPin` also
  // keeps the spy from fighting this scroll while it's in flight: a real
  // browser fires genuine `scroll` events for a programmatic
  // `scrollIntoView` exactly as it would for a user's own scrolling, and
  // without the pin the spy would recompute mid-flight and briefly show
  // whichever heading the animation happens to be passing through.
  useEffect(() => {
    if (!contentReady) return;
    const hashId = location.hash ? decodeURIComponent(location.hash.slice(1)) : null;
    if (hashId) {
      if (document.getElementById(hashId)) scrollAndPin(hashId, hashId);
      return;
    }
    const routedDoc = availableDocs.find((d) => d.doc === doc);
    const fallbackId = pillFallbackId(routedDoc, doc);
    if (doc !== DOC_ORDER[0]) {
      scrollAndPin(docHeadingId(doc), fallbackId);
    } else {
      // Already at the top — nothing to scroll to, so no pin needed either.
      setActiveId(fallbackId);
    }
  }, [location.hash, contentReady, doc, availableDocs, scrollAndPin]);

  /**
   * `targetId` is what gets scrolled to; `pillId` (defaulting to the same
   * value) is what the rail highlights meanwhile. They differ for a
   * document-header click: it scrolls to that document's own heading, but
   * pins the highlight to its first section — there is no rail entry for
   * the bare heading itself to highlight, since document-level highlighting
   * was removed (only section pills are a live indicator now).
   */
  function handleRailClick(targetId: string, pillId: string = targetId) {
    return (event: React.MouseEvent) => {
      event.preventDefault();
      scrollAndPin(targetId, pillId);
    };
  }

  if (isLoading) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!routedVersion) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <p className="text-sm text-muted-foreground">
          {doc === 'privacy' ? 'Privacy policy unavailable.' : 'Terms of service unavailable.'}
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-svh bg-background">
      <TooltipProvider>
        {/* App bar: matches `TopBar`'s own height/padding/border (the app's
            real bar elsewhere) rather than inventing new spacing, plus the
            brand logo it was missing — this page previously had no branding
            at all, which is what made it look foreign next to the rest of
            the app. `TopBar` itself isn't reused wholesale: it pulls in
            search, view-toggle, filters, notifications and login/user-menu
            state via `useAuth`, none of which mean anything on a public,
            unauthenticated legal page. `PortalHeader` is the piece that
            actually carries the logo, so it's composed here directly with
            the same language/theme controls, plus the back link — the only
            way back for someone mid-signup. */}
        <header className="sticky top-0 z-40 flex min-h-14 items-center gap-3 border-b bg-gradient-to-r from-background to-primary/5 px-4 py-2 sm:px-6">
          <PortalHeader />
          {/* Label drops below `sm` (icon-only) so a long wordmark plus
              language/theme controls never wrap the row and overlap the
              content underneath — same collapse `TopBar`'s own Back control
              uses. The link stays reachable and named for screen readers via
              `aria-label` either way. */}
          <Link
            to="/auth/login"
            aria-label={t('legal.back_to_sign_in')}
            className="inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold text-muted-foreground transition-colors hover:text-primary"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">{t('legal.back_to_sign_in')}</span>
          </Link>
          <div className="ml-auto flex items-center gap-1">
            <LanguageSwitcher compact />
            <ThemeModeToggle />
          </div>
        </header>
      </TooltipProvider>

      <div className="px-6 py-8">
        <div className="mx-auto max-w-5xl">
          <div className="grid gap-6 md:grid-cols-[236px_1fr] md:gap-10">
            <nav
              aria-label={t('legal.contents_label')}
              className="border-b border-border pb-6 mb-6 md:sticky md:top-6 md:mb-0 md:self-start md:border-b-0 md:border-r md:pb-0 md:pr-6"
            >
              {availableDocs.map(({ doc: d, version, sections }) => {
                const headingId = docHeadingId(d);

                return (
                  <div key={d} className="mb-6">
                    <a
                      href={`#${headingId}`}
                      onClick={handleRailClick(headingId, sections[0]?.id ?? headingId)}
                      className="block rounded-md px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.1em] text-muted-foreground transition-colors hover:bg-muted hover:text-primary"
                    >
                      {version.title}
                    </a>
                    <ul className="mt-1 space-y-0.5">
                      {sections.map((section) => {
                        const isActiveSection = activeId === section.id;
                        return (
                          <li key={section.id}>
                            <a
                              href={`#${section.id}`}
                              onClick={handleRailClick(section.id)}
                              aria-current={isActiveSection ? 'true' : undefined}
                              className={cn(
                                'block rounded-md border-l-2 py-1.5 pl-3 text-[12.5px] transition-colors',
                                isActiveSection
                                  ? 'border-primary bg-primary/10 font-semibold text-primary'
                                  : 'border-transparent text-muted-foreground hover:bg-muted hover:text-primary',
                              )}
                            >
                              {section.heading}
                            </a>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </nav>

            <div className="min-w-0 max-w-[72ch]">
              {availableDocs.map(({ doc: d, version, preamble, sections }, index) => {
                const effectiveDate = new Date(version.effective_from).toLocaleDateString();
                // The routed document (whichever one the reader arrived at) is
                // the page's <h1> — there is only ever one per page. The other
                // document, included below it for the continuous scroll, is an
                // <h2>: a real heading, just not the page's primary one.
                const DocHeading = d === doc ? 'h1' : 'h2';
                return (
                  <div key={d}>
                    {index > 0 && <hr className="mt-11 border-t border-border" />}
                    <DocHeading
                      id={docHeadingId(d)}
                      className={cn(
                        'text-2xl font-bold text-foreground scroll-mt-6',
                        index > 0 && 'mt-9',
                      )}
                    >
                      {version.title}
                    </DocHeading>
                    <p className="mb-6 text-xs text-muted-foreground">
                      {t('legal.version_effective', {
                        version: version.version,
                        date: effectiveDate,
                      })}
                    </p>

                    {preamble && <Markdown>{preamble}</Markdown>}

                    {sections.map((section) =>
                      section.level === 2 ? (
                        <div key={section.id}>
                          <h2
                            id={section.id}
                            className="mt-8 mb-2 text-lg font-semibold text-foreground scroll-mt-6"
                          >
                            {section.heading}
                          </h2>
                          {section.body && <Markdown>{section.body}</Markdown>}
                        </div>
                      ) : (
                        <div key={section.id}>
                          <h3
                            id={section.id}
                            className="mt-6 mb-2 text-base font-semibold text-foreground scroll-mt-6"
                          >
                            {section.heading}
                          </h3>
                          {section.body && <Markdown>{section.body}</Markdown>}
                        </div>
                      ),
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
