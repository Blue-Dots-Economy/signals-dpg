import { describe, it, expect } from 'vitest';
import { buildSupportDetailsTable, generateSupportReference } from '../build_support_email';

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
});
