/**
 * Read-only public legal page: a contents rail listing both documents
 * (Privacy Policy and Terms of Service) alongside the reading column for
 * whichever one is current. No checkbox, no scroll gating, no consent
 * capture — that is the separate, landed `ConsentGateBody` surface.
 *
 * Signals has one audience (plus the `u18` variant, which this read-only
 * page does not surface), so unlike the sibling aggregator repo the rail
 * lists just the two documents and their sections — no audience grouping.
 */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { LanguageSwitcher } from '@/components/layout/language-switcher';
import { ThemeModeToggle } from '@/components/layout/theme-mode-toggle';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useConsentConfig } from '@/hooks/use-consent-config';
import { Markdown } from '@/components/consent/markdown';
import { cn } from '@/lib/utils';
import { extractSections, type LegalSection } from '@/pages/legal/legal-sections';

export type LegalDoc = 'privacy' | 'terms';

const ROUTE: Record<LegalDoc, string> = { privacy: '/privacy', terms: '/terms' };
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
 * own `<h1>` and give the rail a first entry that just repeats its own group
 * header. This checks the title specifically, not "is it the first heading"
 * — a document that legitimately opens with `## Overview` keeps that
 * section.
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
 * Sections for the rail: the document's own repeated title heading (see
 * `isDocumentTitleHeading`) is dropped so the rail's first entry under a
 * group header is a real section, not the header's own label again.
 */
function sectionsForRail(content: string, title: string): LegalSection[] {
  const sections = extractSections(content);
  const [leading] = sections;
  if (leading && isDocumentTitleHeading(leading.heading, title)) {
    return sections.slice(1);
  }
  return sections;
}

function getCurrentVersion(
  doc: { current_version: number; versions: ContentVersion[] } | undefined,
): ContentVersion | undefined {
  return doc?.versions.find((v) => v.version === doc.current_version);
}

/** Rail entry for one document's sections. Anchors in-page when it's the document being read, otherwise routes to the other document's page. */
function RailSections({
  doc,
  sections,
  isCurrent,
}: {
  doc: LegalDoc;
  sections: LegalSection[];
  isCurrent: boolean;
}) {
  return (
    <ul className="space-y-0.5">
      {sections.map((section) => (
        <li key={section.id}>
          {isCurrent ? (
            <a
              href={`#${section.id}`}
              className="block rounded-md py-1.5 pl-3 text-xs text-muted-foreground hover:bg-muted hover:text-primary"
            >
              {section.heading}
            </a>
          ) : (
            <Link
              to={`${ROUTE[doc]}#${section.id}`}
              className="block rounded-md py-1.5 pl-3 text-xs text-muted-foreground hover:bg-muted hover:text-primary"
            >
              {section.heading}
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Renders the shared layout for `/privacy` and `/terms`: loading state,
 * unavailable fallback, the language/theme controls the pages already
 * carried, the two-document contents rail, and the reading column.
 *
 * @param props.doc - Which document this route reads: `privacy` or `terms`.
 */
export function LegalDocumentView({ doc }: { doc: LegalDoc }): React.JSX.Element {
  const { t } = useTranslation();
  const { config, isLoading } = useConsentConfig();

  if (isLoading) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const version = getCurrentVersion(config?.documents[doc]);

  if (!version) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <p className="text-sm text-muted-foreground">
          {doc === 'privacy' ? 'Privacy policy unavailable.' : 'Terms of service unavailable.'}
        </p>
      </div>
    );
  }

  const { preamble, sections } = splitIntoSections(version.content, version.title);
  const effectiveDate = new Date(version.effective_from).toLocaleDateString();

  return (
    <div className="min-h-svh bg-background px-6 py-12">
      <div className="mx-auto max-w-5xl">
        {/* Same language + theme controls the app's top bar carries. These
            pages are reachable straight from the auth footer, so a visitor can
            land here before ever seeing the top bar. */}
        <TooltipProvider>
          <div className="mb-4 flex items-center justify-end gap-1">
            <LanguageSwitcher compact />
            <ThemeModeToggle />
          </div>
        </TooltipProvider>

        <div className="grid gap-6 md:grid-cols-[236px_1fr] md:gap-10">
          <nav
            aria-label="Contents"
            className="md:sticky md:top-6 md:self-start md:border-r md:border-border md:pr-6"
          >
            {DOC_ORDER.map((d) => {
              const docVersion = getCurrentVersion(config?.documents[d]);
              if (!docVersion) return null;
              const isCurrent = d === doc;
              const docSections = sectionsForRail(docVersion.content, docVersion.title);

              return (
                <div key={d} className={cn('mb-5', !isCurrent && 'opacity-60')}>
                  <Link
                    to={ROUTE[d]}
                    aria-current={isCurrent ? 'page' : undefined}
                    className={cn(
                      'block rounded-md px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide',
                      isCurrent
                        ? 'text-primary'
                        : 'text-muted-foreground hover:bg-muted hover:text-primary',
                    )}
                  >
                    {docVersion.title}
                  </Link>
                  <RailSections doc={d} sections={docSections} isCurrent={isCurrent} />
                </div>
              );
            })}
          </nav>

          <div className="min-w-0 max-w-[72ch]">
            <h1 className="text-2xl font-bold text-foreground">{version.title}</h1>
            <p className="mb-6 text-xs text-muted-foreground">
              {t('legal.version_effective', { version: version.version, date: effectiveDate })}
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
        </div>
      </div>
    </div>
  );
}
