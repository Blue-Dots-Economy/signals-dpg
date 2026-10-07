/**
 * Legacy copy of apps/api/src/notifications/brand.ts — the colour map only.
 * The generator bakes the colour into each network's CTA templates.
 * Frozen snapshot of the pre-cutover Signals renderer, kept only for the
 * generator and the golden test.
 */

/**
 * Per-network CTA button colour for action emails. Emails can't use CSS
 * variables, so the colour is inlined per-send. Keyed by network id; unknown
 * networks fall back to the neutral blue. (Phase-2 NS-owned templates can move
 * this into per-network config.)
 */
const BRAND_COLOR: Record<string, string> = {
  blue_dot: '#2563eb',
  purple_dot: '#7c3aed',
  yellow_dot: '#d97706',
  onest_yellow_dot: '#d97706',
  pink_dot: '#db2777',
  green_dot: '#16a34a',
  orange_dot: '#ea580c',
};

export const DEFAULT_BRAND_COLOR = '#2563eb';

export function resolveBrandColor(networkId: string | null | undefined): string {
  if (!networkId) return DEFAULT_BRAND_COLOR;
  return BRAND_COLOR[networkId] ?? DEFAULT_BRAND_COLOR;
}
