import { describe, it, expect } from 'vitest';
import { buildSupportEmail } from '../build_support_email';

const submitter = {
  name: 'Asha K',
  email: 'asha@example.com',
  phone: '+919000000000',
  userId: 'user-123',
  network: 'blue_dot',
};

describe('buildSupportEmail', () => {
  it('uses the provided subject in the subject line', () => {
    const { subject } = buildSupportEmail({
      subject: 'Cannot log in',
      message: 'It fails',
      submitter,
      submittedAt: '2026-07-09T10:00:00.000Z',
    });
    expect(subject).toBe('[Support] Cannot log in — Asha K');
  });

  it('falls back to a default subject when none given', () => {
    const { subject } = buildSupportEmail({
      message: 'hi',
      submitter,
      submittedAt: '2026-07-09T10:00:00.000Z',
    });
    expect(subject).toBe('[Support] New support request — Asha K');
  });

  it('includes the message and every submitter detail in the html', () => {
    const { html } = buildSupportEmail({
      message: 'My profile broke',
      submitter,
      submittedAt: '2026-07-09T10:00:00.000Z',
    });
    expect(html).toContain('My profile broke');
    expect(html).toContain('Asha K');
    expect(html).toContain('asha@example.com');
    expect(html).toContain('+919000000000');
    expect(html).toContain('user-123');
    expect(html).toContain('blue_dot');
    expect(html).toContain('2026-07-09T10:00:00.000Z');
  });

  it('HTML-escapes user-supplied message and name', () => {
    const { html } = buildSupportEmail({
      message: '<script>alert(1)</script>',
      submitter: { ...submitter, name: 'A<b>C' },
      submittedAt: '2026-07-09T10:00:00.000Z',
    });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('A&lt;b&gt;C');
  });

  it('strips newlines from the subject and renders — for missing email/phone', () => {
    const { subject, html } = buildSupportEmail({
      subject: 'line1\nline2',
      message: 'x',
      submitter: { ...submitter, email: null, phone: null },
      submittedAt: '2026-07-09T10:00:00.000Z',
    });
    expect(subject).toBe('[Support] line1 line2 — Asha K');
    expect(html).toContain('—');
  });
});
