export type ProviderStatus = 'new' | 'active' | 'at_risk' | 'satisfied' | 'inactive';

export interface ProviderStatusInput {
  profile_created_at: Date;
  applications_total: number;
  applications_shortlisted: number;
  applications_rejected: number;
  /** Use Number.POSITIVE_INFINITY when the item_type has no `positions` field. */
  openings: number;
  last_shortlisted_at: Date | null;
  last_rejected_at: Date | null;
  now: Date;
}

const MS_PER_DAY = 86_400_000;
const days_between = (earlier: Date, later: Date): number =>
  Math.floor((later.getTime() - earlier.getTime()) / MS_PER_DAY);

const min_not_null = (a: number | null, b: number | null): number | null => {
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
};

/**
 * Provider-side status computation (Plan B spec §c.Provider).
 * First-match-wins. Catch-all → 'inactive' so a provider row's
 * profile_status is never null.
 */
export const compute_provider_status = (i: ProviderStatusInput): ProviderStatus => {
  const job_post_age_days = days_between(i.profile_created_at, i.now);
  const applications = i.applications_total;
  const decisions = i.applications_shortlisted + i.applications_rejected;
  const shortlisted_age =
    i.last_shortlisted_at === null ? null : days_between(i.last_shortlisted_at, i.now);
  const rejected_age =
    i.last_rejected_at === null ? null : days_between(i.last_rejected_at, i.now);
  const min_decision_age = min_not_null(shortlisted_age, rejected_age);

  if (job_post_age_days <= 7) return 'new';

  if (applications > 0 && decisions >= i.openings) return 'satisfied';

  if (applications > 0 && min_decision_age !== null && min_decision_age <= 30) {
    return 'active';
  }

  if (
    applications > 0 &&
    min_decision_age !== null &&
    min_decision_age >= 31 &&
    min_decision_age <= 90 &&
    decisions < i.openings
  ) {
    return 'at_risk';
  }
  if (job_post_age_days > 7 && job_post_age_days <= 30 && applications === 0) {
    return 'at_risk';
  }

  // Inactive: three cases (catch-all included)
  if (
    applications > 0 &&
    min_decision_age !== null &&
    min_decision_age > 90 &&
    decisions < i.openings
  ) {
    return 'inactive';
  }
  if (job_post_age_days >= 31 && job_post_age_days <= 90 && applications === 0) {
    return 'inactive';
  }
  return 'inactive'; // catch-all
};
