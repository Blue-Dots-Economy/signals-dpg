import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateFeatures } from '../check-coverage.mjs';

const root = new URL('../../../', import.meta.url).pathname;

test('UI routes come from app.tsx, including the public profile page', () => {
  const f = enumerateFeatures(root);
  assert.ok(f.uiRoutes.includes('/legal'));
  assert.ok(f.uiRoutes.some((r) => r.startsWith('/public/')));
  assert.ok(f.uiRoutes.includes('/my-actions'));
});

test('every email case in the registry is enumerated', () => {
  const f = enumerateFeatures(root);
  assert.ok(f.emailCases.includes('support.request'));
  assert.ok(f.emailCases.includes('guardian.action_bulk'));
  assert.ok(f.emailCases.length >= 19);
});

test('SMS cases are enumerated separately from email', () => {
  const f = enumerateFeatures(root);
  assert.ok(f.smsCases.includes('account.aggregator_init'));
  assert.ok(!f.smsCases.includes('support.request'));
});

test('x-* schema markers in use are enumerated', () => {
  const f = enumerateFeatures(root);
  assert.ok(f.schemaMarkers.includes('x-uri') || f.schemaMarkers.includes('x-form-layout'));
});
