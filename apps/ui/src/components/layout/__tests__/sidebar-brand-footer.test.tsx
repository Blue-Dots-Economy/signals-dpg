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
  footerAttribution: null,
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

  it('renders the attribution rows with labels and names (#720)', () => {
    brandMeta.value = meta({
      footerAttribution: [
        { label: 'Owned by', name: 'Swavalambhan' },
        { label: 'Managed by', name: 'ALIMCO', logo: '/brand/alimco-mark.png' },
      ],
    });
    render(<SidebarBrandFooter />);
    expect(screen.getByText('Owned by')).toBeInTheDocument();
    expect(screen.getByText('Swavalambhan')).toBeInTheDocument();
    expect(screen.getByText('Managed by')).toBeInTheDocument();
    expect(screen.getByText('ALIMCO')).toBeInTheDocument();
  });

  it('renders a letter tile for a party with no logo, and the mark for one with', () => {
    // The tile is the design's own placeholder for artwork that has not
    // arrived — not a loading state, and not a broken image.
    brandMeta.value = meta({
      footerAttribution: [
        { label: 'Owned by', name: 'Swavalambhan' },
        { label: 'Managed by', name: 'ALIMCO', logo: '/brand/alimco-mark.png' },
      ],
    });
    render(<SidebarBrandFooter />);
    expect(screen.getByText('S')).toBeInTheDocument();
    const imgs = screen.getAllByRole('presentation', { hidden: true });
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toHaveAttribute('src', '/brand/alimco-mark.png');
  });

  it('prefers each row\'s light logo in dark mode', () => {
    theme.resolved = 'dark';
    brandMeta.value = meta({
      footerAttribution: [
        { label: 'Managed by', name: 'ALIMCO', logo: '/a.png', logoLight: '/a-light.png' },
      ],
    });
    render(<SidebarBrandFooter />);
    expect(screen.getByRole('presentation', { hidden: true })).toHaveAttribute('src', '/a-light.png');
  });

  it('renders attribution even when no footerLogo is set', () => {
    // The two are independent opt-ins; requiring both would mean a brand that
    // wants only ownership captions gets nothing.
    brandMeta.value = meta({
      footerAttribution: [{ label: 'Owned by', name: 'Swavalambhan' }],
    });
    const { container } = render(<SidebarBrandFooter />);
    expect(container).not.toBeEmptyDOMElement();
    expect(screen.getByText('Swavalambhan')).toBeInTheDocument();
  });

  it('uses the light variant in dark mode', () => {
    theme.resolved = 'dark';
    brandMeta.value = meta({ footerLogo: '/brand/ekstep.png', footerLogoLight: '/brand/ekstep-light.png' });
    render(<SidebarBrandFooter />);
    expect(screen.getByRole('presentation', { hidden: true })).toHaveAttribute('src', '/brand/ekstep-light.png');
  });
});
