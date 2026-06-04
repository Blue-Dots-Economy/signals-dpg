import { Link } from 'react-router-dom';
import { LogIn } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NetworkConstellation } from './network-constellation';
import { useNetworkTheme } from '@/theme/theme-provider';

export function GuestHero() {
  const { theme } = useNetworkTheme();
  const { t } = useTranslation();

  return (
    <div className="sticky top-0 z-30 -mx-4 mb-4 sm:-mx-6">
      <div className="relative overflow-hidden bg-brand-hero shadow-lg sm:mx-4 sm:rounded-xl lg:mx-6">
        {/* Constellation — faint backdrop; compact banner doesn't need full cover */}
        <div className="pointer-events-none absolute inset-0 opacity-[0.18]">
          <NetworkConstellation className="h-full w-full" />
        </div>

        {/* Vignette — keeps text legible over the constellation */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-black/55 via-black/25 to-transparent" />

        {/* Content row: portal label + tagline on the left, CTA on the right */}
        <div className="relative z-10 flex items-center gap-4 px-5 py-3 sm:px-7 sm:py-4 lg:px-10">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/50">
              {theme.portalLabel}
            </p>
            <h2 className="truncate text-sm font-bold leading-tight text-white/95 sm:text-base lg:text-lg">
              {theme.tagline.lead}{' '}
              <span className="text-brand-hero-highlight">{theme.tagline.highlight}</span>
              {theme.tagline.tail ? ` ${theme.tagline.tail}` : ''}
            </h2>
            <p className="mt-1 hidden text-[11px] leading-snug text-white/55 sm:line-clamp-1 sm:text-xs lg:line-clamp-2 lg:max-w-2xl">
              {theme.subline}
            </p>
          </div>

          <Link
            to="/auth/login"
            className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-brand-cta px-3.5 py-2 text-xs font-semibold shadow-md transition-all hover:brightness-110 active:scale-95 sm:px-5 sm:py-2.5 sm:text-sm"
          >
            <LogIn className="h-4 w-4" />
            <span className="hidden sm:inline">{t('nav.sign_in_to_connect')}</span>
            <span className="sm:hidden">{t('nav.sign_in')}</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
