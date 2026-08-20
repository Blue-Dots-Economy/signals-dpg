import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => d ?? k }),
}));
vi.mock('../brand-hero', () => ({ BrandHero: () => null }));
vi.mock('../portal-header', () => ({ PortalHeader: () => null }));
vi.mock('../auth-footer', () => ({ AuthFooter: () => null }));
vi.mock('../language-switcher', () => ({
  LanguageSwitcher: () => <div data-testid="language-switcher" />,
}));
vi.mock('../theme-mode-toggle', () => ({
  ThemeModeToggle: () => <div data-testid="theme-toggle" />,
}));

const { AuthShell } = await import('../auth-shell');

describe('AuthShell', () => {
  it('offers language and theme controls', () => {
    // The auth pages have no top bar, so without these a visitor had to sign
    // in before they could switch language — backwards for the one screen
    // where they may not read the default language.
    render(<AuthShell>content</AuthShell>);
    expect(screen.getAllByTestId('language-switcher').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('theme-toggle').length).toBeGreaterThan(0);
  });

  it('still renders its children', () => {
    render(<AuthShell><p>form goes here</p></AuthShell>);
    expect(screen.getByText('form goes here')).toBeTruthy();
  });
});
