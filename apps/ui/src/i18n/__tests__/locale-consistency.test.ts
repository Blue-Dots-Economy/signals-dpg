import { describe, it, expect } from 'vitest';

const locales = import.meta.glob<Record<string, unknown>>('../locales/*.json', { eager: true, import: 'default' });

describe('locale consistency', () => {
  const en = locales['../locales/en.json']!;
  it.each(Object.entries(locales))('%s: the expired-code hint names the Resend button as labelled', (_path, strings) => {
    // Keys are flat (keySeparator: false), so only a flat key reaches the button.
    const resend = (strings['u18.otp_resend'] ?? en['u18.otp_resend']) as string;
    expect(strings['u18.otp_error_expired_desc']).toContain(`"${resend}"`);
  });
});
