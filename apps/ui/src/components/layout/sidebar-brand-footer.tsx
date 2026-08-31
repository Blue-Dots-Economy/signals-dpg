import { SidebarFooter } from '@/components/ui/sidebar';
import { useNetworkTheme } from '@/theme/theme-provider';
import { useThemeMode } from '@/theme/mode-provider';
import { resolveBrandMeta, type BrandMeta } from '@/theme/brand-meta';

/**
 * Chooses the "seeded by" footer mark for the current colour mode. In dark mode
 * the light (white) variant is preferred, falling back to the default when a
 * network only ships one. Returns null when the network/brand configures no
 * footer logo — the footer then renders nothing (opt-in per brand.json).
 */
export function pickFooterLogo(meta: BrandMeta, isDark: boolean): string | null {
  if (isDark) return meta.footerLogoLight ?? meta.footerLogo;
  return meta.footerLogo;
}

/**
 * Optional image-only "seeded by" mark rendered at the bottom of the sidebar.
 * Driven entirely by config (brand.json `footerLogo` / `footerLogoLight`); not
 * tied to any specific network. Renders nothing when unconfigured.
 */
export function SidebarBrandFooter() {
  const { themeId, brand } = useNetworkTheme();
  const { resolved } = useThemeMode();
  const src = pickFooterLogo(resolveBrandMeta(themeId, brand), resolved === 'dark');
  if (!src) return null;
  return (
    <SidebarFooter className="px-4 py-4">
      <img src={src} alt="" aria-hidden="true" className="h-auto w-36 self-start opacity-90" />
    </SidebarFooter>
  );
}
