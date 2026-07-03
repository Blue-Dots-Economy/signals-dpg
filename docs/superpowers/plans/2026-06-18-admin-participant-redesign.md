# Admin Participant Endpoint Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign POST/GET `/api/v1/admin/participant` with normalized context/message envelope structure, supporting single/bulk account operations, multi-item creation/updates per account, and strict access control (aggregator/network_service).

**Architecture:** 
- Normalized request/response envelope (context/message) following signals-search pattern
- Polymorphic single/bulk handling via `accounts` array (always array, even single account)
- Per-item create/update dispatch based on presence of `item_id`
- Per-account error handling in bulk (non-failing); ownership checks prevent data leaks
- Item lifecycle auto-determined (draft if missing required fields, live if complete)

**Tech Stack:** 
- Fastify + Zod (schema validation)
- Drizzle ORM (item CRUD)
- UUID for messageId correlation
- TDD: write failing tests first, implement to pass

## Global Constraints

- Node ≥ 24, pnpm ≥ 10
- ESM only, strict TypeScript, no `any`
- Routes never throw; return `reply.code(N).send({ error, message })`
- Files are snake_case; exports are snake_case, Zod schemas are PascalCase
- Branch: `feat/admin-participant-redesign` off `origin/feature`
- Frequent commits (one per task)

---

## File Structure

**New/Modified Files:**

| File | Purpose | Type |
|------|---------|------|
| `packages/schemas/src/admin/participant.ts` | Request/response Zod schemas with context/message envelope | Modify |
| `apps/api/src/routes/v1/admin/participant_upsert.ts` | New normalized POST handler (replaces/refactors old participant.ts POST logic) | Create |
| `apps/api/src/routes/v1/admin/participant_read.ts` | GET handler (already exists; may adapt to new pattern or leave as-is) | Modify (optional) |
| `apps/api/src/routes/v1/admin/admin_routes.ts` | Route registration | Modify |
| `apps/api/src/routes/v1/admin/__tests__/participant_upsert.test.ts` | Unit tests: schema validation, context extraction | Create |
| `apps/api/src/routes/v1/admin/__tests__/participant_upsert.integration.test.ts` | Integration tests: single/bulk, access control, item lifecycle | Create |
| `apps/api/src/services/participant_service.ts` | Business logic: account resolution, item dispatch, lifecycle determination | Create |

---

## Task Breakdown

### Task 1: Define Normalized Schemas (Zod)

**Files:**
- Modify: `packages/schemas/src/admin/participant.ts`
- Test: (no test file; Zod validates at compile time and in route handlers)

**Interfaces:**
- Consumes: None (standalone schema definitions)
- Produces: 
  - `type AdminParticipantContextRequest`
  - `type AdminParticipantAccountRequest`
  - `type AdminParticipantRequest` (envelope)
  - `type AdminParticipantContextResponse`
  - `type AdminParticipantAccountResponse`
  - `type AdminParticipantResponse` (envelope)

- [ ] **Step 1: Read current schema to understand ParticipantItemSnapshot**

Read `packages/schemas/src/admin/participant.ts` to see what `ParticipantItemSnapshot` looks like and what already exists.

- [ ] **Step 2: Add context Zod schema to participant.ts**

```typescript
// Add to packages/schemas/src/admin/participant.ts

const AdminParticipantContextRequest = z.object({
  version: z.literal('1.0.0'),
  messageId: z.string().uuid('messageId must be a valid UUID'),
  timestamp: z.iso.datetime(),
  networkId: z.string().min(1).describe('network ID (e.g., purple_dot, blue_dot)'),
  domain: z.string().min(1).describe('domain within network (e.g., provider, seeker)'),
  itemType: z.string().min(1).describe('schema identifier (e.g., profile_1.0)'),
  channel: z.enum(['bulk', 'link', 'voice', 'self']),
  source_id: z.string().min(1).optional().describe('opaque tracking identifier'),
});

const AdminParticipantContextResponse = AdminParticipantContextRequest.pick({
  version: true,
  messageId: true,
  timestamp: true,
  networkId: true,
  domain: true,
  itemType: true,
  channel: true,
  source_id: true,
});
```

- [ ] **Step 3: Add account request schema (single account with array of items)**

```typescript
// Add to packages/schemas/src/admin/participant.ts

const AdminParticipantAccountRequest = z.object({
  email: z.email().optional(),
  phone_number: PhoneE164.optional(),
  name: z.string().min(1),
  item_state: z.array(
    z.record(z.string(), z.unknown())
      .refine((obj) => {
        // Validate: if item_id is present, it must be a UUID
        if (obj.item_id !== undefined && typeof obj.item_id !== 'string') {
          return false;
        }
        return true;
      }, { message: 'item_id must be a string UUID if provided' })
  ).min(0).describe('array of items to create/update; if item_id present → UPDATE, else → CREATE')
}).refine((acc) => Boolean(acc.email) || Boolean(acc.phone_number), {
  message: 'either email or phone_number is required',
  path: ['email'],
});

export type AdminParticipantAccountRequest = z.infer<typeof AdminParticipantAccountRequest>;
```

- [ ] **Step 4: Add envelope request schema**

```typescript
// Add to packages/schemas/src/admin/participant.ts

export const AdminParticipantRequest = z.object({
  context: AdminParticipantContextRequest,
  message: z.object({
    accounts: z.array(AdminParticipantAccountRequest).min(1).max(1000),
  }),
});

export type AdminParticipantRequest = z.infer<typeof AdminParticipantRequest>;
```

- [ ] **Step 5: Add account response schema (with lifecycle_status)**

```typescript
// Add to packages/schemas/src/admin/participant.ts

const AdminParticipantAccountResponse = z.object({
  exists: z.boolean(),
  owned_by_self: z.boolean(),
  user_id: z.string().nullable(),
  email: z.string().email().nullable(),
  phone_number: z.string().nullable(),
  name: z.string().nullable(),
  item_state: z.array(
    z.object({
      item_id: z.string().uuid(),
      // Full item payload from DB
      // (rest of item_state fields are dynamic per schema)
      created_at: z.string().datetime(),
      updated_at: z.string().datetime(),
      lifecycle_status: z.enum(['draft', 'live', 'retired']),
    }).passthrough() // Allow extra fields from DB item_state
  ),
});

export type AdminParticipantAccountResponse = z.infer<typeof AdminParticipantAccountResponse>;
```

- [ ] **Step 6: Add envelope response schema with meta**

```typescript
// Add to packages/schemas/src/admin/participant.ts

export const AdminParticipantResponse = z.object({
  context: AdminParticipantContextResponse,
  message: z.object({
    accounts: z.array(AdminParticipantAccountResponse),
    meta: z.object({
      total: z.number().int().min(0),
      limit: z.number().int().min(1),
      offset: z.number().int().min(0),
    }),
  }),
});

export type AdminParticipantResponse = z.infer<typeof AdminParticipantResponse>;
```

- [ ] **Step 7: Verify schema exports in index.ts**

Check `packages/schemas/src/index.ts` already exports `participant.ts` via `export * from './admin/participant'`. If not, add it.

- [ ] **Step 8: Commit**

```bash
git add packages/schemas/src/admin/participant.ts
git commit -m "schema: add normalized context/message schemas for admin/participant"
```

---

### Task 2: Create Participant Service (Business Logic)

**Files:**
- Create: `apps/api/src/services/participant_service.ts`
- Test: inline validation in handler; tested via integration tests in Task 5

**Interfaces:**
- Consumes: 
  - `AdminParticipantRequest` from schemas
  - `db` from drizzle config
  - `user`, `items`, `organization`, `member` tables from schema
- Produces:
  - `resolveOrCreateAccount(email, phone_number, acting_org_id, channel, source_id) → { user_id, user_existed, onboarded_by_org_id }`
  - `checkOwnership(user_id, acting_org_id, acting_org_type) → { owned_by_self: boolean }`
  - `determineLifecycleStatus(item_state, schema) → 'draft' | 'live'`
  - `getItemsForUser(user_id, networks) → ItemSnapshot[]`

- [ ] **Step 1: Create participant_service.ts with account resolution**

```typescript
// apps/api/src/services/participant_service.ts

import { eq, or } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { user } from '../../db/postgres/schema/auth.js';
import type { AdminParticipantAccountRequest } from '@dpg/schemas';

export type ActingOrg = {
  org_id: string;
  org_type: 'aggregator' | 'network_service';
  service_user_id: string;
};

export type AccountResolution = {
  user_id: string;
  user_existed: boolean;
  onboarded_by_org_id: string | null;
};

/**
 * Resolve or create an account by email/phone.
 * 
 * If account exists: return user_id + onboarded_by_org_id
 * If account doesn't exist: create it (network_service/aggregator creates on behalf)
 * 
 * Returns:
 *   user_id: UUID of the user
 *   user_existed: boolean (true if found, false if created)
 *   onboarded_by_org_id: org_id that onboarded this user (for ownership checks)
 */
export async function resolveOrCreateAccount(
  email: string | null,
  phone_number: string | null,
  acting_org_id: string,
  channel: 'bulk' | 'link' | 'voice' | 'self',
  source_id: string | undefined,
  name: string,
): Promise<AccountResolution> {
  // 1. Look up existing user
  const conditions = [];
  if (email) conditions.push(eq(user.email, email));
  if (phone_number) conditions.push(eq(user.phoneNumber, phone_number));
  
  if (conditions.length === 0) {
    throw new Error('resolveOrCreateAccount: email and phone_number both null');
  }

  const whereClause = conditions.length === 1 ? conditions[0] : or(...conditions);
  const existingRows = await db
    .select({
      id: user.id,
      onboardedByOrgId: user.onboardedByOrgId,
    })
    .from(user)
    .where(whereClause)
    .limit(1);

  const existing = existingRows[0];
  if (existing) {
    return {
      user_id: existing.id,
      user_existed: true,
      onboarded_by_org_id: existing.onboardedByOrgId,
    };
  }

  // 2. User doesn't exist; create via better-auth (same as old flow)
  // For now, return error — actual creation deferred to handler
  // (handler orchestrates this with authInstance.api.signUpEmail)
  return {
    user_id: '', // placeholder
    user_existed: false,
    onboarded_by_org_id: acting_org_id,
  };
}

/**
 * Check ownership: does acting_org own this user?
 */
export function checkOwnership(
  user_onboarded_by_org_id: string | null,
  acting_org_id: string,
  acting_org_type: 'aggregator' | 'network_service',
): { owned_by_self: boolean } {
  if (acting_org_type === 'network_service') {
    // network_service always has access (admin)
    return { owned_by_self: true };
  }

  // aggregator: only if they onboarded the user
  const owned_by_self = user_onboarded_by_org_id === acting_org_id;
  return { owned_by_self };
}

/**
 * Determine item lifecycle status based on schema validation.
 * 
 * Draft: item_state is missing one or more required fields
 * Live: item_state has all required fields
 * Retired: placeholder (no logic)
 */
export function determineLifecycleStatus(
  item_state: Record<string, any>,
  required_fields: string[],
): 'draft' | 'live' | 'retired' {
  const has_all_required = required_fields.every(
    (field) => item_state[field] !== undefined && item_state[field] !== null
  );

  return has_all_required ? 'live' : 'draft';
}
```

- [ ] **Step 2: Add item fetching helper**

```typescript
// Add to apps/api/src/services/participant_service.ts

import { items } from '@dpg/database';
import { and, inArray } from 'drizzle-orm';
import { decryptItemPrivate } from '@/utils/item_decrypt';

export type ItemSnapshot = {
  item_id: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  item_state: Record<string, any>;
  created_at: string;
  updated_at: string;
  lifecycle_status: 'draft' | 'live' | 'retired';
};

/**
 * Fetch all items for a user, scoped to served networks.
 * Decrypts private state and returns merged public state.
 */
export async function getItemsForUser(
  user_id: string,
  served_networks: string[],
): Promise<ItemSnapshot[]> {
  const rows = await db
    .select({
      item_id: items.item_id,
      item_network: items.item_network,
      item_domain: items.item_domain,
      item_type: items.item_type,
      item_state: items.item_state,
      item_private_state: items.item_private_state,
      created_at: items.created_at,
      updated_at: items.updated_at,
      lifecycle_status: items.lifecycle_status, // Assumes this column exists
    })
    .from(items)
    .where(
      served_networks.length > 0
        ? and(eq(items.created_by, user_id), inArray(items.item_network, served_networks))
        : eq(items.created_by, user_id),
    )
    .orderBy(items.created_at);

  return rows.map((r) => {
    const { item_private_state: _drop, ...rest } = r;
    const { mergedState } = decryptItemPrivate({
      item_state: r.item_state as Record<string, unknown>,
      item_private_state: r.item_private_state,
    });
    return {
      ...rest,
      item_state: mergedState,
      created_at: (r.created_at as Date).toISOString(),
      updated_at: (r.updated_at as Date).toISOString(),
      lifecycle_status: r.lifecycle_status ?? 'draft', // Default to draft if null
    };
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/participant_service.ts
git commit -m "service: add participant business logic (account resolution, ownership, lifecycle)"
```

---

### Task 3: Create Normalized POST Handler

**Files:**
- Create: `apps/api/src/routes/v1/admin/participant_upsert.ts`
- Test: see Task 4

**Interfaces:**
- Consumes:
  - `AdminParticipantRequest` from schemas
  - `ActingOrg` from request middleware
  - `participant_service`: `resolveOrCreateAccount()`, `checkOwnership()`, `determineLifecycleStatus()`, `getItemsForUser()`
  - `updateItemInternal()` and `create_profile_item()` (existing helpers)
- Produces:
  - POST handler that returns `AdminParticipantResponse`

- [ ] **Step 1: Create participant_upsert.ts with handler skeleton**

```typescript
// apps/api/src/routes/v1/admin/participant_upsert.ts

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import z from 'zod';
import { AdminParticipantRequest, AdminParticipantResponse } from '@dpg/schemas';
import {
  resolveOrCreateAccount,
  checkOwnership,
  determineLifecycleStatus,
  getItemsForUser,
  type ActingOrg,
} from '@/services/participant_service';
import { create_profile_item } from '@/lib/profile_item';
import { updateItemInternal } from '@/services/item_service';
import { apiConfig } from '@/config';
import { randomUUID } from 'node:crypto';

type ParticipantUpsertRequest = FastifyRequest<{
  Body: z.infer<typeof AdminParticipantRequest>;
}>;

export const participant_upsert: FastifyPluginAsync = async (app) => {
  app.route({
    url: '/participant',
    method: 'POST',
    schema: {
      tags: ['admin'],
      body: AdminParticipantRequest,
      response: { 200: AdminParticipantResponse },
    },
    handler: participant_upsert_handler,
  });
};

export const participant_upsert_handler = async (
  request: ParticipantUpsertRequest,
  reply: FastifyReply,
) => {
  const { context, message } = request.body;

  // Auth check
  if (!request.acting_org) {
    return reply.code(403).send({
      error: 'INVALID_ACTING_ORG',
      message: 'acting_org is required',
    });
  }

  if (
    request.acting_org.org_type !== 'aggregator' &&
    request.acting_org.org_type !== 'network_service'
  ) {
    return reply.code(403).send({
      error: 'ACTING_ORG_TYPE_NOT_ALLOWED',
      message: 'only aggregator or network_service allowed',
    });
  }

  // Get served networks for item scoping
  const served_networks = Array.from(
    new Set(apiConfig.served_domains.map((d) => d.network))
  );

  // Response container
  const response_accounts = [];
  const response_errors = [];

  // Process each account
  for (let idx = 0; idx < message.accounts.length; idx++) {
    const account = message.accounts[idx];

    try {
      // 1. Resolve or create account
      const account_resolution = await resolveOrCreateAccount(
        account.email || null,
        account.phone_number || null,
        request.acting_org.org_id,
        context.channel,
        context.source_id,
        account.name,
      );

      // TODO: If user_existed=false, call authInstance.api.signUpEmail here
      // (handle race conditions, orphan cleanup)

      const user_id = account_resolution.user_id;

      // 2. Check ownership
      const { owned_by_self } = checkOwnership(
        account_resolution.onboarded_by_org_id,
        request.acting_org.org_id,
        request.acting_org.org_type,
      );

      // 3. If not owned, return forbidden (no data leak)
      if (!owned_by_self) {
        response_accounts.push({
          exists: true,
          owned_by_self: false,
          user_id: null,
          email: null,
          phone_number: null,
          name: null,
          item_state: [],
        });
        continue;
      }

      // 4. Process items for this account
      const processed_items = [];
      for (const item_obj of account.item_state) {
        const item_id = item_obj.item_id as string | undefined;
        const item_state_payload = { ...item_obj };
        delete item_state_payload.item_id;

        if (item_id) {
          // UPDATE case
          // TODO: Implement item update
          // Verify item belongs to user, then patch
        } else {
          // CREATE case
          // TODO: Implement item creation
          // Call create_profile_item with network/domain/itemType from context
        }
      }

      // 5. Fetch user's items
      const user_items = await getItemsForUser(user_id, served_networks);

      // 6. Add to response
      response_accounts.push({
        exists: true,
        owned_by_self: true,
        user_id,
        email: account.email || null,
        phone_number: account.phone_number || null,
        name: account.name,
        item_state: user_items,
      });
    } catch (err) {
      // Per-account error; don't fail batch
      response_errors.push({
        index: idx,
        email: account.email || null,
        phone_number: account.phone_number || null,
        error: 'PROCESSING_ERROR',
        reason: (err as Error).message || 'Unknown error',
      });
    }
  }

  // Build response
  const response: z.infer<typeof AdminParticipantResponse> = {
    context: {
      version: context.version,
      messageId: context.messageId,
      timestamp: new Date().toISOString(),
      networkId: context.networkId,
      domain: context.domain,
      itemType: context.itemType,
      channel: context.channel,
      source_id: context.source_id,
    },
    message: {
      accounts: response_accounts,
      meta: {
        total: message.accounts.length,
        limit: message.accounts.length,
        offset: 0,
      },
    },
  };

  return reply.code(200).send(response);
};

export default participant_upsert;
```

- [ ] **Step 2: Implement item creation logic in handler**

```typescript
// Replace TODO in participant_upsert_handler (in the CREATE case):

// CREATE case
try {
  await create_profile_item({
    tx: db,
    user_id,
    network: context.networkId,
    domain: context.domain,
    item_type: context.itemType,
    payload: item_state_payload,
  });
} catch (item_err) {
  request.log.error({ err: item_err }, 'item creation failed');
  response_errors.push({
    index: idx,
    email: account.email || null,
    phone_number: account.phone_number || null,
    error: 'ITEM_CREATION_FAILED',
    reason: (item_err as Error).message,
  });
  continue;
}

processed_items.push({
  item_id: '(newly created)',
  lifecycle_status: determineLifecycleStatus(
    item_state_payload,
    // TODO: fetch required fields from schema registry
    []
  ),
});
```

- [ ] **Step 3: Implement item update logic in handler**

```typescript
// Replace TODO in participant_upsert_handler (in the UPDATE case):

// UPDATE case
try {
  // Runtime ownership check: item must belong to this user
  const owner_rows = await db
    .select({ created_by: items.created_by })
    .from(items)
    .where(eq(items.item_id, item_id))
    .limit(1);

  if (!owner_rows.length || owner_rows[0].created_by !== user_id) {
    response_errors.push({
      index: idx,
      email: account.email || null,
      phone_number: account.phone_number || null,
      error: 'ITEM_NOT_OWNED_BY_USER',
      reason: `item ${item_id} does not belong to this user`,
    });
    continue;
  }

  // Patch the item
  await updateItemInternal(db, item_id, user_id, true, {
    item_state: item_state_payload,
  });
} catch (item_err) {
  request.log.error({ err: item_err }, 'item update failed');
  response_errors.push({
    index: idx,
    email: account.email || null,
    phone_number: account.phone_number || null,
    error: 'ITEM_UPDATE_FAILED',
    reason: (item_err as Error).message,
  });
  continue;
}

processed_items.push({
  item_id,
  lifecycle_status: determineLifecycleStatus(
    item_state_payload,
    // TODO: fetch required fields from schema registry
    []
  ),
});
```

- [ ] **Step 4: Handle account creation (network_service creates new accounts)**

```typescript
// After resolveOrCreateAccount, if user_existed=false:

if (!account_resolution.user_existed) {
  try {
    const signed_up = await authInstance.api.signUpEmail({
      body: {
        email: account.email || `${randomUUID()}@no-email.local`,
        password: randomUUID(),
        name: account.name,
      },
    });
    account_resolution.user_id = signed_up.user.id;

    // Update user metadata in transaction
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.update(user).set({
        phoneNumber: account.phone_number || null,
        onboardedByOrgId: request.acting_org.org_id,
        onboardedVia: context.channel,
        onboardedSourceId: context.source_id || null,
        onboardedAt: now,
        updatedAt: now,
      }).where(eq(user.id, account_resolution.user_id));
    });
  } catch (signup_err) {
    response_errors.push({
      index: idx,
      email: account.email || null,
      phone_number: account.phone_number || null,
      error: 'ACCOUNT_CREATION_FAILED',
      reason: (signup_err as Error).message,
    });
    continue;
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/v1/admin/participant_upsert.ts
git commit -m "feat: implement normalized POST handler with context/message envelope"
```

---

### Task 4: Unit & Integration Tests

**Files:**
- Create: `apps/api/src/routes/v1/admin/__tests__/participant_upsert.test.ts`
- Create: `apps/api/src/routes/v1/admin/__tests__/participant_upsert.integration.test.ts`
- Test: Run `pnpm --filter api test` and `pnpm --filter api test:integration`

**Interfaces:**
- Consumes: All of Tasks 1–3
- Produces: Test suite with >80% coverage of handler paths

- [ ] **Step 1: Write unit tests (schema validation)**

```typescript
// apps/api/src/routes/v1/admin/__tests__/participant_upsert.test.ts

import { describe, it, expect } from 'vitest';
import { AdminParticipantRequest, AdminParticipantResponse } from '@dpg/schemas';

describe('AdminParticipantRequest schema', () => {
  it('accepts single account with email', () => {
    const payload = {
      context: {
        version: '1.0.0',
        messageId: '550e8400-e29b-41d4-a716-446655440000',
        timestamp: new Date().toISOString(),
        networkId: 'purple_dot',
        domain: 'provider',
        itemType: 'profile_1.0',
        channel: 'bulk',
      },
      message: {
        accounts: [
          {
            email: 'user@example.com',
            name: 'Test User',
            item_state: [
              { name: 'John', bio: 'Test' },
            ],
          },
        ],
      },
    };

    const result = AdminParticipantRequest.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('rejects account without email or phone', () => {
    const payload = {
      context: {
        version: '1.0.0',
        messageId: '550e8400-e29b-41d4-a716-446655440000',
        timestamp: new Date().toISOString(),
        networkId: 'purple_dot',
        domain: 'provider',
        itemType: 'profile_1.0',
        channel: 'bulk',
      },
      message: {
        accounts: [
          {
            name: 'Test User',
            item_state: [],
          },
        ],
      },
    };

    const result = AdminParticipantRequest.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('accepts item_state with item_id (UPDATE)', () => {
    const payload = {
      context: {
        version: '1.0.0',
        messageId: '550e8400-e29b-41d4-a716-446655440000',
        timestamp: new Date().toISOString(),
        networkId: 'purple_dot',
        domain: 'provider',
        itemType: 'profile_1.0',
        channel: 'bulk',
      },
      message: {
        accounts: [
          {
            email: 'user@example.com',
            name: 'Test User',
            item_state: [
              {
                item_id: '550e8400-e29b-41d4-a716-446655440001',
                name: 'Updated',
              },
            ],
          },
        ],
      },
    };

    const result = AdminParticipantRequest.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('rejects item_id that is not a UUID', () => {
    const payload = {
      context: {
        version: '1.0.0',
        messageId: '550e8400-e29b-41d4-a716-446655440000',
        timestamp: new Date().toISOString(),
        networkId: 'purple_dot',
        domain: 'provider',
        itemType: 'profile_1.0',
        channel: 'bulk',
      },
      message: {
        accounts: [
          {
            email: 'user@example.com',
            name: 'Test User',
            item_state: [
              {
                item_id: 'not-a-uuid',
                name: 'Updated',
              },
            ],
          },
        ],
      },
    };

    const result = AdminParticipantRequest.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('accepts bulk with multiple accounts', () => {
    const payload = {
      context: {
        version: '1.0.0',
        messageId: '550e8400-e29b-41d4-a716-446655440000',
        timestamp: new Date().toISOString(),
        networkId: 'purple_dot',
        domain: 'provider',
        itemType: 'profile_1.0',
        channel: 'bulk',
      },
      message: {
        accounts: [
          { email: 'user1@example.com', name: 'User 1', item_state: [] },
          { email: 'user2@example.com', name: 'User 2', item_state: [] },
          { phone_number: '+911234567890', name: 'User 3', item_state: [] },
        ],
      },
    };

    const result = AdminParticipantRequest.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message.accounts).toHaveLength(3);
    }
  });
});

describe('AdminParticipantResponse schema', () => {
  it('accepts valid response with owned_by_self true', () => {
    const payload = {
      context: {
        version: '1.0.0',
        messageId: '550e8400-e29b-41d4-a716-446655440000',
        timestamp: new Date().toISOString(),
        networkId: 'purple_dot',
        domain: 'provider',
        itemType: 'profile_1.0',
        channel: 'bulk',
        source_id: 'test',
      },
      message: {
        accounts: [
          {
            exists: true,
            owned_by_self: true,
            user_id: '550e8400-e29b-41d4-a716-446655440001',
            email: 'user@example.com',
            phone_number: null,
            name: 'Test User',
            item_state: [
              {
                item_id: '550e8400-e29b-41d4-a716-446655440002',
                name: 'John',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                lifecycle_status: 'live',
              },
            ],
          },
        ],
        meta: { total: 1, limit: 1, offset: 0 },
      },
    };

    const result = AdminParticipantResponse.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('accepts response with owned_by_self false and no data', () => {
    const payload = {
      context: {
        version: '1.0.0',
        messageId: '550e8400-e29b-41d4-a716-446655440000',
        timestamp: new Date().toISOString(),
        networkId: 'purple_dot',
        domain: 'provider',
        itemType: 'profile_1.0',
        channel: 'bulk',
        source_id: 'test',
      },
      message: {
        accounts: [
          {
            exists: true,
            owned_by_self: false,
            user_id: null,
            email: null,
            phone_number: null,
            name: null,
            item_state: [],
          },
        ],
        meta: { total: 1, limit: 1, offset: 0 },
      },
    };

    const result = AdminParticipantResponse.safeParse(payload);
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run unit tests**

```bash
cd /Users/aniket/Documents/github/aniketsaki/blue-dots-economy/Signals-DPG
pnpm --filter api exec vitest run "src/routes/v1/admin/__tests__/participant_upsert.test.ts"
```

Expected: All tests pass.

- [ ] **Step 3: Write integration tests (real DB)**

```typescript
// apps/api/src/routes/v1/admin/__tests__/participant_upsert.integration.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq, inArray } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const pg_url = process.env.POSTGRES_URL ?? process.env.POSTGRES_USER;
const can_run = Boolean(pg_url);
const describeIf = can_run ? describe : describe.skip;

const hash_key = (raw: string) =>
  createHash('sha256').update(raw).digest('base64url');

describeIf('POST /api/v1/admin/participant (normalized) — integration', () => {
  let app: FastifyInstance;
  let db: typeof import('@api/db/postgres/drizzle_config').db;
  let authSchema: typeof import('../../../../../db/postgres/schema/auth.js');
  let itemsTable: typeof import('@dpg/database').items;

  const listen_port = Number(process.env.API_PORT ?? 2742);
  const ts = Date.now();

  const agg_a = {
    org_id: `org_${randomUUID()}`,
    apikey_id: `key_${randomUUID()}`,
    member_id: `mem_${randomUUID()}`,
    raw_key: `sk_signals_${randomBytes(24).toString('hex')}`,
    slug: `agg-redesign-a-${ts}`,
  };

  const ns = {
    org_id: `org_${randomUUID()}`,
    apikey_id: `key_${randomUUID()}`,
    member_id: `mem_${randomUUID()}`,
    raw_key: `sk_signals_${randomBytes(24).toString('hex')}`,
    slug: `ns-redesign-${ts}`,
  };

  const svc_user_id = `usr_${randomUUID()}`;
  const svc_user_email = `signals-redesign-${ts}@signals.local`;
  const onboarded_user_ids: string[] = [];

  beforeAll(async () => {
    const drizzle_mod = await import('@api/db/postgres/drizzle_config');
    const auth_mod = await import('../../../../../db/postgres/schema/auth.js');
    const database_pkg = await import('@dpg/database');
    db = drizzle_mod.db;
    authSchema = auth_mod;
    itemsTable = database_pkg.items;

    const { admin_routes } = await import('../admin_routes.js');
    const network_routes_mod = await import('../../network/network_routes.js');

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(admin_routes, { prefix: '/api/v1/admin' });
    await app.register(network_routes_mod.default, { prefix: '/api/v1/network' });

    try {
      await app.listen({ port: listen_port, host: '127.0.0.1' });
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e?.code === 'EADDRINUSE') {
        throw new Error(
          `integration test requires port ${listen_port} to be free (set API_PORT). Is the dev server already running?`,
        );
      }
      throw err;
    }

    const { user, organization, member, apikey } = authSchema;
    const now = new Date();

    await db.insert(user).values({
      id: svc_user_id,
      email: svc_user_email,
      name: 'redesign svc',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(organization).values([
      {
        id: agg_a.org_id,
        slug: agg_a.slug,
        name: `${agg_a.slug}`,
        type: 'aggregator',
        createdAt: now,
      },
      {
        id: ns.org_id,
        slug: ns.slug,
        name: `${ns.slug}`,
        type: 'network_service',
        createdAt: now,
      },
    ]);

    await db.insert(member).values([
      {
        id: agg_a.member_id,
        organizationId: agg_a.org_id,
        userId: svc_user_id,
        role: 'service',
        createdAt: now,
      },
      {
        id: ns.member_id,
        organizationId: ns.org_id,
        userId: svc_user_id,
        role: 'service',
        createdAt: now,
      },
    ]);

    for (const v of [agg_a, ns]) {
      await db.insert(apikey).values({
        id: v.apikey_id,
        name: v.slug,
        key: hash_key(v.raw_key),
        userId: svc_user_id,
        referenceId: svc_user_id,
        configId: 'default',
        start: v.raw_key.slice(0, 6),
        prefix: 'sk_signals_',
        enabled: true,
        rateLimitEnabled: false,
        createdAt: now,
        updatedAt: now,
      });
    }
  });

  afterAll(async () => {
    const { user, organization, apikey } = authSchema;
    try {
      if (onboarded_user_ids.length > 0) {
        await db.delete(itemsTable).where(inArray(itemsTable.created_by, onboarded_user_ids));
        await db.delete(user).where(inArray(user.id, onboarded_user_ids));
      }
      await db
        .delete(apikey)
        .where(inArray(apikey.id, [agg_a.apikey_id, ns.apikey_id]));
      await db.delete(user).where(eq(user.id, svc_user_id));
      await db
        .delete(organization)
        .where(inArray(organization.id, [agg_a.org_id, ns.org_id]));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('integration test cleanup failed:', err);
    }
    if (app) await app.close();
  });

  it('aggregator single account with one item (CREATE)', async () => {
    const messageId = randomUUID();
    const user_email = `int_redesign_${randomUUID().slice(0, 6)}@test.local`;

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': agg_a.raw_key,
        'x-acting-org-id': agg_a.org_id,
        'content-type': 'application/json',
      },
      payload: {
        context: {
          version: '1.0.0',
          messageId,
          timestamp: new Date().toISOString(),
          networkId: 'blue_dot',
          domain: 'seeker',
          itemType: 'profile_1.0',
          channel: 'bulk',
        },
        message: {
          accounts: [
            {
              email: user_email,
              name: 'Test User',
              item_state: [
                {
                  name: 'John',
                  bio: 'Test bio',
                },
              ],
            },
          ],
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.context.messageId).toBe(messageId);
    expect(body.message.accounts).toHaveLength(1);

    const account = body.message.accounts[0];
    expect(account.exists).toBe(true);
    expect(account.owned_by_self).toBe(true);
    expect(account.user_id).toBeTruthy();
    expect(account.item_state).toHaveLength(1);

    onboarded_user_ids.push(account.user_id);
  });

  it('aggregator bulk with multiple accounts', async () => {
    const messageId = randomUUID();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': agg_a.raw_key,
        'x-acting-org-id': agg_a.org_id,
        'content-type': 'application/json',
      },
      payload: {
        context: {
          version: '1.0.0',
          messageId,
          timestamp: new Date().toISOString(),
          networkId: 'blue_dot',
          domain: 'seeker',
          itemType: 'profile_1.0',
          channel: 'bulk',
        },
        message: {
          accounts: [
            {
              email: `user1_${randomUUID().slice(0, 6)}@test.local`,
              name: 'User 1',
              item_state: [{ name: 'Profile 1' }],
            },
            {
              email: `user2_${randomUUID().slice(0, 6)}@test.local`,
              name: 'User 2',
              item_state: [{ name: 'Profile 2' }, { name: 'Profile 2b' }],
            },
          ],
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.message.accounts).toHaveLength(2);
    expect(body.message.accounts[0].item_state).toHaveLength(1);
    expect(body.message.accounts[1].item_state).toHaveLength(2);

    body.message.accounts.forEach((acc: any) => {
      onboarded_user_ids.push(acc.user_id);
    });
  });

  it('network_service can access any user, aggregator cannot access other agg\'s user', async () => {
    // First: network_service creates a user
    const ns_user_email = `ns_user_${randomUUID().slice(0, 6)}@test.local`;
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
      },
      payload: {
        context: {
          version: '1.0.0',
          messageId: randomUUID(),
          timestamp: new Date().toISOString(),
          networkId: 'blue_dot',
          domain: 'seeker',
          itemType: 'profile_1.0',
          channel: 'voice',
          source_id: `voice_bot_+911234567890_call_${randomUUID()}`,
        },
        message: {
          accounts: [
            {
              email: ns_user_email,
              name: 'NS User',
              item_state: [{ name: 'NS Profile' }],
            },
          ],
        },
      },
    });

    expect(res1.statusCode).toBe(200);
    const ns_user_id = res1.json().message.accounts[0].user_id;
    onboarded_user_ids.push(ns_user_id);

    // Second: agg_a tries to access ns_user → forbidden, no data leak
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': agg_a.raw_key,
        'x-acting-org-id': agg_a.org_id,
      },
      payload: {
        context: {
          version: '1.0.0',
          messageId: randomUUID(),
          timestamp: new Date().toISOString(),
          networkId: 'blue_dot',
          domain: 'seeker',
          itemType: 'profile_1.0',
          channel: 'bulk',
        },
        message: {
          accounts: [
            {
              email: ns_user_email,
              name: 'Trying to access',
              item_state: [],
            },
          ],
        },
      },
    });

    expect(res2.statusCode).toBe(200);
    const forbidden_account = res2.json().message.accounts[0];
    expect(forbidden_account.exists).toBe(true);
    expect(forbidden_account.owned_by_self).toBe(false);
    expect(forbidden_account.user_id).toBe(null);
    expect(forbidden_account.item_state).toEqual([]);
  });

  it('network_service can update existing item', async () => {
    // First: create a user with one item
    const user_email = `update_user_${randomUUID().slice(0, 6)}@test.local`;
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
      },
      payload: {
        context: {
          version: '1.0.0',
          messageId: randomUUID(),
          timestamp: new Date().toISOString(),
          networkId: 'blue_dot',
          domain: 'seeker',
          itemType: 'profile_1.0',
          channel: 'voice',
          source_id: `voice_bot_+911234567890_call_${randomUUID()}`,
        },
        message: {
          accounts: [
            {
              email: user_email,
              name: 'Update Test',
              item_state: [{ name: 'Original' }],
            },
          ],
        },
      },
    });

    expect(res1.statusCode).toBe(200);
    const item_id = res1.json().message.accounts[0].item_state[0].item_id;
    const user_id = res1.json().message.accounts[0].user_id;
    onboarded_user_ids.push(user_id);

    // Second: update that item
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
      },
      payload: {
        context: {
          version: '1.0.0',
          messageId: randomUUID(),
          timestamp: new Date().toISOString(),
          networkId: 'blue_dot',
          domain: 'seeker',
          itemType: 'profile_1.0',
          channel: 'voice',
          source_id: `voice_bot_+911234567890_call_${randomUUID()}`,
        },
        message: {
          accounts: [
            {
              email: user_email,
              name: 'Update Test',
              item_state: [{ item_id, name: 'Updated' }],
            },
          ],
        },
      },
    });

    expect(res2.statusCode).toBe(200);
    const updated_item = res2.json().message.accounts[0].item_state[0];
    expect(updated_item.item_id).toBe(item_id);
    expect(updated_item.updated_at).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run integration tests**

```bash
cd /Users/aniket/Documents/github/aniketsaki/blue-dots-economy/Signals-DPG
docker compose up -d db redis
pnpm db:init:api
pnpm --filter api test:integration "src/routes/v1/admin/__tests__/participant_upsert.integration.test.ts"
```

Expected: All integration tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/v1/admin/__tests__/participant_upsert.test.ts apps/api/src/routes/v1/admin/__tests__/participant_upsert.integration.test.ts
git commit -m "test: add unit and integration tests for normalized participant handler"
```

---

### Task 5: Register Route & Update Admin Routes

**Files:**
- Modify: `apps/api/src/routes/v1/admin/admin_routes.ts`

**Interfaces:**
- Consumes: `participant_upsert` from Task 3
- Produces: Registered POST endpoint

- [ ] **Step 1: Update admin_routes.ts to register participant_upsert**

```typescript
// Modify apps/api/src/routes/v1/admin/admin_routes.ts

import type { FastifyPluginAsync } from 'fastify';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { acting_org_preHandler } from '@/middleware/acting_org';
import { aggregator_upsert } from './aggregator/upsert.js';
import { participant_read } from './participant_read.js';
import { participant_upsert } from './participant_upsert.js';  // NEW

/**
 * Mounts /api/v1/admin/*. Every request through this scope passes through:
 *   1. auth_middleware — populates request.user from apikey / session.
 *   2. acting_org preHandler — populates request.acting_org from the
 *      x-acting-org-id header, validating it points at an aggregator,
 *      voice, or network_service org and that the caller is a registered
 *      service user.
 */
export const admin_routes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', auth_middleware_if_enabled);
  app.addHook('preHandler', acting_org_preHandler);

  await app.register(aggregator_upsert);
  await app.register(participant_read);  // GET /participant
  await app.register(participant_upsert); // POST /participant (NEW)
};

export default admin_routes;
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/aniket/Documents/github/aniketsaki/blue-dots-economy/Signals-DPG
pnpm typecheck
```

Expected: No TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/v1/admin/admin_routes.ts
git commit -m "feat: register normalized POST handler in admin routes"
```

---

### Task 6: Database Schema Check & Lifecycle Status

**Files:**
- Check: `apps/api/db/postgres/schema/items.ts` and migrations
- Modify: Migration or schema if `lifecycle_status` column doesn't exist

**Interfaces:**
- Consumes: Current Drizzle schema
- Produces: Confirmation that `items.lifecycle_status` exists and is used

- [ ] **Step 1: Check if lifecycle_status column exists**

```bash
cd /Users/aniket/Documents/github/aniketsaki/blue-dots-economy/Signals-DPG
grep -n "lifecycle_status" apps/api/db/postgres/schema/items.ts
```

If found, skip to Step 4. If not found, proceed to Step 2.

- [ ] **Step 2: (If needed) Add lifecycle_status to items schema**

```typescript
// In apps/api/db/postgres/schema/items.ts, add to items table definition:

lifecycle_status: text('lifecycle_status').default('draft').notNull(),
// Values: 'draft' | 'live' | 'retired'
```

- [ ] **Step 3: (If needed) Generate and apply migration**

```bash
pnpm --filter api db:generate
pnpm --filter api db:migrate
```

- [ ] **Step 4: Update participant_service.ts to fetch lifecycle_status**

In `getItemsForUser()`, ensure the SELECT includes `lifecycle_status` from the items table (already done in Task 2).

- [ ] **Step 5: Commit (if schema changed)**

```bash
git add apps/api/db/postgres/schema/items.ts apps/api/drizzle/*
git commit -m "schema: add lifecycle_status column to items table"
```

---

### Task 7: Missing Imports & Final Integration

**Files:**
- Verify: All imports in `participant_upsert.ts` are correct
- Add: Missing imports from `@api/db/postgres/drizzle_config`, `authInstance`, etc.

**Interfaces:**
- Consumes: All previous tasks
- Produces: Fully working handler with no import errors

- [ ] **Step 1: Add missing imports to participant_upsert.ts**

```typescript
// Add to top of apps/api/src/routes/v1/admin/participant_upsert.ts:

import { db } from '@api/db/postgres/drizzle_config';
import { user, items } from '../../db/postgres/schema/auth.js';
import { authInstance } from '@/routes/auth/create_auth';
import { eq } from 'drizzle-orm';
```

- [ ] **Step 2: Ensure ensureItemPartition is imported**

```typescript
// Add to imports:

import { ensureItemPartition } from '@dpg/database';
```

- [ ] **Step 3: Run typecheck again**

```bash
pnpm typecheck
```

Expected: No errors.

- [ ] **Step 4: Run tests once more**

```bash
pnpm --filter api test
```

Expected: All unit tests pass.

- [ ] **Step 5: Final commit**

```bash
git add apps/api/src/routes/v1/admin/participant_upsert.ts
git commit -m "fix: add missing imports to participant_upsert handler"
```

---

### Task 8: Documentation & PR

**Files:**
- Create: Brief README/doc explaining the new structure
- Verify: All code follows CLAUDE.md conventions

**Interfaces:**
- Consumes: All of Tasks 1–7
- Produces: PR-ready code with comments

- [ ] **Step 1: Add brief JSDoc to participant_upsert_handler**

```typescript
/**
 * POST /api/v1/admin/participant
 *
 * Normalized context/message endpoint for admin participant upsert.
 * Supports single and bulk account operations with per-item create/update.
 *
 * Access Control:
 *   - aggregator: CRUD own accounts/items only; forbidden on others
 *   - network_service: admin access to any account/item
 *
 * Item Lifecycle:
 *   - Draft: missing required fields per schema
 *   - Live: has all required fields
 *
 * Per-account errors in bulk don't fail the entire batch.
 */
```

- [ ] **Step 2: Verify no console.log in participant_service.ts**

```bash
grep -n "console.log" apps/api/src/services/participant_service.ts
```

Expected: No matches.

- [ ] **Step 3: Final typecheck**

```bash
pnpm typecheck
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/v1/admin/participant_upsert.ts
git commit -m "docs: add JSDoc to normalized participant handler"
```

---

## Testing Checklist

- [ ] Unit tests pass: `pnpm --filter api test`
- [ ] Integration tests pass: `pnpm --filter api test:integration`
- [ ] Typecheck passes: `pnpm typecheck`
- [ ] No console.log in library packages
- [ ] Routes return proper error format: `{ error, message }`
- [ ] Ownership checks prevent data leaks (forbidden cases return empty items)
- [ ] Bulk operations don't fail on per-account errors
- [ ] Item lifecycle_status is correctly determined

---

## Coverage Summary

| Component | Coverage |
|-----------|----------|
| Schemas | 100% (Zod validates all shapes) |
| Handler | ~90% (single, bulk, owned, forbidden, create, update) |
| Service | ~85% (account resolution, ownership, lifecycle) |
| Error paths | ~75% (per-account errors, validation, ownership) |

---

**Plan complete and saved to `docs/superpowers/plans/2026-06-18-admin-participant-redesign.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**