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
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { LanguageSwitcher } from '@/components/layout/language-switcher';
import { ThemeModeToggle } from '@/components/layout/theme-mode-toggle';
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
  useEffect(() => {
    if (!contentReady) return;
    const hashId = location.hash ? decodeURIComponent(location.hash.slice(1)) : null;
    const targetId = hashId ?? (doc !== DOC_ORDER[0] ? docHeadingId(doc) : null);
    if (!targetId) return;
    const el = document.getElementById(targetId);
    if (!el) return;
    el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    setActiveId(targetId);
  }, [location.hash, contentReady, doc]);

  // Scroll-spy: the rail's highlight follows whichever heading is currently
  // in view. `happy-dom` (the test environment) provides a stub
  // `IntersectionObserver` that never actually fires — fine here, since
  // clicking a rail entry sets `activeId` directly (below) and tests cover
  // that path instead.
  useEffect(() => {
    if (!contentReady || spyTargetIds.length === 0) return;
    const elements = spyTargetIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        for (let i = elements.length - 1; i >= 0; i -= 1) {
          if (visible.has(elements[i]!.id)) {
            setActiveId(elements[i]!.id);
            break;
          }
        }
      },
      { rootMargin: '-15% 0px -75% 0px', threshold: 0 },
    );
    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the id list, not element identity
  }, [contentReady, spyTargetIds.join('|')]);

  function handleRailClick(id: string) {
    return (event: React.MouseEvent) => {
      event.preventDefault();
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
      }
      setActiveId(id);
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
    <div className="min-h-svh bg-background px-6 py-8">
      <div className="mx-auto max-w-5xl">
        {/* App bar: a way back to sign-in (someone can land here mid-signup
            with no other path back) plus the same language/theme controls
            the app's top bar carries, separated from the content by a rule. */}
        <div className="mb-8 flex items-center justify-between gap-4 border-b border-border pb-4">
          <Link
            to="/auth/login"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-muted-foreground transition-colors hover:text-primary"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {t('legal.back_to_sign_in')}
          </Link>
          <TooltipProvider>
            <div className="flex items-center gap-1">
              <LanguageSwitcher compact />
              <ThemeModeToggle />
            </div>
          </TooltipProvider>
        </div>

        <div className="grid gap-6 md:grid-cols-[236px_1fr] md:gap-10">
          <nav
            aria-label={t('legal.contents_label')}
            className="border-b border-border pb-6 mb-6 md:sticky md:top-6 md:mb-0 md:self-start md:border-b-0 md:border-r md:pb-0 md:pr-6"
          >
            {availableDocs.map(({ doc: d, version, sections }) => {
              const headingId = docHeadingId(d);
              const isActiveDoc =
                activeId === headingId || sections.some((s) => s.id === activeId);

              return (
                <div key={d} className={cn('mb-6', !isActiveDoc && 'opacity-75')}>
                  <a
                    href={`#${headingId}`}
                    onClick={handleRailClick(headingId)}
                    aria-current={isActiveDoc ? 'page' : undefined}
                    className={cn(
                      'block rounded-md px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.1em] transition-colors',
                      isActiveDoc
                        ? 'text-primary'
                        : 'text-muted-foreground hover:bg-muted hover:text-primary',
                    )}
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
  );
}
