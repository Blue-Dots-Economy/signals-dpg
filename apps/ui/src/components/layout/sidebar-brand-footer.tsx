import { SidebarFooter } from '@/components/ui/sidebar';
import { useNetworkTheme } from '@/theme/theme-provider';
import { useThemeMode } from '@/theme/mode-provider';
import {
  resolveBrandMeta,
  type BrandAttribution,
  type BrandMeta,
} from '@/theme/brand-meta';

/**
 * The "seeded by" footer mark for the colour mode: the light variant in dark
 * mode when one exists. Null when the brand configures no footer logo.
 */
export function pickFooterLogo(meta: BrandMeta, isDark: boolean): string | null {
  if (isDark) return meta.footerLogoLight ?? meta.footerLogo;
  return meta.footerLogo;
}

/** Same light/dark preference as {@link pickFooterLogo}, per attribution row. */
function pickRowLogo(row: BrandAttribution, isDark: boolean): string | null {
  if (isDark) return row.logoLight ?? row.logo ?? null;
  return row.logo ?? null;
}

/** First character, via `Array.from` so a non-BMP character is not split. */
function initialOf(name: string): string {
  return (Array.from(name.trim())[0] ?? '?').toUpperCase();
}

/**
 * One "Owned by <party>" row. With a logo, the mark alone (the marks carry
 * their own wordmark) with the name as `alt`. Without one, a letter tile plus
 * the name.
 */
function AttributionRow({ row, isDark }: Readonly<{ row: BrandAttribution; isDark: boolean }>) {
  const src = pickRowLogo(row, isDark);
  return (
    <div className="flex flex-col items-center gap-1.5 text-center">
      <span className="text-xs font-medium text-muted-foreground">{row.label}</span>
      {src ? (
        // A fixed box, not just a fixed height, so marks with different
        // aspect ratios line up.
        <img src={src} alt={row.name} className="h-16 w-36 object-contain object-center" />
      ) : (
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-semibold text-muted-foreground"
          >
            {initialOf(row.name)}
          </span>
          <span className="truncate text-sm font-semibold text-foreground">{row.name}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Bottom-of-sidebar brand block with two independent, opt-in parts:
 * `footerAttribution` ("Owned by / Managed by" rows, shown first) and
 * `footerLogo` (one unlabelled "seeded by" mark). Neither inherits from network
 * to brand, so a deployment shows exactly what its brand.json declares. Renders
 * nothing when neither is set.
 */
export function SidebarBrandFooter() {
  const { themeId, brand } = useNetworkTheme();
  const { resolved } = useThemeMode();
  const isDark = resolved === 'dark';
  const meta = resolveBrandMeta(themeId, brand);
  const src = pickFooterLogo(meta, isDark);
  const rows = meta.footerAttribution ?? [];

  if (!src && rows.length === 0) return null;

  return (
    <SidebarFooter className="px-4 py-4">
      {rows.length > 0 && (
        // No border of its own, so it does not compete with the nav above.
        <div data-attribution className="flex flex-col gap-3">
          {rows.map((row) => (
            <AttributionRow key={`${row.label}-${row.name}`} row={row} isDark={isDark} />
          ))}
        </div>
      )}
      {src && (
        <img
          src={src}
          alt=""
          aria-hidden="true"
          className="h-auto w-36 self-start opacity-90"
        />
      )}
    </SidebarFooter>
  );
}
