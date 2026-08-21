/**
 * Pulls the section list out of a consent document's Markdown so the public
 * legal page can build a contents rail and anchor each heading.
 *
 * Ported from the sibling aggregator repo's Task 9 plan — no framework
 * dependency there either, so nothing needed to change beyond this comment.
 *
 * @module apps/ui/src/pages/legal/legal-sections
 */

/** One entry in the contents rail. */
export interface LegalSection {
  id: string;
  heading: string;
  level: 2 | 3;
}

/**
 * Converts a heading to a URL-safe anchor id.
 *
 * @param heading - Raw heading text.
 * @returns Lowercase hyphenated slug.
 */
function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Extracts `##` and `###` headings in document order.
 *
 * Fenced code blocks are skipped so a `#` inside an example is not mistaken
 * for a heading. Colliding slugs get a numeric suffix — defensive: dedup is
 * scoped to a single call, so it only guards against one document repeating
 * a heading (e.g. two "FAQ" subsections), not against two different
 * documents sharing a heading name, which this function never sees at the
 * same time anyway.
 *
 * @param markdown - The document body.
 * @returns Sections in order; empty when the document has no headings.
 */
export function extractSections(markdown: string): LegalSection[] {
  const out: LegalSection[] = [];
  const seen = new Map<string, number>();
  let inFence = false;

  for (const line of markdown.split('\n')) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = /^(#{2,3})\s+(.*)$/.exec(line.trim());
    if (!match) continue;

    const heading = match[2]!.trim();
    const base = slugify(heading);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);

    out.push({
      id: count === 1 ? base : `${base}-${count}`,
      heading,
      level: match[1]!.length === 2 ? 2 : 3,
    });
  }
  return out;
}
