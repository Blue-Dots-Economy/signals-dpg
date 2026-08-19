import { BrandHero } from './brand-hero';
import { PortalHeader } from './portal-header';
import { AuthFooter } from './auth-footer';
import { LanguageSwitcher } from './language-switcher';
import { ThemeModeToggle } from './theme-mode-toggle';
import { TooltipProvider } from '@/components/ui/tooltip';

interface AuthShellProps {
  children: React.ReactNode;
}

export function AuthShell({ children }: AuthShellProps) {
  return (
    // TooltipProvider wraps the shell because ThemeModeToggle renders a Radix
    // Tooltip, which throws outside a provider. PageShell already mounts one
    // for the app pages; the auth pages never needed it until now.
    <TooltipProvider>
    <div className="min-h-svh lg:h-svh lg:overflow-hidden grid grid-cols-1 lg:grid-cols-[1.1fr_1fr]">
      {/* Left: branded hero panel (desktop only) — stays fixed while right scrolls */}
      <BrandHero />

      {/* Right: form panel — scrolls independently on desktop */}
      <div className="flex flex-col bg-background lg:overflow-y-auto">
        {/* Mobile brand band — collapses hero to a top strip on small screens */}
        <div className="bg-brand-hero lg:hidden flex items-center gap-3 px-6 py-4">
          <svg
            width="28"
            height="28"
            viewBox="0 0 32 32"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <circle cx="16" cy="16" r="8" fill="var(--brand-cta)" />
            <circle cx="10" cy="10" r="3" fill="var(--brand-cta)" opacity="0.7" />
            <circle cx="23" cy="22" r="2.5" fill="var(--brand-cta)" opacity="0.6" />
          </svg>
          <div className="flex-1" />
          {/* Same controls on the mobile band, where there is no desktop
              header row to hang them off. */}
          <div className="flex items-center gap-1">
            <LanguageSwitcher compact />
            <ThemeModeToggle />
          </div>
        </div>

        {/* Portal header (desktop) — aligned with the form column so the logo
            doesn't float off-axis from the inputs below. Larger size variant
            so the brand is the visual anchor of the right panel. */}
        <div className="hidden lg:block px-6 sm:px-10 lg:px-14 pt-10">
          <div className="mx-auto max-w-md w-full flex items-start justify-between gap-4">
            <PortalHeader size="lg" />
            {/* Language + theme are reachable from the app's top bar, but the
                auth pages have no top bar — so a visitor who needs another
                language had to sign in first to change it, which is backwards.
                (The Keycloak-hosted screens are a separate app and can't be
                covered from here.) */}
            <div className="flex items-center gap-1 shrink-0">
              <LanguageSwitcher compact />
              <ThemeModeToggle />
            </div>
          </div>
        </div>

        {/* Form content */}
        <div className="flex-1 px-6 py-6 sm:px-10 lg:px-14 lg:pt-6 lg:pb-8">
          <div className="mx-auto max-w-md w-full">{children}</div>
        </div>

        {/* Footer */}
        <AuthFooter />
      </div>
    </div>
    </TooltipProvider>
  );
}
