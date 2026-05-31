import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  findMetricCategoryAsymmetries,
  parseNetworkConfigDocument,
} from '../network_workflow';

describe.each([
  ['purple_dot', 'examples/schemas/purple_dot/network.json'],
  ['blue_dot', 'examples/schemas/blue_dot/network.json'],
])('%s network.json', (_name, relPath) => {
  it('parses cleanly with reveals_pii_on_status seeded', () => {
    const abs = resolve(__dirname, '../../../..', relPath);
    const doc = JSON.parse(readFileSync(abs, 'utf8'));
    const parsed = parseNetworkConfigDocument(doc);

    // Collect all interactions across all actions
    const allInteractions = Object.values(parsed.actions).flatMap(
      (action) => action.interactions
    );

    // At least one seeker→provider interaction should have 'accepted' seeded
    const seekerToProvider = allInteractions.find(
      (i) => i.from_domain === 'seeker' && i.to_domain === 'provider'
    );
    expect(seekerToProvider).toBeTruthy();

    // purple_dot: connect seeker→provider has accepted
    // blue_dot: apply seeker→provider does NOT have accepted; provider→seeker does
    // So check that at least one interaction has reveals_pii_on_status containing 'accepted'
    const hasAccepted = allInteractions.some((i) =>
      i.reveals_pii_on_status.includes('accepted')
    );
    expect(hasAccepted).toBe(true);
  });

  // Guards against the metric_categories asymmetry bug: a tracked interaction
  // whose reverse direction exists but is untracked. The recompute pipeline
  // silently drops actions in the untracked direction, so their counts never
  // reach item_metrics / the aggregator dashboard. Any NEW asymmetry fails CI.
  it('has no metric_categories direction asymmetries', () => {
    const abs = resolve(__dirname, '../../../..', relPath);
    const doc = JSON.parse(readFileSync(abs, 'utf8'));
    const parsed = parseNetworkConfigDocument(doc);

    const asymmetries = findMetricCategoryAsymmetries(parsed);
    expect(
      asymmetries,
      `Untracked reverse direction(s) found — actions in these directions are ` +
        `silently dropped from item_metrics:\n${JSON.stringify(asymmetries, null, 2)}`,
    ).toEqual([]);
  });
});
