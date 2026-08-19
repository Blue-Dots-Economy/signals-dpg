import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { LogoShape } from '@/theme/brand-meta';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock('@/theme/theme-provider', () => ({
  useNetworkTheme: () => ({ themeId: 'blue_dot', theme: { name: 'Blue Dots' }, brand: 'up-gzb' }),
}));
vi.mock('@/theme/mode-provider', () => ({ useThemeMode: () => ({ resolved: 'light' }) }));
vi.mock('@/theme/brand-assets', () => ({
  brandLogoUrl: () => '/brand/blue-dot/up-gzb/logo.png',
  networkLogoUrl: () => '/brand/blue-dot/logo.png',
}));

let shape: LogoShape = 'wordmark';
vi.mock('@/theme/brand-meta', () => ({
  resolveBrandMeta: () => ({ logoShape: shape, faviconType: 'svg', copy: {} }),
}));

const { PortalHeader } = await import('../portal-header');

function heightClassOf(): string {
  const cls = screen.getByRole('img').className;
  return cls.split(' ').find((c) => c.startsWith('h-')) ?? '';
}

describe('PortalHeader logo sizing by shape', () => {
  it('renders a lockup taller than a wordmark', () => {
    // The up-gzb mark is a wordmark stacked over a "Seeded by …" strapline
    // (~3:1). At wordmark height that strapline is unreadable in the sidebar.
    shape = 'wordmark';
    const { unmount } = render(<PortalHeader />);
    const wordmarkH = Number(heightClassOf().replace('h-', ''));
    unmount();

    shape = 'lockup';
    render(<PortalHeader />);
    const lockupH = Number(heightClassOf().replace('h-', ''));

    expect(lockupH).toBeGreaterThan(wordmarkH);
  });

  it('keeps a lockup no taller than a square mark', () => {
    shape = 'square';
    const { unmount } = render(<PortalHeader />);
    const squareH = Number(heightClassOf().replace('h-', ''));
    unmount();

    shape = 'lockup';
    render(<PortalHeader />);
    expect(Number(heightClassOf().replace('h-', ''))).toBeLessThanOrEqual(squareH);
  });

  it('still sizes the existing wordmark brands exactly as before', () => {
    shape = 'wordmark';
    render(<PortalHeader />);
    expect(screen.getByRole('img').className).toContain('h-7');
  });
});
