import { describe, expect, it } from 'vitest';

import { DEFAULT_BRAND_COLOR, buildCtaUrl, resolveBrandColor, resolveBrandName } from '../brand';

describe('buildCtaUrl', () => {
  it('appends /auth/login to the base url', () => {
    expect(buildCtaUrl('https://app.example.com')).toBe(
      'https://app.example.com/auth/login',
    );
  });

  it('does not double the slash when the base has a trailing slash', () => {
    expect(buildCtaUrl('https://app.example.com/')).toBe(
      'https://app.example.com/auth/login',
    );
  });
});

describe('resolveBrandName', () => {
  it('prefers the network display name when present', () => {
    expect(
      resolveBrandName({ networkDisplayName: 'Blue Dot', instanceName: 'blue_dot_api' }),
    ).toBe('Blue Dot');
  });

  it('falls back to the instance name when no display name', () => {
    expect(resolveBrandName({ instanceName: 'blue_dot_api' })).toBe('blue_dot_api');
  });

  it('treats a blank display name as absent', () => {
    expect(
      resolveBrandName({ networkDisplayName: '   ', instanceName: 'blue_dot_api' }),
    ).toBe('blue_dot_api');
  });
});

describe('resolveBrandColor', () => {
  it('returns the network brand colour', () => {
    expect(resolveBrandColor('blue_dot')).toBe('#2563eb');
    expect(resolveBrandColor('green_dot')).toBe('#16a34a');
    expect(resolveBrandColor('orange_dot')).toBe('#ea580c');
  });

  it('falls back to the default for unknown / missing networks', () => {
    expect(resolveBrandColor('mystery_dot')).toBe(DEFAULT_BRAND_COLOR);
    expect(resolveBrandColor(null)).toBe(DEFAULT_BRAND_COLOR);
  });
});
