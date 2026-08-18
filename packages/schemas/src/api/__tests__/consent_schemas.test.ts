import { describe, expect, it } from 'vitest';
import {
  ConsentAcceptBodySchema,
  ConsentAcceptItemSchema,
  ConsentAcceptResponseSchema,
  ConsentStatusByIdentifierQuerySchema,
  ConsentStatusQuerySchema,
  ConsentStatusResponseSchema,
  ProfileConsentAcceptBodySchema,
  ProfileConsentStatusResponseSchema,
  UserConsentCategorySchema,
} from '../consent_schemas';

const ITEM_ID = '9d2f1c4a-3b6e-4f88-9a10-5c7e2d8b4f31';

describe('UserConsentCategorySchema', () => {
  it.each(['terms', 'privacy'])('accepts the %s category', (category) => {
    expect(UserConsentCategorySchema.safeParse(category).success).toBe(true);
  });

  it('rejects a profile-level category (user-level only)', () => {
    expect(UserConsentCategorySchema.safeParse('profile_creation').success).toBe(false);
  });

  it('rejects an unknown category and a non-string', () => {
    expect(UserConsentCategorySchema.safeParse('marketing').success).toBe(false);
    expect(UserConsentCategorySchema.safeParse(1).success).toBe(false);
  });
});

describe('ConsentStatusQuerySchema', () => {
  it('accepts a network id', () => {
    const result = ConsentStatusQuerySchema.safeParse({ network: 'blue_dot' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.network).toBe('blue_dot');
    }
  });

  it('rejects an empty network', () => {
    expect(ConsentStatusQuerySchema.safeParse({ network: '' }).success).toBe(false);
  });

  it('rejects a missing network', () => {
    expect(ConsentStatusQuerySchema.safeParse({}).success).toBe(false);
  });
});

describe('ConsentStatusResponseSchema', () => {
  it('accepts accepted-version arrays for both categories', () => {
    const result = ConsentStatusResponseSchema.safeParse({
      statuses: { terms: [1, 2], privacy: [1] },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.statuses.terms).toEqual([1, 2]);
    }
  });

  it('accepts empty arrays (nothing accepted yet)', () => {
    expect(
      ConsentStatusResponseSchema.safeParse({ statuses: { terms: [], privacy: [] } }).success,
    ).toBe(true);
  });

  it('rejects a fractional version', () => {
    const result = ConsentStatusResponseSchema.safeParse({
      statuses: { terms: [1.5], privacy: [] },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['statuses', 'terms', 0]);
    }
  });

  it('rejects a stringified version', () => {
    expect(
      ConsentStatusResponseSchema.safeParse({ statuses: { terms: ['1'], privacy: [] } }).success,
    ).toBe(false);
  });

  it('rejects a statuses block missing privacy', () => {
    const result = ConsentStatusResponseSchema.safeParse({ statuses: { terms: [1] } });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['statuses', 'privacy']);
    }
  });
});

describe('ConsentStatusByIdentifierQuerySchema', () => {
  it('accepts network + phone', () => {
    expect(
      ConsentStatusByIdentifierQuerySchema.safeParse({ network: 'blue_dot', phone: '919876543210' })
        .success,
    ).toBe(true);
  });

  it('accepts network alone — neither identifier is required by the schema', () => {
    expect(ConsentStatusByIdentifierQuerySchema.safeParse({ network: 'blue_dot' }).success).toBe(
      true,
    );
  });

  it('does NOT validate the email format (plain string, unlike the participant schemas)', () => {
    const result = ConsentStatusByIdentifierQuerySchema.safeParse({
      network: 'blue_dot',
      email: 'not-an-email',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe('not-an-email');
    }
  });

  it('rejects a non-string phone', () => {
    expect(
      ConsentStatusByIdentifierQuerySchema.safeParse({ network: 'blue_dot', phone: 919876543210 })
        .success,
    ).toBe(false);
  });

  it('rejects a missing network', () => {
    expect(ConsentStatusByIdentifierQuerySchema.safeParse({ phone: '919876543210' }).success).toBe(
      false,
    );
  });
});

describe('ConsentAcceptItemSchema', () => {
  it('accepts a category + version pair', () => {
    expect(ConsentAcceptItemSchema.safeParse({ category: 'terms', version: 1 }).success).toBe(true);
  });

  it('rejects version 0 (versions are 1-based)', () => {
    const result = ConsentAcceptItemSchema.safeParse({ category: 'terms', version: 0 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['version']);
    }
  });

  it('rejects a fractional version', () => {
    expect(ConsentAcceptItemSchema.safeParse({ category: 'terms', version: 1.1 }).success).toBe(
      false,
    );
  });

  it('rejects an unknown category', () => {
    expect(ConsentAcceptItemSchema.safeParse({ category: 'cookies', version: 1 }).success).toBe(
      false,
    );
  });
});

describe('ConsentAcceptBodySchema', () => {
  const body = {
    network: 'blue_dot',
    source: 'signup' as const,
    items: [{ category: 'terms' as const, version: 1 }],
  };

  it('accepts a signup body with one item', () => {
    expect(ConsentAcceptBodySchema.safeParse(body).success).toBe(true);
  });

  it('accepts a login body with both categories', () => {
    const result = ConsentAcceptBodySchema.safeParse({
      ...body,
      source: 'login',
      items: [
        { category: 'terms', version: 2 },
        { category: 'privacy', version: 3 },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.items).toHaveLength(2);
    }
  });

  it('rejects an empty items array', () => {
    const result = ConsentAcceptBodySchema.safeParse({ ...body, items: [] });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['items']);
    }
  });

  it('rejects a source outside signup/login', () => {
    expect(ConsentAcceptBodySchema.safeParse({ ...body, source: 'bulk' }).success).toBe(false);
  });

  it('accepts a null brand and an omitted brand (nullish)', () => {
    expect(ConsentAcceptBodySchema.safeParse({ ...body, brand: null }).success).toBe(true);
    expect(ConsentAcceptBodySchema.safeParse(body).success).toBe(true);
  });

  it('accepts a named brand', () => {
    const result = ConsentAcceptBodySchema.safeParse({ ...body, brand: 'yuvaportal' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.brand).toBe('yuvaportal');
    }
  });

  it('rejects an empty-string brand', () => {
    expect(ConsentAcceptBodySchema.safeParse({ ...body, brand: '' }).success).toBe(false);
  });

  it('rejects an item with an unknown category inside a valid body', () => {
    const result = ConsentAcceptBodySchema.safeParse({
      ...body,
      items: [{ category: 'terms', version: 1 }, { category: 'nope', version: 1 }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['items', 1, 'category']);
    }
  });
});

describe('ConsentAcceptResponseSchema', () => {
  it('accepts a recorded count of 0', () => {
    expect(ConsentAcceptResponseSchema.safeParse({ recorded: 0 }).success).toBe(true);
  });

  it('rejects a fractional recorded count and a missing one', () => {
    expect(ConsentAcceptResponseSchema.safeParse({ recorded: 1.5 }).success).toBe(false);
    expect(ConsentAcceptResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe('ProfileConsentStatusResponseSchema', () => {
  it('accepts a list of consented item ids', () => {
    const result = ProfileConsentStatusResponseSchema.safeParse({
      consented_item_ids: [ITEM_ID],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.consented_item_ids).toEqual([ITEM_ID]);
    }
  });

  it('accepts an empty list', () => {
    expect(ProfileConsentStatusResponseSchema.safeParse({ consented_item_ids: [] }).success).toBe(
      true,
    );
  });

  it('does NOT constrain the ids to uuids on the response side', () => {
    expect(
      ProfileConsentStatusResponseSchema.safeParse({ consented_item_ids: ['not-a-uuid'] }).success,
    ).toBe(true);
  });

  it('rejects a non-array value', () => {
    expect(
      ProfileConsentStatusResponseSchema.safeParse({ consented_item_ids: ITEM_ID }).success,
    ).toBe(false);
  });
});

describe('ProfileConsentAcceptBodySchema', () => {
  const body = {
    network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_id: ITEM_ID,
    version: 1,
  };

  it('accepts a full profile-consent body', () => {
    const result = ProfileConsentAcceptBodySchema.safeParse(body);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.item_id).toBe(ITEM_ID);
      expect(result.data.brand).toBeUndefined();
    }
  });

  it('rejects a non-uuid item_id', () => {
    const result = ProfileConsentAcceptBodySchema.safeParse({ ...body, item_id: 'itm_1' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['item_id']);
    }
  });

  it.each(['network', 'item_domain', 'item_type'])('rejects an empty %s', (field) => {
    expect(ProfileConsentAcceptBodySchema.safeParse({ ...body, [field]: '' }).success).toBe(false);
  });

  it('rejects version 0', () => {
    expect(ProfileConsentAcceptBodySchema.safeParse({ ...body, version: 0 }).success).toBe(false);
  });

  it('accepts a null brand but rejects an empty-string brand', () => {
    expect(ProfileConsentAcceptBodySchema.safeParse({ ...body, brand: null }).success).toBe(true);
    expect(ProfileConsentAcceptBodySchema.safeParse({ ...body, brand: '' }).success).toBe(false);
  });

  it('strips unknown keys', () => {
    const result = ProfileConsentAcceptBodySchema.safeParse({ ...body, user_id: 'usr_1' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('user_id');
    }
  });
});
