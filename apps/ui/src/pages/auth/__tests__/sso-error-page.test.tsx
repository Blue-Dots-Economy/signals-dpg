import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';
import en from '@/i18n/locales/en.json';
import { SsoErrorPage } from '../sso-error-page';

vi.mock('@/components/layout/auth-shell', () => ({
  AuthShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const runtime = (config: Record<string, string>) => {
  (window as unknown as { __DPG_UI_CONFIG__?: Record<string, string> }).__DPG_UI_CONFIG__ =
    config;
};

const renderAt = (search: string) =>
  render(
    <MemoryRouter initialEntries={[`/auth/sso/error${search}`]}>
      <SsoErrorPage />
    </MemoryRouter>
  );

afterEach(() => {
  runtime({});
  void i18n.changeLanguage('en');
});

describe('SsoErrorPage', () => {
  it('explains a known reason', () => {
    renderAt('?reason=link-expired');
    expect(screen.getByText(en['auth.sso_error_link_expired'])).toBeInTheDocument();
  });

  it('shows the generic message for an unknown reason and never echoes it', () => {
    renderAt('?reason=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    expect(screen.getByText(en['auth.sso_error_unknown'])).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('script');
  });

  it('links back to the partner portal when one is configured', () => {
    runtime({ VITE_SSO_PARTNER_URL: 'https://www.ncs.gov.in', VITE_SSO_PARTNER_NAME: 'NCS' });
    renderAt('?reason=link-reused');
    const link = screen.getByRole('link', { name: 'Back to NCS' });
    expect(link).toHaveAttribute('href', 'https://www.ncs.gov.in');
  });

  it('offers no partner link when none is configured', () => {
    renderAt('?reason=link-reused');
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByRole('button', { name: en['auth.sso_go_home'] })).toBeInTheDocument();
  });

  it('has every reason translated in every shipped locale', async () => {
    const reasons = [
      'link_invalid',
      'link_expired',
      'link_reused',
      'provider_unavailable',
      'account_inactive',
      'phone_unverified',
      'link_conflict',
      'session_expired',
      'unknown',
    ];
    for (const lng of ['en', 'hi']) {
      const bundle = (await import(`@/i18n/locales/${lng}.json`)).default as Record<string, string>;
      for (const r of reasons) expect(bundle[`auth.sso_error_${r}`], `${lng} ${r}`).toBeTruthy();
    }
  });
});
