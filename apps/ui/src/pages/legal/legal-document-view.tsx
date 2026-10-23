/**
 * Read-only public legal page (`/legal`): the Privacy Policy and Terms of
 * Service in one continuous scroll, with a contents rail of same-page anchors.
 * No consent capture (that is `ConsentGateBody`). `/privacy` and `/terms`
 * redirect to `/legal#privacy` and `/legal#terms` (see `app.tsx`), so where the
 * reader lands is decided by the URL fragment alone. The `u18` variant is not
 * shown here.
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
 * Id for a document's own heading: the bare key, so `/legal#privacy` and
 * `/legal#terms` resolve natively. `dedupeSectionIdsAcrossDocs` reserves both
 * names so a section heading cannot take them over.
 */
function docHeadingId(doc: LegalDoc): string {
  return doc;
}

/** Normalizes heading text for a case- and whitespace-insensitive comparison. */
function normalizeHeadingText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * True when `heading` repeats the document's own title (every consent
 * document's Markdown opens with `## <title>`). Rendered as a section it would
 * duplicate the document heading. Checks the title, not "first heading", so a
 * document opening with `## Overview` keeps that section.
 */
function isDocumentTitleHeading(heading: string, title: string): boolean {
  return normalizeHeadingText(heading) === normalizeHeadingText(title);
}

/**
 * Splits a document's markdown into `##`/`###` sections, paired with the ids
 * `extractSections` assigns, so each rendered heading can carry an anchor id.
 * The leading title heading is dropped and any prose under it folded into the
 * preamble. Markdown with no such headings yields no sections and the whole
 * body as preamble; deeper headings stay inside their section's content.
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
    if (!inFence && /^#{2,3}\s/.test(line.trim())) {
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
 * Makes section ids unique across both documents and keeps them off the
 * document ids. `extractSections` dedupes only within one document, so a
 * heading shared by both would yield duplicate ids. Only the later document's
 * colliding ids are renumbered (e.g. a "Privacy" section becomes `privacy-2`),
 * so existing deep links are unaffected otherwise.
 */
function dedupeSectionIdsAcrossDocs(
  docs: { preamble: string; sections: RenderableSection[] }[],
): { preamble: string; sections: RenderableSection[] }[] {
  const seen = new Set<string>(DOC_ORDER.map(docHeadingId));
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
 * Whether the browser asks for reduced motion. Checked per call, not cached,
 * so a mid-session OS setting change applies immediately.
 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  );
}

/**
 * The rail entry to highlight when no heading has passed the reading line:
 * the document's first section, or its own heading if it has none. Shared by
 * the arrival landing and the scroll-spy. Derives the key from the document so
 * a network publishing only `terms` never pills a missing `#privacy`.
 */
function pillFallbackId(renderableDoc: RenderableDoc | undefined): string | undefined {
  if (!renderableDoc) return undefined;
  return renderableDoc.sections[0]?.id ?? docHeadingId(renderableDoc.doc);
}

/**
 * How close to the viewport top a heading must be to count as passed: the
 * `scroll-mt-20` (80px) offset clearing the sticky app bar, plus slack.
 */
const READING_LINE_PX = 96;

/**
 * Debounce after the last scroll event before a click-triggered scroll counts
 * as settled and the spy takes over again. There is no portable "smooth scroll
 * finished" event; each scroll event pushes the release out.
 */
const SCROLL_SETTLE_MS = 150;

/**
 * Renders `/legal`: loading and unavailable states, the app bar, the contents
 * rail, and both documents in order. The landing section comes from the URL
 * fragment.
 */
export function LegalDocumentView(): React.JSX.Element {
  const { t } = useTranslation();
  const { config, isLoading } = useConsentConfig();
  const location = useLocation();
  const [activeId, setActiveId] = useState<string>(docHeadingId(DOC_ORDER[0]));

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

  // Scroll-spy: highlight the last heading (in document order) at or above
  // `READING_LINE_PX`, by each heading's top position. An IntersectionObserver
  // band would assume a section height and jump early on short sections.

  // Same-render fallback for `computeActiveId` when no target exists, without
  // `activeId` in its dependency list.
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const computeActiveId = useCallback((): string => {
    const elements = spyTargetIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return activeIdRef.current;

    // The last element that has scrolled past the reading line. Document
    // headings count too, so intro prose before the first section still
    // resolves.
    let lastPassed: HTMLElement | null = null;
    for (const el of elements) {
      if (el.getBoundingClientRect().top <= READING_LINE_PX) {
        lastPassed = el;
      } else {
        break;
      }
    }

    // Nothing passed yet: the very top of the page.
    if (!lastPassed) return pillFallbackId(availableDocs[0]) ?? activeIdRef.current;

    const currentDoc = availableDocs.find((d) => docHeadingId(d.doc) === lastPassed!.id);
    if (!currentDoc) {
      // A section id: highlight it directly.
      return lastPassed.id;
    }
    // A document heading with none of its sections reached: highlight its
    // first section rather than a bare heading.
    return pillFallbackId(currentDoc) ?? lastPassed.id;
  }, [spyTargetIds, availableDocs]);

  // A clicked rail entry or programmatic scroll is pinned for the scroll's
  // duration, so the pill does not flicker across headings it passes.
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
   * Scrolls `targetElId` into view and pins the highlight to `pillId` meanwhile.
   * They differ when the target is a document heading: arriving at
   * `/legal#terms` scrolls to `terms` but pills its first section.
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
        // Mid-flight: push the release out so a long smooth scroll stays pinned.
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

  // Clear the release timer on unmount.
  useEffect(() => {
    return () => {
      if (pinReleaseTimerRef.current) clearTimeout(pinReleaseTimerRef.current);
    };
  }, []);

  // Arrival / deep-link landing, re-run on every hash change. Needed because a
  // rail click is a same-page anchor (no browser fragment scroll), and the
  // content only renders after the consent-config fetch, after the browser's
  // one-shot fragment scroll has already found nothing. With no hash, seed the
  // pill with the first document's first section. `scrollAndPin` keeps the spy
  // from reacting to the programmatic scroll's own scroll events.
  useEffect(() => {
    if (!contentReady) return;
    const hashId = location.hash ? decodeURIComponent(location.hash.slice(1)) : null;
    if (hashId) {
      // A document hash scrolls to the document but pills its first section;
      // there is no rail entry for a bare document heading.
      const targetDoc = availableDocs.find((d) => docHeadingId(d.doc) === hashId);
      const pillId = (targetDoc && pillFallbackId(targetDoc)) ?? hashId;
      if (document.getElementById(hashId)) scrollAndPin(hashId, pillId);
      return;
    }
    // Top of the page: just seed the pill.
    const firstPill = pillFallbackId(availableDocs[0]);
    if (firstPill) setActiveId(firstPill);
  }, [location.hash, contentReady, availableDocs, scrollAndPin]);

  /**
   * `targetId` is scrolled to; `pillId` (default: the same) is highlighted.
   * A document-header click scrolls to the heading but pills its first section.
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

  // Unavailable only when neither document resolved.
  if (!contentReady) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('legal.unavailable')}</p>
      </div>
    );
  }

  return (
    <div className="min-h-svh bg-background">
      <TooltipProvider>
        {/* App bar: `TopBar`'s height/padding/border plus the brand logo.
            `TopBar` itself is not reused because its search, filters and user
            state mean nothing on a public legal page. The back link is the only
            way back for someone mid-signup. */}
        {/* `bg-background` under the translucent gradient is needed: this page
            scrolls the window, so content would show through the bar. `h-14`
            (fixed) lets the rail sit exactly under it via `md:top-14`. */}
        <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b bg-background bg-gradient-to-r from-background to-primary/5 px-4 py-2 sm:px-6">
          <PortalHeader />
          {/* The label drops below `sm` (icon-only) so the row never wraps;
              `aria-label` keeps it named for screen readers. */}
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
              // `md:top-14` parks the rail under the sticky app bar. The rail
              // is taller than the viewport, so `max-h` + `overflow-y-auto`
              // make its tail reachable; `overscroll-contain` keeps the wheel
              // from scrolling the page behind it.
              className="border-b border-border pb-6 mb-6 md:sticky md:top-14 md:mb-0 md:max-h-[calc(100svh-3.5rem)] md:self-start md:overflow-y-auto md:overscroll-contain md:border-b-0 md:border-r md:py-6 md:pr-6"
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
                // The first document is the page's single <h1>; the rest are
                // <h2>.
                const DocHeading = index === 0 ? 'h1' : 'h2';
                return (
                  <div key={d}>
                    {index > 0 && <hr className="mt-11 border-t border-border" />}
                    <DocHeading
                      id={docHeadingId(d)}
                      className={cn(
                        'text-2xl font-bold text-foreground scroll-mt-20',
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
                            className="mt-8 mb-2 text-lg font-semibold text-foreground scroll-mt-20"
                          >
                            {section.heading}
                          </h2>
                          {section.body && <Markdown>{section.body}</Markdown>}
                        </div>
                      ) : (
                        <div key={section.id}>
                          <h3
                            id={section.id}
                            className="mt-6 mb-2 text-base font-semibold text-foreground scroll-mt-20"
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
