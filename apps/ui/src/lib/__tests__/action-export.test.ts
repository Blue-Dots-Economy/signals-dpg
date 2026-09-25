import { describe, it, expect, vi, beforeEach } from 'vitest';

// #771: My Actions bulk-export client helpers.

// A plain function in front of the spy: vi.fn records the rejected promise of a
// throwing implementation in its settled results, which vitest then reports as
// the test's failure even though the caller handled it.
const post = vi.fn();
let failWith: unknown = null;
vi.mock('../api-client', () => ({
  createApiClient: () => ({
    post: async (...args: unknown[]) => {
      if (failWith !== null) throw failWith;
      return post(...args);
    },
  }),
}));

const {
  counterpartyDomainOf,
  groupByCounterpartyType,
  filenameFromContentDisposition,
  exportActions,
  saveBlob,
  ActionExportError,
} = await import('../action-export');

const action = (
  id: string,
  roles: Array<'initiated' | 'received'>,
  src: string,
  tgt: string,
  srcType = 'profile_1.0',
  tgtType = 'profile_1.0',
) => ({
  action_id: id,
  ownership_roles: roles,
  source_item_domain: src,
  target_item_domain: tgt,
  source_item_type: srcType,
  target_item_type: tgtType,
});

beforeEach(() => {
  post.mockReset();
  failWith = null;
});

describe('counterpartyDomainOf', () => {
  it('received → source domain; initiated → target domain', () => {
    expect(counterpartyDomainOf(action('a', ['received'], 'seeker', 'provider'))).toBe('seeker');
    expect(counterpartyDomainOf(action('b', ['initiated'], 'provider', 'seeker'))).toBe('seeker');
  });
});

describe('groupByCounterpartyType', () => {
  it('groups a mixed selection by counterparty (domain, item type), sorted, with ids', () => {
    const groups = groupByCounterpartyType([
      action('a1', ['received'], 'seeker', 'service_provider'),
      action('a2', ['initiated'], 'service_provider', 'provider', 'profile_1.0', 'job_posting_1.0'),
      action('a3', ['initiated'], 'service_provider', 'seeker'),
    ]);
    expect(groups).toEqual([
      { key: 'provider::job_posting_1.0', domain: 'provider', itemType: 'job_posting_1.0', actionIds: ['a2'] },
      { key: 'seeker::profile_1.0', domain: 'seeker', itemType: 'profile_1.0', actionIds: ['a1', 'a3'] },
    ]);
  });

  it('splits one domain with two item types into two groups', () => {
    const groups = groupByCounterpartyType([
      action('a1', ['received'], 'provider', 'seeker', 'job_posting_1.0'),
      action('a2', ['received'], 'provider', 'seeker', 'training_1.0'),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['provider::job_posting_1.0', 'provider::training_1.0']);
  });

  it('empty selection → no groups', () => {
    expect(groupByCounterpartyType([])).toEqual([]);
  });
});

describe('filenameFromContentDisposition', () => {
  it('reads a quoted filename', () => {
    expect(
      filenameFromContentDisposition('attachment; filename="purple_dot_seeker_accepted_3f9a1c2e_2026-09-24T10-15-00Z.csv"'),
    ).toBe('purple_dot_seeker_accepted_3f9a1c2e_2026-09-24T10-15-00Z.csv');
  });

  it('falls back when missing or unparsable', () => {
    expect(filenameFromContentDisposition(undefined)).toBe('export.csv');
    expect(filenameFromContentDisposition('attachment')).toBe('export.csv');
  });

  it('strips path separators from a hostile filename', () => {
    expect(filenameFromContentDisposition('attachment; filename="../../x.csv"')).toBe('.._.._x.csv');
  });
});

describe('exportActions', () => {
  const body = {
    filters: {
      item_id: 'i1',
      ownership_role: 'all' as const,
      action_ids: ['a1'],
      action_status: ['accepted'],
      counterparty_domain: 'seeker',
    },
    projection: { fields: '*' as const },
    format: 'csv' as const,
  };

  it('POSTs the body as a blob request and returns file + counts', async () => {
    const blob = new Blob(['x']);
    post.mockResolvedValue({
      data: blob,
      headers: {
        'content-disposition': 'attachment; filename="f.csv"',
        'x-export-id': 'e1',
        'x-export-row-count': '3',
        'x-export-skipped-cross-instance': '1',
        'x-export-skipped-missing': '0',
        'x-export-skipped-self': '0',
        'x-export-skipped-not-enabled': '2',
      },
    });
    const res = await exportActions(body);
    expect(post).toHaveBeenCalledWith('/api/v1/action/export', body, { responseType: 'blob' });
    expect(res).toEqual({ blob, filename: 'f.csv', exportId: 'e1', rowCount: 3, skipped: 3 });
  });

  it('turns an error response (blob body) into a typed error', async () => {
    const errBlob = new Blob([JSON.stringify({ error: 'EXPORT_TOO_LARGE', message: 'too many' })], {
      type: 'application/json',
    });
    failWith = { isAxiosError: true, response: { status: 413, data: errBlob } };
    const err = await exportActions(body).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionExportError);
    const e = err as InstanceType<typeof ActionExportError>;
    expect([e.status, e.code, e.message]).toEqual([413, 'EXPORT_TOO_LARGE', 'too many']);
  });

  it('a network failure becomes a typed error with no status', async () => {
    failWith = new Error('offline');
    const err = await exportActions(body).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionExportError);
    const e = err as InstanceType<typeof ActionExportError>;
    expect([e.status, e.code]).toEqual([0, 'NETWORK_ERROR']);
  });
});

describe('saveBlob', () => {
  it('clicks a temporary download link and revokes the object URL shortly after', () => {
    const create = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    vi.useFakeTimers();
    try {
      saveBlob(new Blob(['x']), 'f.csv');

      expect(create).toHaveBeenCalled();
      expect(click).toHaveBeenCalled();
      expect(document.querySelector('a[download]')).toBeNull();
      // Not revoked in the same tick — some browsers start the download later.
      expect(revoke).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(revoke).toHaveBeenCalledWith('blob:x');
    } finally {
      vi.useRealTimers();
    }
  });
});
