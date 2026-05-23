export type SeekerStatus = 'new' | 'active' | 'at_risk' | 'inactive';

export interface SeekerStatusInput {
  profile_created_at: Date;
  last_applied_at: Date | null;
  now: Date;
}

const MS_PER_DAY = 86_400_000;
const days_between = (earlier: Date, later: Date): number =>
  Math.floor((later.getTime() - earlier.getTime()) / MS_PER_DAY);

/**
 * Seeker-side status computation (Plan B spec §c.Seeker).
 * First-match-wins:
 *   1. profile_age <= 7  → 'new'
 *   2. last_applied_age <= 30 → 'active'
 *   3. profile_age > 7 AND 31 <= last_applied_age <= 90 → 'at_risk'
 *   4. otherwise → 'inactive' (covers never-applied-with-age>7 and last_applied_age > 90)
 */
export const compute_seeker_status = (i: SeekerStatusInput): SeekerStatus => {
  const profile_age_days = days_between(i.profile_created_at, i.now);
  const last_applied_age_days =
    i.last_applied_at === null ? null : days_between(i.last_applied_at, i.now);

  if (profile_age_days <= 7) return 'new';
  if (last_applied_age_days !== null && last_applied_age_days <= 30) return 'active';
  if (
    profile_age_days > 7 &&
    last_applied_age_days !== null &&
    last_applied_age_days >= 31 &&
    last_applied_age_days <= 90
  ) {
    return 'at_risk';
  }
  return 'inactive';
};
