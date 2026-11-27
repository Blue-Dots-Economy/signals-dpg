/**
 * Pulls the section list out of a consent document's Markdown so the public
 * legal page can build a contents rail and anchor each heading.
 */

/** One entry in the contents rail. */
export interface LegalSection {
  id: string;
  heading: string;
  level: 2 | 3;
}

/** Converts a heading to a lowercase, hyphenated, URL-safe anchor id. */
function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('-');
}

/**
 * Extracts `##` and `###` headings in document order, skipping fenced code
 * blocks. Colliding slugs within one document get a numeric suffix;
 * cross-document collisions are handled by the legal page.
 */
export function extractSections(markdown: string): LegalSection[] {
  const out: LegalSection[] = [];
  const seen = new Map<string, number>();
  let inFence = false;

  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const m = /^(#{2,3})\s/.exec(trimmed);
    if (!m) continue;

    const heading = trimmed.slice(m[1]!.length).trim();
    const base = slugify(heading);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);

    out.push({
      id: count === 1 ? base : `${base}-${count}`,
      heading,
      level: m[1]!.length === 2 ? 2 : 3,
    });
  }
  return out;
}
