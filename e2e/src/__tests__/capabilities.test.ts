import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesFor } from '../capabilities.ts';

const base = {
  otp: { mode: 'test-otp' }, notificationStubUrl: null, mailpitUrl: null,
  keycloakLogContainer: null, db: { url: null }, faultInjection: false,
  deterministicPiiKey: false, auth: { serviceApiKey: null, actingOrgId: null },
  peer: { apiBaseUrl: null }, realSearchUrl: null,
} as never;

test('realSearch is off by default', () => {
  assert.equal(capabilitiesFor(base).realSearch, false);
});

test('realSearch is on when a real search URL is configured', () => {
  const cfg = { ...(base as object), realSearchUrl: 'http://localhost:3100' } as never;
  assert.equal(capabilitiesFor(cfg).realSearch, true);
});

test('a notification stub satisfies notificationStub without mailpit', () => {
  const cfg = { ...(base as object), notificationStubUrl: 'http://localhost:4545' } as never;
  assert.equal(capabilitiesFor(cfg).notificationStub, true);
});
