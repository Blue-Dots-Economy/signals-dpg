import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('schema-form responsive layout', () => {
  it('schema-form two-field rows are responsive (grid-cols-1 sm:grid-cols-2)', () => {
    const src = readFileSync(join(__dirname, '..', 'schema-form.tsx'), 'utf8');
    expect(src).not.toMatch(/className="grid grid-cols-2 gap-3"/);
    expect(src).toMatch(/grid-cols-1 sm:grid-cols-2/);
  });
});
