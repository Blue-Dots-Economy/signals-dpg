import { describe, it, expect, vi } from 'vitest';
import {
  detectPlatform,
  directionsUrl,
  telHref,
  normalizeWebsiteUrl,
  openDirections,
} from './directions';

describe('detectPlatform', () => {
  it('detects android', () => {
    expect(detectPlatform('Mozilla/5.0 (Linux; Android 13; Pixel)')).toBe('android');
  });
  it('detects ios', () => {
    expect(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe('ios');
    expect(detectPlatform('Mozilla/5.0 (iPad; CPU OS 17_0)')).toBe('ios');
  });
  it('falls back to other', () => {
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0)')).toBe('other');
  });
});

describe('directionsUrl', () => {
  const dest = { lat: 13.34, lng: 74.74 };
  it('android → geo: chooser URI with label', () => {
    expect(directionsUrl(dest, 'Cafe', 'android')).toBe('geo:13.34,74.74?q=13.34,74.74(Cafe)');
  });
  it('android without label omits the parenthetical', () => {
    expect(directionsUrl(dest, undefined, 'android')).toBe('geo:13.34,74.74?q=13.34,74.74');
  });
  it('ios → Apple Maps directions URL', () => {
    expect(directionsUrl(dest, 'Cafe', 'ios')).toBe('https://maps.apple.com/?daddr=13.34,74.74');
  });
  it('other → Google Maps directions URL', () => {
    expect(directionsUrl(dest, 'Cafe', 'other')).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=13.34,74.74',
    );
  });
  it('android encodes parentheses in the label', () => {
    expect(directionsUrl(dest, 'Cafe (Main)', 'android')).toBe('geo:13.34,74.74?q=13.34,74.74(Cafe%20%28Main%29)');
  });
});

describe('telHref', () => {
  it('prefixes +91 for a bare 10-digit number', () => {
    expect(telHref('9876543210')).toBe('tel:+919876543210');
  });
  it('keeps a number that already has a country code', () => {
    expect(telHref('+15551234567')).toBe('tel:+15551234567');
  });
  it('strips spaces/dashes and leaves non-10-digit numbers unprefixed', () => {
    expect(telHref('044 1234 5678')).toBe('tel:04412345678');
  });
  it('returns empty string for an empty/blank phone', () => {
    expect(telHref('')).toBe('');
    expect(telHref('   ')).toBe('');
  });
});

describe('normalizeWebsiteUrl', () => {
  it('adds https:// when no scheme', () => {
    expect(normalizeWebsiteUrl('example.com')).toBe('https://example.com');
  });
  it('keeps an existing scheme', () => {
    expect(normalizeWebsiteUrl('http://x.com')).toBe('http://x.com');
  });
  it('returns empty string for an empty/blank url', () => {
    expect(normalizeWebsiteUrl('')).toBe('');
    expect(normalizeWebsiteUrl('   ')).toBe('');
  });
});

describe('openDirections', () => {
  it('opens a new tab on desktop', () => {
    const open = vi.fn();
    const assign = vi.fn();
    const win = { navigator: { userAgent: 'Windows NT 10.0' }, open, location: { assign } } as unknown as Window;
    openDirections({ lat: 1, lng: 2 }, 'X', win);
    expect(open).toHaveBeenCalledWith('https://www.google.com/maps/dir/?api=1&destination=1,2', '_blank', 'noopener,noreferrer');
    expect(assign).not.toHaveBeenCalled();
  });
  it('navigates via location.assign on android', () => {
    const open = vi.fn();
    const assign = vi.fn();
    const win = { navigator: { userAgent: 'Android 13' }, open, location: { assign } } as unknown as Window;
    openDirections({ lat: 1, lng: 2 }, 'X', win);
    expect(assign).toHaveBeenCalledWith('geo:1,2?q=1,2(X)');
    expect(open).not.toHaveBeenCalled();
  });
});
