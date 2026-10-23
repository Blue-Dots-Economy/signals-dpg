// Post-login routing: decides whether to send a user to the profile
// create/edit page because they have no completed profile yet. A user with a
// completed profile (live/paused/retired) lands normally.

export type ProfileLite = {
  item_id: string;
  item_domain: string;
  lifecycle_status: string;
};

// "Completed" means live now, or was live and is paused/retired. Only when
// every profile is still draft (or there are none) is the user redirected.
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
