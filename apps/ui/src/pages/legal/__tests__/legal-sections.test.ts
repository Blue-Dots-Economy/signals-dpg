import { describe, it, expect } from 'vitest';
import { extractSections } from '@/pages/legal/legal-sections';

describe('extractSections', () => {
  it('pulls level-2 and level-3 headings in document order', () => {
    const md = '## Privacy Policy\nintro\n### What we collect\nbody\n### Retention\nbody';
    expect(extractSections(md)).toEqual([
      { id: 'privacy-policy', heading: 'Privacy Policy', level: 2 },
      { id: 'what-we-collect', heading: 'What we collect', level: 3 },
      { id: 'retention', heading: 'Retention', level: 3 },
    ]);
  });

  it('ignores headings inside fenced code blocks', () => {
    const md = '## Real\n```\n## Not a heading\n```\n### Also real';
    expect(extractSections(md).map((s) => s.heading)).toEqual(['Real', 'Also real']);
  });

  it('deduplicates colliding ids when a single document repeats a heading', () => {
    const md = '### Grievances\na\n### Grievances\nb';
    expect(extractSections(md).map((s) => s.id)).toEqual(['grievances', 'grievances-2']);
  });

  it('returns an empty list for content with no headings', () => {
    expect(extractSections('Just a sentence.')).toEqual([]);
  });
});
