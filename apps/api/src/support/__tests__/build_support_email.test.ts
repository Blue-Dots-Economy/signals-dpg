import { describe, it, expect, vi, beforeEach } from 'vitest';

// node:crypto's randomBytes is mocked so the modulo-bias guard below can feed
// exact byte sequences. ESM namespaces are not configurable, so vi.spyOn cannot
// reach it — the module has to be mocked, hoisted above the import under test.
const { randomBytesMock } = vi.hoisted(() => ({ randomBytesMock: vi.fn() }));
vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  randomBytes: (...args: unknown[]) => randomBytesMock(...args),
}));

import { buildSupportDetailsTable, generateSupportReference } from '../build_support_email';

// Default: ordinary random bytes, which is all the shape/uniqueness tests need.
beforeEach(() => {
  randomBytesMock.mockReset();
  randomBytesMock.mockImplementation((n: number) =>
    Buffer.from(Array.from({ length: n }, () => Math.floor(Math.random() * 256))),
  );
});

const base = {
  reference: 'SUP-20260709-AB12CD',
  name: 'Asha K',
  email: 'asha@example.com' as string | null,
  phone: '+919000000000' as string | null,
  submittedAt: '2026-07-09T10:00:00.000Z',
};

describe('buildSupportDetailsTable', () => {
  it('includes the reference, contact fields, submitted-at and consent row', () => {
    const html = buildSupportDetailsTable(base);
    expect(html).toContain('Contact details');
    expect(html).toContain('SUP-20260709-AB12CD');
    expect(html).toContain('Asha K');
    expect(html).toContain('asha@example.com');
    expect(html).toContain('+919000000000');
    expect(html).toContain('2026-07-09T10:00:00.000Z');
    expect(html).toContain('Consent to share contact');
    expect(html).toContain('Yes');
  });

  it('renders — for missing email/phone', () => {
    const html = buildSupportDetailsTable({ ...base, email: null, phone: null });
    expect(html).toContain('—');
  });

  it('HTML-escapes user-supplied name', () => {
    const html = buildSupportDetailsTable({ ...base, name: 'A<b>C' });
    expect(html).not.toContain('<b>C');
    expect(html).toContain('A&lt;b&gt;C');
  });

  it('HTML-escapes contact fields', () => {
    const html = buildSupportDetailsTable({
      ...base,
      email: '<script>alert(1)</script>@example.com',
    });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });
});

describe('generateSupportReference', () => {
  it('produces SUP-YYYYMMDD-XXXXXX using the UTC date', () => {
    const ref = generateSupportReference(new Date('2026-07-09T23:59:59.000Z'));
    expect(ref).toMatch(/^SUP-20260709-[2-9A-HJ-NP-Z]{6}$/);
  });

  it('is (practically) unique across calls', () => {
    const now = new Date('2026-07-09T00:00:00.000Z');
    const refs = new Set(Array.from({ length: 50 }, () => generateSupportReference(now)));
    expect(refs.size).toBeGreaterThan(1);
  });

  // Regression guard for the modulo bias fixed under #550. The alphabet is 31
  // characters, so bytes 248..255 are exactly the ones a plain `% 31` would
  // fold back onto indices 0..7 ('2'..'9'). They must be discarded, not used.
  it('discards the biased byte tail rather than folding it onto 2-9', () => {
    const draws = [
      Buffer.from([248, 249, 250, 251, 252, 253]), // all rejected
      Buffer.from([255, 254, 250, 248, 249, 251]), // all rejected
      Buffer.from([0, 1, 2, 3, 4, 5]), // accepted -> '2','3','4','5','6','7'
    ];
    let call = 0;
    randomBytesMock.mockImplementation((n: number) =>
      (draws[call++] ?? Buffer.alloc(n)).subarray(0, n),
    );

    expect(generateSupportReference(new Date('2026-07-09T00:00:00.000Z'))).toBe(
      'SUP-20260709-234567',
    );
  });
});
