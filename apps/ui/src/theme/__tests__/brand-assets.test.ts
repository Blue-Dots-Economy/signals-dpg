import { describe, it, expect } from 'vitest';
import { brandLogoUrl, networkLogoUrl } from '../brand-assets';

describe('brandLogoUrl', () => {
  it('network path when no brand', () => {
    expect(brandLogoUrl('blue_dot')).toBe('/brand/blue-dot/logo.png');
  });
  it('network path for standard brand', () => {
    expect(brandLogoUrl('blue_dot', 'default', 'standard')).toBe('/brand/blue-dot/logo.png');
  });
  it('brand path for real brand', () => {
    expect(brandLogoUrl('blue_dot', 'default', 'upsdm')).toBe('/brand/blue-dot/upsdm/logo.png');
  });
  it('brand path honours variant', () => {
    expect(brandLogoUrl('blue_dot', 'light', 'upsdm')).toBe('/brand/blue-dot/upsdm/logo-light.png');
  });
  it('null for empty network', () => {
    expect(brandLogoUrl('')).toBeNull();
  });
  it('networkLogoUrl returns network path', () => {
    expect(networkLogoUrl('blue_dot', 'light')).toBe('/brand/blue-dot/logo-light.png');
  });
});
