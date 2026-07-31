import { useNetworkTheme } from '@/theme/theme-provider';
import { NetworkConstellation } from './network-constellation';

export function BrandHero() {
  const { theme } = useNetworkTheme();

  return (
    <div className="bg-brand-hero relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between lg:p-12">
      {/* Constellation illustration */}
      <NetworkConstellation className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-60" />

      {/* Content stack */}
      <div className="relative z-10 flex-1 flex flex-col justify-center py-12">
        <div className="max-w-md">
          <h1 className="mb-4 text-4xl font-bold leading-tight text-white xl:text-5xl">
            {theme.tagline.lead}{' '}
            <span className="text-brand-hero-highlight">{theme.tagline.highlight}</span>{' '}
            {theme.tagline.tail}
          </h1>
          <p className="text-base leading-relaxed text-white/70">{theme.subline}</p>
        </div>
      </div>

      {/* Stat counters — hidden when stats array is empty (populated via API later) */}
      {theme.stats.length > 0 && (
        <div className="relative z-10 grid grid-cols-2 gap-4 border-t border-white/10 pt-8 sm:grid-cols-4">
          {theme.stats.map((stat) => (
            <div key={stat.label}>
              <p className="text-brand-stat text-2xl font-bold leading-none">{stat.value}</p>
              <p className="mt-1 text-xs text-white/60">{stat.label}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
