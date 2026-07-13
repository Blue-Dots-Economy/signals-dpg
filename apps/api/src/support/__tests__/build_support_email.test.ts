import { describe, it, expect } from 'vitest';
import { buildSupportEmail, generateSupportReference } from '../build_support_email';

const base = {
  type: 'complaint' as const,
  name: 'Asha K',
  email: 'asha@example.com',
  phone: '+919000000000',
  details: 'My profile broke',
  reference: 'SUP-20260709-AB12CD',
  teamName: 'Blue Dot',
  submittedAt: '2026-07-09T10:00:00.000Z',
};

describe('buildSupportEmail', () => {
  it('builds the subject with reference, type label, name and link', () => {
    const { subject } = buildSupportEmail({ ...base, linkBaseUrl: 'https://blue.example.org' });
    expect(subject).toBe(
      'Issue Number: SUP-20260709-AB12CD — Complaint from Asha K from https://blue.example.org'
    );
  });

  it('omits the trailing link when no linkBaseUrl is given', () => {
    const { subject } = buildSupportEmail(base);
    expect(subject).toBe('Issue Number: SUP-20260709-AB12CD — Complaint from Asha K');
  });

  it('uses "Support Request" as the type label for support_request', () => {
    const { subject, html } = buildSupportEmail({ ...base, type: 'support_request' });
    expect(subject).toContain('Support Request from Asha K');
    expect(html).toContain('Support Request has been raised by Asha K');
  });

  it('includes details, contact block, reference, consent and team sign-off in the html', () => {
    const { html } = buildSupportEmail(base);
    expect(html).toContain('The below Complaint has been raised by Asha K');
    expect(html).toContain('My profile broke');
    expect(html).toContain('asha@example.com');
    expect(html).toContain('+919000000000');
    expect(html).toContain('SUP-20260709-AB12CD');
    expect(html).toContain('Consent to share contact');
    expect(html).toContain('Yes');
    expect(html).toContain('Team Blue Dot');
  });

  it('renders — for missing email/phone', () => {
    const { html } = buildSupportEmail({ ...base, email: null, phone: null });
    expect(html).toContain('—');
  });

  it('HTML-escapes user-supplied details and name', () => {
    const { html } = buildSupportEmail({
      ...base,
      details: '<script>alert(1)</script>',
      name: 'A<b>C',
    });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('A&lt;b&gt;C');
  });

  it('flattens newlines in the subject so they cannot inject headers', () => {
    const { subject } = buildSupportEmail({ ...base, name: 'line1\nline2' });
    expect(subject).toBe('Issue Number: SUP-20260709-AB12CD — Complaint from line1 line2');
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
