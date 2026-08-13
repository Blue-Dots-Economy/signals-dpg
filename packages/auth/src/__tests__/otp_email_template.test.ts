import { describe, expect, it } from 'vitest';
import { emailOtpHtmlTemplate } from '../templates/otp_email';
import type { UserWithPhoneNumber } from '../../plugins/unified_otp';

const userWithName = (name: string) =>
  ({ id: 'u1', name, email: 'a@b.co' }) as unknown as UserWithPhoneNumber;

describe('emailOtpHtmlTemplate', () => {
  it('embeds the OTP, the app name and the 5-minute validity notice', () => {
    const html = emailOtpHtmlTemplate('135790', userWithName('Alice'), 'Signals');
    expect(html).toContain('135790');
    expect(html).toContain('<b>Signals</b>');
    expect(html).toContain('This OTP is valid for 5 minutes.');
    expect(html).toContain('Do not share it with anyone.');
  });

  it('lower-cases the stored name and relies on CSS to re-capitalize it', () => {
    const html = emailOtpHtmlTemplate('000000', userWithName('ALICE COOPER'), 'App');
    expect(html).toContain('>alice cooper<');
    expect(html).not.toContain('ALICE COOPER');
    expect(html).toContain('text-transform: capitalize;');
  });

  it('renders the sign-in copy for an existing user', () => {
    const html = emailOtpHtmlTemplate('111111', userWithName('Bob'), 'App');
    expect(html).toContain('<strong>sign in</strong>');
    expect(html).not.toContain('sign up');
  });

  it('renders the sign-up copy and a generic greeting for a new (null) user', () => {
    const html = emailOtpHtmlTemplate('222222', null, 'App');
    expect(html).toContain('<strong>sign up</strong>');
    expect(html).not.toContain('sign in');
    expect(html).toContain('>user<');
  });

  it('falls back to the generic greeting when the user row has an empty name', () => {
    const html = emailOtpHtmlTemplate('333333', userWithName(''), 'App');
    expect(html).toContain('>user<');
    // The user still exists, so the copy stays "sign in".
    expect(html).toContain('<strong>sign in</strong>');
  });

  it('interpolates the app name into the body without escaping it', () => {
    const html = emailOtpHtmlTemplate('444444', null, 'Blue <Dots>');
    expect(html).toContain('<b>Blue <Dots></b>');
  });

  it('renders an empty OTP slot rather than throwing when the OTP is empty', () => {
    const html = emailOtpHtmlTemplate('', null, 'App');
    expect(html).toContain('Do not share it with anyone.');
    expect(html).toMatch(/">\s*<\/div>/);
  });

  it('throws when a non-null user row carries no name (optional chaining stops at `user`, not `name`)', () => {
    const nameless = { id: 'u2' } as unknown as UserWithPhoneNumber;
    expect(() => emailOtpHtmlTemplate('555555', nameless, 'App')).toThrow(
      TypeError
    );
  });
});
