import { Link } from 'react-router-dom';
import { LogIn } from 'lucide-react';
import { NetworkConstellation } from './network-constellation';
import { useNetworkTheme } from '@/theme/theme-provider';

export function GuestHero() {
  const { theme } = useNetworkTheme();

  return (
    <div className="relative mb-6 overflow-hidden rounded-xl bg-brand-hero min-h-[200px] lg:min-h-[240px]">
      {/* Constellation — fades in from the right on large screens, full-cover on small */}
      <div className="pointer-events-none absolute inset-0 opacity-[0.18] lg:opacity-25">
        <NetworkConstellation className="h-full w-full" />
      </div>

      {/* Left vignette — keeps text legible over the constellation */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-black/50 via-black/20 to-transparent" />

      {/* Content */}
      <div className="relative z-10 flex flex-col items-start justify-center gap-3 px-6 py-10 lg:px-10 lg:py-14 max-w-xl">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/45">
          {theme.portalLabel}
        </p>

        <h2 className="text-2xl font-bold leading-snug text-white/90 lg:text-3xl">
          {theme.tagline.lead}{' '}
          <span className="text-brand-hero-highlight">{theme.tagline.highlight}</span>
          {theme.tagline.tail ? ` ${theme.tagline.tail}` : ''}
        </h2>

        <p className="text-sm text-white/55 leading-relaxed max-w-sm">{theme.subline}</p>

        <Link
          to="/auth/login"
          className="mt-1 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold shadow-lg transition-all hover:brightness-110 active:scale-95 bg-brand-cta"
        >
          <LogIn className="h-4 w-4" />
          Sign in to connect
        </Link>
      </div>

      {/* Stat strip — hidden when stats array is empty (populated via API later) */}
      {theme.stats.length > 0 && (
        <div className="relative z-10 flex flex-wrap gap-x-6 gap-y-2 border-t border-white/10 px-6 py-3 lg:px-10">
          {theme.stats.map((stat) => (
            <div key={stat.label} className="flex items-baseline gap-1.5">
              <span className="text-sm font-bold text-brand-stat">{stat.value}</span>
              <span className="text-[11px] text-white/40">{stat.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
