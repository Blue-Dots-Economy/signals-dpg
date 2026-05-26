import { useNetworkTheme } from '@/theme/theme-provider';

export function PortalHeader() {
  const { theme } = useNetworkTheme();

  return (
    <div className="flex items-center gap-2.5 px-6 pt-6 pb-2 sm:px-10 lg:px-14">
      {/* Network dot-mark */}
      <svg
        width="32"
        height="32"
        viewBox="0 0 32 32"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        className="shrink-0"
      >
        <circle cx="16" cy="16" r="14" fill="var(--brand-cta)" opacity="0.15" />
        <circle cx="16" cy="16" r="8" fill="var(--brand-cta)" />
        <circle cx="10" cy="10" r="3" fill="var(--brand-cta)" opacity="0.7" />
        <circle cx="23" cy="10" r="2" fill="var(--brand-cta)" opacity="0.5" />
        <circle cx="23" cy="22" r="2.5" fill="var(--brand-cta)" opacity="0.6" />
      </svg>

      <div>
        <p className="text-sm font-semibold text-foreground leading-tight">{theme.name}</p>
        <p className="text-xs text-muted-foreground leading-tight">{theme.portalLabel}</p>
      </div>
    </div>
  );
}
