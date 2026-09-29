import { describe, it, expect } from 'vitest';
import type { DotNetworkSchema } from '@/engine/types';
import type { Action } from '@/lib/action-api';
import {
  EMPTY_FILTER,
  actionStatuses,
  actionTypes,
  activeFilterCount,
  applySavedView,
  currentSavedView,
  needsResponse,
  pageList,
  parseFilter,
  pendingStatuses,
  selectedStatusOptions,
  sidesOf,
  statusOptions,
  toFetchQuery,
  toggleStatusOption,
  withoutFacetValue,
  writeFilter,
} from '../my-actions-view';

const network = {
  id: 'blue_dot',
  actions: {
    apply: {
      interactions: [
        {
          from_domain: 'seeker',
          to_domain: 'provider',
          requirement_schema: {},
          event_schema: { properties: { status: { enum: ['created', 'accepted', 'completed', 'rejected'] } } },
          metric_categories: { create: ['created'] },
        },
      ],
    },
    connect: {
      interactions: [
        {
          from_domain: 'provider',
          to_domain: 'seeker',
          requirement_schema: {},
          event_schema: { properties: { status: { enum: ['created', 'invited', 'accepted', 'cancelled'] } } },
          metric_categories: { create: ['created', 'invited'] },
        },
      ],
    },
  },
} as unknown as DotNetworkSchema;

describe('URL round-trip', () => {
  it('parses and writes every part, omitting defaults', () => {
    const f = {
      ...EMPTY_FILTER,
      profiles: ['p1', 'p2'],
      statuses: ['accepted'],
      direction: 'received' as const,
      types: ['apply'],
      facets: [{ domain: 'seeker', field: 'gender', values: ['Female', 'Other / Prefer not'] }],
      q: 'meera',
      sort: 'match_score' as const,
      page: 3,
      per: 25,
    };
    const params = writeFilter(new URLSearchParams('network=blue_dot&profile=old'), f);
    expect(params.get('network')).toBe('blue_dot');
    expect(params.has('profile')).toBe(false);
    expect(parseFilter(params)).toEqual(f);
  });

  it('writes nothing for the default filter and ignores junk values', () => {
    expect(writeFilter(new URLSearchParams(), EMPTY_FILTER).toString()).toBe('');
    expect(parseFilter(new URLSearchParams('dir=sideways&sort=name&page=-2&per=7'))).toEqual(EMPTY_FILTER);
  });
});

describe('toFetchQuery', () => {
  it('maps direction to ownership_role and pages by offset', () => {
    const q = toFetchQuery({ ...EMPTY_FILTER, direction: 'sent', page: 2, per: 25, q: '  asha ' });
    expect(q).toMatchObject({ ownership_role: 'initiated', limit: 25, offset: 25, q: 'asha' });
    expect(q.item_ids).toBeUndefined();
    expect(q.include).toEqual(['counts', 'column_fields']);
  });
});

describe('network vocabulary and saved views', () => {
  const vocab = { pending: pendingStatuses(network), exportable: ['accepted', 'completed'] };

  it('collects statuses and the pending bucket across interactions', () => {
    expect(actionStatuses(network)).toEqual(['created', 'accepted', 'completed', 'rejected', 'invited', 'cancelled']);
    expect(vocab.pending).toEqual(['created', 'invited']);
  });

  it('applies and recognises each saved view, keeping other filters', () => {
    const base = { ...EMPTY_FILTER, q: 'asha', page: 4 };
    const needs = applySavedView(base, 'needs_response', vocab);
    expect(needs).toMatchObject({ direction: 'received', statuses: ['created', 'invited'], q: 'asha', page: 1 });
    expect(currentSavedView(needs, vocab)).toBe('needs_response');
    expect(currentSavedView(applySavedView(base, 'ready_to_export', vocab), vocab)).toBe('ready_to_export');
    expect(currentSavedView(applySavedView(base, 'sent', vocab), vocab)).toBe('sent');
    expect(currentSavedView({ ...base, statuses: ['rejected'] }, vocab)).toBeNull();
  });

  it('counts active filters (not profiles or search)', () => {
    expect(
      activeFilterCount({
        ...EMPTY_FILTER,
        profiles: ['p'],
        q: 'x',
        statuses: ['a', 'b'],
        direction: 'sent',
        facets: [{ domain: 'd', field: 'f', values: ['1', '2'] }],
      }),
    ).toBe(5);
  });
});

describe('status options', () => {
  const options = statusOptions(['created', 'invited', 'accepted', 'rejected'], ['created', 'invited', 'pending']);

  it('folds the pending statuses into one option, first', () => {
    expect(options).toEqual([
      { id: 'pending', statuses: ['created', 'invited'] },
      { id: 'accepted', statuses: ['accepted'] },
      { id: 'rejected', statuses: ['rejected'] },
    ]);
    expect(statusOptions(['accepted'], ['created'])).toEqual([{ id: 'accepted', statuses: ['accepted'] }]);
  });

  it('toggles a whole option; partly ticked turns fully on', () => {
    expect(toggleStatusOption(['created'], options[0])).toEqual(['created', 'invited']);
    expect(toggleStatusOption(['created', 'invited', 'accepted'], options[0])).toEqual(['accepted']);
  });

  it('reports touched options and keeps statuses no option covers', () => {
    expect(selectedStatusOptions(['invited', 'odd'], options).map((o) => o.id)).toEqual(['pending', 'odd']);
    expect(activeFilterCount({ ...EMPTY_FILTER, statuses: ['created', 'invited', 'accepted'] }, options)).toBe(2);
  });
});

describe('row helpers', () => {
  const action = (roles: Array<'initiated' | 'received'>, status = 'created') =>
    ({
      action_id: 'a',
      action_status: status,
      ownership_roles: roles,
      source_item_id: 's',
      source_item_domain: 'seeker',
      source_item_type: 't',
      source_item_network: 'n',
      source_item_name: 'A***',
      target_item_id: 'p',
      target_item_domain: 'provider',
      target_item_type: 't',
      target_item_network: 'n',
      target_item_name: 'ABC ltd',
    }) as unknown as Action;

  it('resolves the caller side and the counterparty', () => {
    expect(sidesOf(action(['received'])).other).toMatchObject({ itemId: 's', domain: 'seeker', name: 'A***' });
    expect(sidesOf(action(['initiated'])).other).toMatchObject({ itemId: 'p', name: 'ABC ltd' });
  });

  it('needs a response only when received and pending', () => {
    expect(needsResponse(action(['received']), ['created'])).toBe(true);
    expect(needsResponse(action(['initiated']), ['created'])).toBe(false);
    expect(needsResponse(action(['received'], 'accepted'), ['created'])).toBe(false);
  });

  it('lists pages with gaps', () => {
    expect(pageList(1, 1)).toEqual([1]);
    expect(pageList(5, 10)).toEqual([1, '…', 4, 5, 6, '…', 10]);
  });
});

describe('small helpers', () => {
  it('lists action types and handles a missing network', () => {
    expect(actionTypes(network)).toEqual(['apply', 'connect']);
    expect(actionTypes(null)).toEqual([]);
    expect(actionStatuses(undefined)).toEqual([]);
    expect(pendingStatuses(null)).toEqual([]);
  });

  it('removes one facet value, and the facet once it is empty', () => {
    const f = { ...EMPTY_FILTER, facets: [{ domain: 'seeker', field: 'gender', values: ['Male', 'Female'] }] };
    expect(withoutFacetValue(f, 'seeker', 'gender', 'Male').facets).toEqual([
      { domain: 'seeker', field: 'gender', values: ['Female'] },
    ]);
    expect(withoutFacetValue(withoutFacetValue(f, 'seeker', 'gender', 'Male'), 'seeker', 'gender', 'Female').facets).toEqual([]);
  });

  it('"all actions" clears direction and statuses', () => {
    const f = applySavedView({ ...EMPTY_FILTER, direction: 'sent', statuses: ['x'] }, 'all', { pending: [], exportable: [] });
    expect(f).toMatchObject({ direction: 'all', statuses: [] });
  });

  it('includes nothing extra when told so', () => {
    expect(toFetchQuery(EMPTY_FILTER, []).include).toEqual([]);
  });
});

describe('first-use copy and exportable view statuses', () => {
  it('words the first-use message for the network’s action types', async () => {
    const { firstUseCopy } = await import('../my-actions-view');
    expect(firstUseCopy(['apply', 'connect'])[0]).toBe('my_actions.first_use_body_apply_connect');
    expect(firstUseCopy(['connect'])[0]).toBe('my_actions.first_use_body_connect');
    expect(firstUseCopy(['apply'])[0]).toBe('my_actions.first_use_body_apply');
    expect(firstUseCopy([])[0]).toBe('my_actions.first_use_body');
  });

  it('narrows a status filter to exportable statuses, never widening an empty result', async () => {
    const { viewExportableStatuses } = await import('../my-actions-view');
    expect(viewExportableStatuses([], ['accepted', 'completed'])).toEqual(['accepted', 'completed']);
    expect(viewExportableStatuses(['accepted', 'created'], ['accepted', 'completed'])).toEqual(['accepted']);
    expect(viewExportableStatuses(['rejected'], ['accepted'])).toEqual([]);
  });
});
