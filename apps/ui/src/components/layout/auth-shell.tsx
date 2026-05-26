import { BrandHero } from './brand-hero';
import { PortalHeader } from './portal-header';
import { AuthFooter } from './auth-footer';

interface AuthShellProps {
  children: React.ReactNode;
}

export function AuthShell({ children }: AuthShellProps) {
  return (
    <div className="min-h-screen grid grid-cols-1 lg:grid-cols-[1.1fr_1fr]">
      {/* Left: branded hero panel (desktop only) */}
      <BrandHero />

      {/* Right: form panel */}
      <div className="flex flex-col bg-background">
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
          <div>
            <p className="text-sm font-semibold text-white leading-tight" />
          </div>
        </div>

        {/* Portal header (desktop) */}
        <div className="hidden lg:block">
          <PortalHeader />
        </div>

        {/* Form content */}
        <div className="flex-1 px-6 py-8 sm:px-10 lg:px-14 lg:py-10">
          <div className="mx-auto max-w-md w-full">{children}</div>
        </div>

        {/* Footer */}
        <AuthFooter />
      </div>
    </div>
  );
}
