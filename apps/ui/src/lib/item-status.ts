import type { StatusRule } from '@/engine/types';

/**
 * item-status.ts
 *
 * Client-side best-effort derivation of an item's lifecycle status from the
 * network's per-domain `status_rules`.
 *
 * ## Why client-side?
 * The server computes `profile_status` and stores it in the metrics table, but
 * that field is only exposed through aggregator/dashboard routes — NOT through
 * the public `/api/v1/network/item/fetch` endpoint consumed by the UI.
 * Until the server surfaces `profile_status` on each Item, we evaluate a
 * subset of the rule predicates here.
 *
 * ## Approximations
 * The full rule engine (apps/api/src/services/metrics/evaluate_status_rules.ts)
 * requires three inputs:
 *   - `item_age_days`      — days since creation      → computable from `created_at` ✓
 *   - `count[bucket]`      — action count per bucket   → NOT available client-side ✗
 *   - `days_since_last[bucket]` — days since last action in bucket → NOT available ✗
 *
 * For `days_since_last` predicates we substitute `days since updated_at` as a
 * proxy for "any recent activity". This is a deliberate approximation: the
 * bucket list in the rule is ignored because the client cannot distinguish
 * which action type caused the last update. This means:
 *   - "active" and "at_risk" rules that depend on specific action buckets will
 *     fall back to the `updated_at` proxy, which may occasionally mis-classify
 *     items (e.g. an item updated by a field edit rather than an action).
 *   - Rules using `count` predicates are not evaluable client-side and will be
 *     skipped (treated as false), so the next rule in sequence is tried.
 *
 * ## Future upgrade path
 * If the server starts returning a `profile_status` field on each Item, replace
 * the call to `deriveItemStatus` with a direct read:
 *   ```ts
 *   const status = item.profile_status ?? deriveItemStatus(item, statusRules);
 *   ```
 * That one-line change requires no other modifications to the filter code.
 */

/** Minimal shape of an Item needed for status derivation. */
export interface StatusDerivationInput {
  created_at: string;
  updated_at: string;
}

type Comparison =
  | { lt: number }
  | { lte: number }
  | { gt: number }
  | { gte: number }
  | { eq: number }
  | { between: [number, number] };

function compare(value: number, op: Comparison): boolean {
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
}

function daysSince(isoDate: string): number {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  if (isNaN(then)) return Infinity;
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}

/**
 * Evaluate a single predicate object from `status_rules[n].when`.
 * Returns `null` when the predicate type is not evaluable client-side
 * (e.g. `count` predicates). The caller treats `null` as "not matched".
 */
function evaluatePredicate(
  pred: Record<string, unknown>,
  ageDays: number,
  daysSinceUpdate: number,
): boolean | null {
  // Composite: all sub-predicates must match.
  // Semantics (tri-state):
  //   - any sub-predicate is false  → false  (short-circuit)
  //   - any sub-predicate is null   → null   (unevaluable; try the next rule)
  //   - all sub-predicates are true → true
  //   - empty array                 → null   (vacuously unevaluable, not true)
  if ('all' in pred && Array.isArray(pred.all)) {
    let hasNull = pred.all.length === 0; // empty `all` is treated as null
    for (const sub of pred.all) {
      if (typeof sub !== 'object' || sub === null) continue;
      const subResult = evaluatePredicate(sub as Record<string, unknown>, ageDays, daysSinceUpdate);
      if (subResult === false) return false; // definite failure; short-circuit
      if (subResult === null) hasNull = true; // at least one unevaluable branch
    }
    return hasNull ? null : true;
  }

  // Composite: any sub-predicate must match.
  // Semantics (tri-state):
  //   - any sub-predicate is true   → true   (short-circuit)
  //   - any sub-predicate is null   → null   (unevaluable; try the next rule)
  //   - all sub-predicates are false → false
  //   - empty array                 → null   (vacuously unevaluable, not false)
  if ('any' in pred && Array.isArray(pred.any)) {
    let hasNull = pred.any.length === 0; // empty `any` is treated as null
    for (const sub of pred.any) {
      if (typeof sub !== 'object' || sub === null) continue;
      const subResult = evaluatePredicate(sub as Record<string, unknown>, ageDays, daysSinceUpdate);
      if (subResult === true) return true; // definite match; short-circuit
      if (subResult === null) hasNull = true; // at least one unevaluable branch
    }
    return hasNull ? null : false;
  }

  // item_age_days predicate — fully evaluable
  if ('item_age_days' in pred) {
    const op = pred.item_age_days;
    if (typeof op !== 'object' || op === null) return null;
    return compare(ageDays, op as Comparison);
  }

  // days_since_last predicate — proxy: use days since updated_at, ignore bucket list
  // Approximation documented at file top.
  if ('days_since_last' in pred) {
    const spec = pred.days_since_last;
    if (typeof spec !== 'object' || spec === null) return null;
    // Extract the comparison portion (everything except `buckets`)
    const { buckets: _buckets, ...op } = spec as Record<string, unknown>;
    void _buckets; // intentionally unused — we proxy across all buckets
    return compare(daysSinceUpdate, op as Comparison);
  }

  // count predicate — not evaluable client-side, skip
  if ('count' in pred) {
    return null;
  }

  return null;
}

/**
 * Derives the best-effort lifecycle status for an item given the domain's
 * `status_rules` array. Rules are evaluated in order; the first match wins.
 * A rule with `when: "default"` always matches and must be the last rule.
 *
 * Returns `null` when `statusRules` is absent, empty, or no rule matches
 * (which should not happen if the network config is well-formed).
 */
export function deriveItemStatus(
  item: StatusDerivationInput,
  statusRules: StatusRule[] | undefined,
): string | null {
  if (!statusRules || statusRules.length === 0) return null;

  const ageDays = daysSince(item.created_at);
  const daysSinceUpdate = daysSince(item.updated_at);

  for (const rule of statusRules) {
    if (rule.when === 'default') return rule.status;

    const pred = rule.when as Record<string, unknown>;
    const result = evaluatePredicate(pred, ageDays, daysSinceUpdate);
    if (result === true) return rule.status;
  }

  return null;
}

/**
 * Extracts the distinct status values from a `status_rules` array, preserving
 * declaration order. Safe to call with undefined/empty input.
 */
export function getStatusOptions(
  statusRules: StatusRule[] | undefined,
): Array<{ status: string; label: string; description?: string }> {
  if (!statusRules || statusRules.length === 0) return [];
  return statusRules.map((r) => ({
    status: r.status,
    label: r.label ?? r.status,
    description: r.description,
  }));
}
