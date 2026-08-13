// Post-login routing (#376). Decides, once on login success, whether to send a
// user to the profile create/edit page because they have no *completed* profile
// yet — instead of dropping them on the home page where they wouldn't know what
// to do. A user who already has a completed profile (live/paused/retired) is
// left alone. See docs/superpowers/specs/2026-08-03-first-time-login-profile-redirect-design.md

export type ProfileLite = {
  item_id: string;
  item_domain: string;
  lifecycle_status: string;
};

// A profile counts as "completed" (the user has been through creation) if it is
// live now, or was live and is paused/retired. Only when EVERY profile is still
// draft (or there are none) do we nudge them to complete one.
const COMPLETED_STATUSES = new Set(['live', 'paused', 'retired']);

/**
 * Where to send the user right after login. Returns `null` when they already
 * have a completed profile → land normally (redirectTo / home).
 *
 * - no profiles                        → create page
 * - profiles, but all still `draft`    → edit page for the active/selected draft
 *   (the stored active id if it is one of their drafts, otherwise the first draft)
 */
export function resolvePostLoginRedirect(
  profiles: ProfileLite[],
  storedActiveId: string | null,
): { path: string } | null {
  const hasCompleted = profiles.some((p) => COMPLETED_STATUSES.has(p.lifecycle_status));
  if (hasCompleted) return null;

  const drafts = profiles.filter((p) => p.lifecycle_status === 'draft');
  if (drafts.length === 0) return { path: '/profile/new' };

  const active = drafts.find((p) => p.item_id === storedActiveId) ?? drafts[0];
  return { path: `/profile/${active.item_id}/edit` };
}
