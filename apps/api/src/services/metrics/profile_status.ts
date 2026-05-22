export type ProfileStatus =
  | 'new'
  | 'active'
  | 'at_risk'
  | 'satisfied'
  | 'inactive';

export interface ProfileStatusInput {
  profile_created_at: Date;
  profile_last_updated_at: Date;
  applications_total: number;
  applications_accepted: number;
  now: Date;
}

const days_between = (earlier: Date, later: Date): number =>
  Math.floor((later.getTime() - earlier.getTime()) / (1000 * 60 * 60 * 24));

/**
 * Maps a participant's date + application-count state to a status label.
 *
 * Priority (first match wins):
 *
 *   1. satisfied  — any application accepted
 *   2. new        — profile is < 7 days old AND no applications submitted
 *   3. inactive   — > 90 days idle AND no acceptance
 *   4. at_risk    — > 30 days idle (but ≤ 90) AND no acceptance
 *   5. active     — fallthrough
 *
 * Same rule lives in the legacy Python pipeline (populate_dashboard.py).
 * Boundary semantics: `<` and `>` are strict — `age_days = 7` is NOT new;
 * `idle_days = 30` is NOT at_risk; `idle_days = 90` IS at_risk (not yet
 * inactive).
 */
export const compute_profile_status = (i: ProfileStatusInput): ProfileStatus => {
  if (i.applications_accepted > 0) return 'satisfied';

  const idle_days = days_between(i.profile_last_updated_at, i.now);
  const age_days = days_between(i.profile_created_at, i.now);

  if (age_days < 7 && i.applications_total === 0) return 'new';
  if (idle_days > 90 && i.applications_accepted === 0) return 'inactive';
  if (idle_days > 30 && i.applications_accepted === 0) return 'at_risk';
  return 'active';
};
