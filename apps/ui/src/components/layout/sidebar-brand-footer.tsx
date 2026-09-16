import { SidebarFooter } from '@/components/ui/sidebar';
import { useNetworkTheme } from '@/theme/theme-provider';
import { useThemeMode } from '@/theme/mode-provider';
import {
  resolveBrandMeta,
  type BrandAttribution,
  type BrandMeta,
} from '@/theme/brand-meta';

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

/** Same light/dark preference as {@link pickFooterLogo}, per attribution row. */
function pickRowLogo(row: BrandAttribution, isDark: boolean): string | null {
  if (isDark) return row.logoLight ?? row.logo ?? null;
  return row.logo ?? null;
}

/**
 * First character of the name, for the placeholder tile.
 *
 * Uses `Array.from` rather than `name[0]`: a name starting with a non-BMP
 * character would otherwise be cut mid-surrogate-pair and render as a
 * replacement glyph.
 */
function initialOf(name: string): string {
  return (Array.from(name.trim())[0] ?? '?').toUpperCase();
}

/**
 * One "Owned by <party>" row.
 *
 * With a logo: the mark ALONE. Both marks here already carry their own
 * wordmark ("ALIMCO", "Swavlamban"), so printing the name beside them says it
 * twice. The name becomes the image's `alt`, which is what a screen reader
 * needs anyway — so nothing is lost by dropping the visible text.
 *
 * Without one: a letter tile plus the name, because the initial alone
 * identifies nobody. The tile is the design's own placeholder for artwork that
 * has not been supplied, not a loading state, so it must look deliberate.
 */
function AttributionRow({ row, isDark }: Readonly<{ row: BrandAttribution; isDark: boolean }>) {
  const src = pickRowLogo(row, isDark);
  return (
    <div className="flex flex-col items-center gap-1.5 text-center">
      <span className="text-xs font-medium text-muted-foreground">{row.label}</span>
      {src ? (
        // Fixed BOX, not a fixed height. The marks have very different aspect
        // ratios (Swavlamban ~1.26:1, ALIMCO ~1.84:1), so a shared height alone
        // left them visibly different widths and the stack read as ragged.
        // `object-contain object-center` fits each inside identical bounds and
        // centres it, so the rows line up whatever artwork arrives later.
        <img src={src} alt={row.name} className="h-12 w-32 object-contain object-center" />
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
 * Bottom-of-sidebar brand block. Two independent, separately-configured parts:
 *
 *  1. `footerAttribution` — labelled "Owned by / Managed by" rows (#720).
 *  2. `footerLogo` — the older single unlabelled "seeded by" mark.
 *
 * Both are opt-in per network/brand and neither inherits network → brand, so a
 * deployment shows exactly what its own brand.json declares. A brand that sets
 * both gets both, attribution first; a brand that sets neither renders nothing
 * at all rather than an empty bordered box.
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
        <div className="flex flex-col gap-3 rounded-lg border border-sidebar-border/60 p-3">
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
