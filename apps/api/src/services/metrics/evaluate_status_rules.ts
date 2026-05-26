import type { CanonicalBucket, CanonicalStatus } from './buckets.js';

export interface RuleInput {
  item_age_days: number;
  count: Record<CanonicalBucket, number>;
  /**
   * Days since most recent action in each bucket. `null` when no action of
   * that bucket exists — predicates referencing the bucket via days_since_last
   * evaluate FALSE in that case.
   */
  days_since_last: Record<CanonicalBucket, number | null>;
}

type Comparison =
  | { lt: number }
  | { lte: number }
  | { gt: number }
  | { gte: number }
  | { eq: number }
  | { between: [number, number] };

interface ItemAgePredicate { item_age_days: Comparison }
interface DaysSinceLastPredicate { days_since_last: { buckets: CanonicalBucket[] } & Comparison }
interface CountPredicate { count: { buckets: CanonicalBucket[] } & Comparison }
interface AllPredicate { all: Predicate[] }
interface AnyPredicate { any: Predicate[] }
export type Predicate =
  | ItemAgePredicate
  | DaysSinceLastPredicate
  | CountPredicate
  | AllPredicate
  | AnyPredicate;

export interface StatusRule {
  status: CanonicalStatus;
  when: Predicate | 'default';
}

const compare = (value: number, op: Comparison): boolean => {
  if ('lt' in op) return value < op.lt;
  if ('lte' in op) return value <= op.lte;
  if ('gt' in op) return value > op.gt;
  if ('gte' in op) return value >= op.gte;
  if ('eq' in op) return value === op.eq;
  if ('between' in op) {
    const [lo, hi] = op.between;
    return value >= lo && value <= hi;
  }
  return false;
};

const min_not_null = (vals: Array<number | null>): number | null => {
  let best: number | null = null;
  for (const v of vals) {
    if (v === null) continue;
    if (best === null || v < best) best = v;
  }
  return best;
};

const evaluate_predicate = (pred: Predicate, input: RuleInput): boolean => {
  if ('all' in pred) return pred.all.every((p) => evaluate_predicate(p, input));
  if ('any' in pred) return pred.any.some((p) => evaluate_predicate(p, input));
  if ('item_age_days' in pred) return compare(input.item_age_days, pred.item_age_days);
  if ('days_since_last' in pred) {
    const { buckets, ...op } = pred.days_since_last;
    const candidate = min_not_null(buckets.map((b) => input.days_since_last[b]));
    if (candidate === null) return false;
    return compare(candidate, op as Comparison);
  }
  if ('count' in pred) {
    const { buckets, ...op } = pred.count;
    const total = buckets.reduce((s, b) => s + (input.count[b] ?? 0), 0);
    return compare(total, op as Comparison);
  }
  return false;
};

/**
 * First-match-wins evaluation of a per-domain status_rules array. The
 * final entry must be `{ status: ..., when: 'default' }` — the network-
 * config validator catches violations so this function should never
 * fall off the end. The throw is a defensive guard.
 */
export const evaluate_status_rules = (
  rules: StatusRule[],
  input: RuleInput,
): CanonicalStatus => {
  for (const rule of rules) {
    if (rule.when === 'default') return rule.status;
    if (evaluate_predicate(rule.when, input)) return rule.status;
  }
  throw new Error(
    'evaluate_status_rules: no rule matched and no default tail present (config validation should have caught this)',
  );
};
