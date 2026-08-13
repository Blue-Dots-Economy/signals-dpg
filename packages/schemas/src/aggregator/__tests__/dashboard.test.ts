import { describe, expect, it } from 'vitest';
import {
  DashboardRequestQuery,
  DashboardResponse,
  DomainBlock,
  ExportQuery,
  ItemRollup,
  ItemRow,
} from '../dashboard';

const fullBuckets = { create: 1, accept: 2, reject: 3, cancel: 4 };

const rollup = {
  total_items: 10,
  complete_profiles: 4,
  has_applications: 3,
  by_status: { new: 1, active: 2, at_risk: 3, inactive: 4 },
  by_initiated_action_status: fullBuckets,
  by_received_action_status: fullBuckets,
  total_users: 8,
  avg_items_per_user: 1.25,
  avg_actions_per_user: 0.5,
  mode_wise_counts: { bulk: 5, self: 3 },
};

const itemRow = {
  profile_item_id: 'itm_1',
  user_id: 'usr_1',
  item_network: 'blue_dot',
  item_domain: 'seeker',
  item_type: 'profile_1.0',
  name: 'Asha Rao',
  onboarded_via: 'bulk',
  profile_status: 'active',
  profile_completion_pct: 80,
  profile_created_at: '2026-08-01T00:00:00.000Z',
  profile_last_updated_at: '2026-08-04T00:00:00.000Z',
  age_days: 4,
  initiated: fullBuckets,
  received: fullBuckets,
  last_initiated_at: { create: '2026-08-02T00:00:00.000Z' },
  last_received_at: {},
  actionable_tags: ['stale'],
};

describe('DashboardRequestQuery', () => {
  it('applies defaults for page, limit and refresh', () => {
    const result = DashboardRequestQuery.safeParse({});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ page: 1, limit: 50, refresh: false });
    }
  });

  it('coerces querystring numbers', () => {
    const result = DashboardRequestQuery.safeParse({ page: '3', limit: '200' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(3);
      expect(result.data.limit).toBe(200);
    }
  });

  it('rejects page 0 and negative pages', () => {
    expect(DashboardRequestQuery.safeParse({ page: 0 }).success).toBe(false);
    expect(DashboardRequestQuery.safeParse({ page: -1 }).success).toBe(false);
  });

  it('rejects a fractional page', () => {
    expect(DashboardRequestQuery.safeParse({ page: '1.5' }).success).toBe(false);
  });

  it('rejects a non-numeric page', () => {
    expect(DashboardRequestQuery.safeParse({ page: 'first' }).success).toBe(false);
  });

  it('accepts limit 500 but rejects 501', () => {
    expect(DashboardRequestQuery.safeParse({ limit: 500 }).success).toBe(true);
    expect(DashboardRequestQuery.safeParse({ limit: 501 }).success).toBe(false);
  });

  it('rejects limit 0', () => {
    expect(DashboardRequestQuery.safeParse({ limit: 0 }).success).toBe(false);
  });

  it("transforms refresh='true' to boolean true", () => {
    const result = DashboardRequestQuery.safeParse({ refresh: 'true' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.refresh).toBe(true);
    }
  });

  it("transforms refresh='false' to boolean false", () => {
    const result = DashboardRequestQuery.safeParse({ refresh: 'false' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.refresh).toBe(false);
    }
  });

  it('rejects a non-"true"/"false" refresh value', () => {
    expect(DashboardRequestQuery.safeParse({ refresh: 'yes' }).success).toBe(false);
  });

  it('rejects a real boolean refresh (querystring strings only)', () => {
    expect(DashboardRequestQuery.safeParse({ refresh: true }).success).toBe(false);
  });

  it.each(['new', 'active', 'at_risk', 'inactive'])('accepts status %s', (status) => {
    expect(DashboardRequestQuery.safeParse({ status }).success).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(DashboardRequestQuery.safeParse({ status: 'churned' }).success).toBe(false);
  });

  it('accepts a comma-separated lifecycle string as an opaque string', () => {
    const result = DashboardRequestQuery.safeParse({ lifecycle: 'live,draft' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lifecycle).toBe('live,draft');
    }
  });

  it('does NOT validate lifecycle values (parsing/validation happens in the route)', () => {
    expect(DashboardRequestQuery.safeParse({ lifecycle: 'bogus,values' }).success).toBe(true);
  });

  it('rejects an empty lifecycle string', () => {
    expect(DashboardRequestQuery.safeParse({ lifecycle: '' }).success).toBe(false);
  });

  it('rejects an empty domain', () => {
    expect(DashboardRequestQuery.safeParse({ domain: '' }).success).toBe(false);
  });

  it('accepts q at 200 chars and rejects 201', () => {
    expect(DashboardRequestQuery.safeParse({ q: 'a'.repeat(200) }).success).toBe(true);
    expect(DashboardRequestQuery.safeParse({ q: 'a'.repeat(201) }).success).toBe(false);
  });

  it('rejects an empty q', () => {
    expect(DashboardRequestQuery.safeParse({ q: '' }).success).toBe(false);
  });
});

describe('ItemRollup', () => {
  it('accepts a fully populated rollup', () => {
    expect(ItemRollup.safeParse(rollup).success).toBe(true);
  });

  it('requires EVERY status key in by_status (enum-keyed records are exhaustive)', () => {
    const result = ItemRollup.safeParse({ ...rollup, by_status: { new: 1 } });

    expect(result.success).toBe(false);
    if (!result.success) {
      const missing = result.error.issues.map((issue) => issue.path.join('.'));
      expect(missing).toEqual([
        'by_status.active',
        'by_status.at_risk',
        'by_status.inactive',
      ]);
    }
  });

  it('requires every bucket in the directional action rollups', () => {
    const result = ItemRollup.safeParse({
      ...rollup,
      by_received_action_status: { create: 1, accept: 1, reject: 1 },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['by_received_action_status', 'cancel']);
    }
  });

  it('rejects an unrecognised bucket key', () => {
    const result = ItemRollup.safeParse({
      ...rollup,
      by_initiated_action_status: { ...fullBuckets, expire: 1 },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].code).toBe('unrecognized_keys');
    }
  });

  it('accepts fractional averages but rejects non-numeric counts', () => {
    expect(ItemRollup.safeParse({ ...rollup, avg_items_per_user: 1.75 }).success).toBe(true);
    expect(ItemRollup.safeParse({ ...rollup, total_items: '10' }).success).toBe(false);
  });

  it('accepts an empty mode_wise_counts map but rejects non-numeric values', () => {
    expect(ItemRollup.safeParse({ ...rollup, mode_wise_counts: {} }).success).toBe(true);
    expect(ItemRollup.safeParse({ ...rollup, mode_wise_counts: { bulk: 'many' } }).success).toBe(
      false,
    );
  });

  it('rejects a rollup missing total_users', () => {
    const partial: Record<string, unknown> = { ...rollup };
    delete partial.total_users;

    expect(ItemRollup.safeParse(partial).success).toBe(false);
  });
});

describe('ItemRow', () => {
  it('accepts a fully populated row', () => {
    expect(ItemRow.safeParse(itemRow).success).toBe(true);
  });

  it('accepts sparse last_initiated_at / last_received_at maps (partialRecord)', () => {
    const result = ItemRow.safeParse({
      ...itemRow,
      last_initiated_at: {},
      last_received_at: { cancel: '2026-08-03T00:00:00.000Z' },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.last_received_at.cancel).toBe('2026-08-03T00:00:00.000Z');
      expect(result.data.last_initiated_at.create).toBeUndefined();
    }
  });

  it('rejects an unknown bucket key in the sparse timestamp map', () => {
    expect(ItemRow.safeParse({ ...itemRow, last_received_at: { expire: 'x' } }).success).toBe(false);
  });

  it('rejects a null timestamp in the sparse map (absent buckets are omitted, not nulled)', () => {
    expect(ItemRow.safeParse({ ...itemRow, last_initiated_at: { create: null } }).success).toBe(
      false,
    );
  });

  it('requires a full bucket map for initiated/received', () => {
    expect(ItemRow.safeParse({ ...itemRow, initiated: { create: 1 } }).success).toBe(false);
  });

  it('requires profile_item_id — user_id alone is not enough', () => {
    const withoutId: Record<string, unknown> = { ...itemRow };
    delete withoutId.profile_item_id;

    const result = ItemRow.safeParse(withoutId);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['profile_item_id']);
    }
  });

  it('accepts a null user_id but rejects an omitted one (nullable, not optional)', () => {
    expect(ItemRow.safeParse({ ...itemRow, user_id: null }).success).toBe(true);

    const withoutUser: Record<string, unknown> = { ...itemRow };
    delete withoutUser.user_id;
    expect(ItemRow.safeParse(withoutUser).success).toBe(false);
  });

  it('accepts nulls across the optional-ish profile metrics', () => {
    const result = ItemRow.safeParse({
      ...itemRow,
      onboarded_via: null,
      profile_status: null,
      profile_completion_pct: null,
      profile_created_at: null,
      profile_last_updated_at: null,
      age_days: null,
    });

    expect(result.success).toBe(true);
  });

  it('rejects an unknown profile_status', () => {
    expect(ItemRow.safeParse({ ...itemRow, profile_status: 'churned' }).success).toBe(false);
  });

  it('accepts an omitted lifecycle_status but rejects an unknown one', () => {
    const withoutLifecycle: Record<string, unknown> = { ...itemRow };
    delete withoutLifecycle.lifecycle_status;
    expect(ItemRow.safeParse(withoutLifecycle).success).toBe(true);

    expect(ItemRow.safeParse({ ...itemRow, lifecycle_status: 'archived' }).success).toBe(false);
  });

  it.each(['draft', 'live', 'paused', 'retired'])('accepts lifecycle_status %s', (lifecycle) => {
    expect(ItemRow.safeParse({ ...itemRow, lifecycle_status: lifecycle }).success).toBe(true);
  });

  it('rejects non-string actionable_tags', () => {
    expect(ItemRow.safeParse({ ...itemRow, actionable_tags: [1] }).success).toBe(false);
  });
});

describe('DomainBlock and DashboardResponse', () => {
  const block = { rollup, items: [itemRow], total_matching: 1, next_cursor: null };

  it('accepts a domain block with a null cursor', () => {
    expect(DomainBlock.safeParse(block).success).toBe(true);
  });

  it('rejects an omitted next_cursor (nullable, not optional)', () => {
    const withoutCursor: Record<string, unknown> = { ...block };
    delete withoutCursor.next_cursor;

    expect(DomainBlock.safeParse(withoutCursor).success).toBe(false);
  });

  it('accepts a multi-domain response', () => {
    const result = DashboardResponse.safeParse({
      by_domain: { seeker: block, provider: { ...block, items: [] } },
      metadata: { last_computed_at: null, ttl_seconds: 300, refreshed: true },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data.by_domain)).toEqual(['seeker', 'provider']);
      expect(result.data.by_domain.provider.items).toEqual([]);
    }
  });

  it('accepts an empty by_domain map (org with no configured domains)', () => {
    expect(
      DashboardResponse.safeParse({
        by_domain: {},
        metadata: { last_computed_at: '2026-08-05T00:00:00.000Z', ttl_seconds: 60, refreshed: false },
      }).success,
    ).toBe(true);
  });

  it('rejects a response missing metadata.refreshed', () => {
    const result = DashboardResponse.safeParse({
      by_domain: {},
      metadata: { last_computed_at: null, ttl_seconds: 60 },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['metadata', 'refreshed']);
    }
  });

  it('rejects a malformed domain block inside by_domain', () => {
    const result = DashboardResponse.safeParse({
      by_domain: { seeker: { ...block, total_matching: 'one' } },
      metadata: { last_computed_at: null, ttl_seconds: 60, refreshed: false },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['by_domain', 'seeker', 'total_matching']);
    }
  });
});

describe('ExportQuery', () => {
  it('defaults refresh to false and carries no pagination', () => {
    const result = ExportQuery.safeParse({});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ refresh: false });
      expect(result.data).not.toHaveProperty('page');
      expect(result.data).not.toHaveProperty('limit');
    }
  });

  it('accepts domain + status + q filters', () => {
    const result = ExportQuery.safeParse({ domain: 'seeker', status: 'at_risk', q: 'welder' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('at_risk');
    }
  });

  it("transforms refresh='true' to true", () => {
    const result = ExportQuery.safeParse({ refresh: 'true' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.refresh).toBe(true);
    }
  });

  it('rejects an unknown status and an over-long q', () => {
    expect(ExportQuery.safeParse({ status: 'churned' }).success).toBe(false);
    expect(ExportQuery.safeParse({ q: 'a'.repeat(201) }).success).toBe(false);
  });
});
