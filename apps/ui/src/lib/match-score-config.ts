import { getRuntimeEnv } from './runtime-env';

/**
 * Whether the FREE-TEXT / no-profile match score is surfaced.
 *
 * The list always calls `/discover`, which returns a per-item `score`. For a
 * viewer WITH a profile that score is a profile-to-profile relevance (the
 * "real" match score) and is always shown. For a viewer WITHOUT a profile
 * (signed out, or no profile yet) the same `score` is just how well the item
 * matches the TYPED search text — useful, but not every deployment wants it.
 *
 * This deployment-level flag (`VITE_FREETEXT_MATCH_SCORE_ENABLED`, runtime-env
 * so one image is reconfigurable per deploy) gates ONLY that free-text score.
 * Default ON (opt-out): unset / '' / 'true' → enabled; only an explicit
 * 'false' / '0' / 'off' / 'no' disables it. Profile-to-profile is never gated.
 */
export function isFreeTextMatchScoreEnabled(): boolean {
  const raw = getRuntimeEnv('VITE_FREETEXT_MATCH_SCORE_ENABLED');
  if (raw == null) return true;
  const v = String(raw).trim().toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'off' && v !== 'no';
}

/**
 * Whether a browse card should render the match-score UI (seeded `/discover`
 * badge) rather than a plain card. Single source of truth shared by BOTH the
 * "All" tab and the single-domain tabs so all three behave identically:
 *
 *  - `localItem` present → the viewer has a profile → profile-to-profile score
 *    → ALWAYS show.
 *  - no profile, but a discover `score` exists AND the free-text flag is on →
 *    show the query-relevance score.
 *  - otherwise → plain card, no match UI (avoids a broken/disabled button).
 */
export function shouldRenderMatchScoreCard(
  localItem: { item_id: string } | null | undefined,
  networkItem: { score?: number | null } | null | undefined,
): boolean {
  if (localItem) return true;
  return networkItem?.score != null && isFreeTextMatchScoreEnabled();
}
