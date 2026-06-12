import { NetworkConstellation } from '@/components/layout/network-constellation';

/**
 * Tourist banner — the same visual treatment as the signals GuestHero
 * (brand-hero gradient + faint constellation + legibility vignette, highlight in
 * the brand-hero-highlight colour) but WITHOUT the sign-in CTA, since the
 * tourist app is login-free. The copy is hardcoded (rather than read from the
 * network theme, which defaults to blue_dot's "Seeker & Provider Portal…" in the
 * tourist context); the colours come from the orange_dot brand CSS vars, so the
 * gradient and highlight match the orange_dot banner used in signals.
 */
export function TouristHero() {
  return (
    <div className="relative shrink-0 overflow-hidden bg-brand-hero shadow-md">
      {/* Constellation — faint backdrop. */}
      <div className="pointer-events-none absolute inset-0 opacity-[0.18]">
        <NetworkConstellation className="h-full w-full" />
      </div>
      {/* Vignette — keeps text legible over the constellation. */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-black/55 via-black/25 to-transparent" />

      <div className="relative z-10 px-4 py-2 sm:px-6 sm:py-4">
        <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-white/50 sm:text-[10px]">
          Tourism &amp; Culture Portal
        </p>
        <h2 className="text-[12.5px] font-bold leading-tight text-white/95 sm:text-base lg:text-lg">
          Discovering{' '}
          <span className="text-brand-hero-highlight">curated experiences</span> and{' '}
          <span className="text-brand-hero-highlight">verified locals</span> for every
          traveller exploring.
        </h2>
        <p className="mt-0.5 text-[10px] leading-snug text-white/65 sm:mt-1 sm:text-xs lg:max-w-3xl">
          A unified tourism, arts &amp; culture network connecting travellers to
          verified practitioners and authentic curated experiences — every
          orange dot is a guide, an artisan, a stay, an experience worth finding.
        </p>
      </div>
    </div>
  );
}
