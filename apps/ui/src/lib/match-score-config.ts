import { getRuntimeEnv } from './runtime-env';

/**
 * Whether the free-text (no-profile) match score is surfaced.
 *
 * `/discover` returns a per-item `score`. For a viewer with a profile it is
 * profile-to-profile relevance and is always shown. Without a profile it only
 * measures the match to the typed search text, which some deployments hide.
 *
 * Read from runtime `VITE_FREETEXT_MATCH_SCORE_ENABLED`. Default on: only
 * 'false' / '0' / 'off' / 'no' disable it.
 */
export function isFreeTextMatchScoreEnabled(): boolean {
  const raw = getRuntimeEnv('VITE_FREETEXT_MATCH_SCORE_ENABLED');
  if (raw == null) return true;
  const v = String(raw).trim().toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'off' && v !== 'no';
}

/**
 * Whether a browse card renders the match-score UI rather than a plain card,
 * shared by the "All" tab and the single-domain tabs:
 *  - the viewer has a profile (`localItem`) → always;
 *  - no profile, a discover `score` exists and the free-text flag is on → yes;
 *  - otherwise → plain card (avoids a dead match button).
 */
export function shouldRenderMatchScoreCard(
  localItem: { item_id: string } | null | undefined,
  networkItem: { score?: number | null } | null | undefined,
): boolean {
  if (localItem) return true;
  return networkItem?.score != null && isFreeTextMatchScoreEnabled();
}
