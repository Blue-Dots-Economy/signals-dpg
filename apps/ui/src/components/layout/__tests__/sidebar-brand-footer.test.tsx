import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { BrandMeta } from '@/theme/brand-meta';
import { pickFooterLogo, SidebarBrandFooter } from '../sidebar-brand-footer';

const meta = (over: Partial<BrandMeta>): BrandMeta => ({
  faviconType: 'svg',
  logoShape: 'lockup',
  copy: {},
  footerLogo: null,
  footerLogoLight: null,
  ...over,
});

describe('pickFooterLogo', () => {
  it('returns the default logo in light mode', () => {
    expect(pickFooterLogo(meta({ footerLogo: '/a.png', footerLogoLight: '/b.png' }), false)).toBe('/a.png');
  });
  it('prefers the light variant in dark mode', () => {
    expect(pickFooterLogo(meta({ footerLogo: '/a.png', footerLogoLight: '/b.png' }), true)).toBe('/b.png');
  });
  it('falls back to the default in dark mode when no light variant', () => {
    expect(pickFooterLogo(meta({ footerLogo: '/a.png' }), true)).toBe('/a.png');
  });
  it('returns null when no footer logo is configured', () => {
    expect(pickFooterLogo(meta({}), false)).toBeNull();
    expect(pickFooterLogo(meta({}), true)).toBeNull();
  });
});

const theme = vi.hoisted(() => ({ themeId: 'blue_dot', brand: 'standard', resolved: 'light' as 'light' | 'dark' }));
const brandMeta = vi.hoisted(() => ({ value: null as BrandMeta | null }));

vi.mock('@/theme/theme-provider', () => ({
  useNetworkTheme: () => ({ themeId: theme.themeId, theme: { name: 'Blue' }, brand: theme.brand }),
}));
vi.mock('@/theme/mode-provider', () => ({
  useThemeMode: () => ({ resolved: theme.resolved }),
}));
vi.mock('@/theme/brand-meta', () => ({
  resolveBrandMeta: () => brandMeta.value,
}));

describe('SidebarBrandFooter', () => {
  beforeEach(() => {
    theme.resolved = 'light';
    brandMeta.value = meta({});
  });

  it('renders nothing when no footer logo is configured', () => {
    brandMeta.value = meta({});
    const { container } = render(<SidebarBrandFooter />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the configured footer logo (light mode → default)', () => {
    brandMeta.value = meta({ footerLogo: '/brand/ekstep.png', footerLogoLight: '/brand/ekstep-light.png' });
    render(<SidebarBrandFooter />);
    const img = screen.getByRole('presentation', { hidden: true });
    expect(img).toHaveAttribute('src', '/brand/ekstep.png');
  });

  it('uses the light variant in dark mode', () => {
    theme.resolved = 'dark';
    brandMeta.value = meta({ footerLogo: '/brand/ekstep.png', footerLogoLight: '/brand/ekstep-light.png' });
    render(<SidebarBrandFooter />);
    expect(screen.getByRole('presentation', { hidden: true })).toHaveAttribute('src', '/brand/ekstep-light.png');
  });
});
