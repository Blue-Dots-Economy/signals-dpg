import { useTranslation } from 'react-i18next';
import { useNetworkTheme } from '@/theme/theme-provider';
import { useThemeMode } from '@/theme/mode-provider';
import { brandLogoUrl } from '@/theme/brand-assets';

interface PortalHeaderProps {
  /** Logo size preset. `sm` matches sidebar density; `lg` for auth / hero spots. */
  size?: 'sm' | 'lg';
}

export function PortalHeader({ size = 'sm' }: PortalHeaderProps) {
  const { themeId, theme } = useNetworkTheme();
  const { resolved } = useThemeMode();
  const { t } = useTranslation();
  // Dark mode → light-text wordmark variant. Brand dot reads as a grey
  // ring on dark grey, but the wordmark itself is fully readable and
  // designer-shipped, which is the priority.
  const logoSrc = brandLogoUrl(themeId, resolved === 'dark' ? 'light' : 'default');

  const logoClass =
    size === 'lg'
      ? 'h-10 w-auto max-w-[220px] shrink-0 object-contain sm:h-12 sm:max-w-[260px]'
      : 'h-7 w-auto max-w-[150px] shrink-0 object-contain';

  return (
    <div className="flex items-center gap-2.5">
      {logoSrc ? (
        <img
          src={logoSrc}
          alt={t('nav.portal_logo_alt', { name: theme.name })}
          className={logoClass}
          loading="eager"
        />
      ) : (
        /* Fallback dot-mark when the network has no designer logo on disk */
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
      )}

      {/* Drop text labels when the designer logo is present — the wordmark
          and portal context live inside the PNG. Avoids "SERVICES P..."
          truncation in the narrow sidebar column. */}
      {!logoSrc && (
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground leading-tight">
            {theme.name}
          </p>
          <p className="truncate text-[11px] uppercase tracking-wider text-muted-foreground leading-tight">
            {theme.portalLabel}
          </p>
        </div>
      )}
    </div>
  );
}
