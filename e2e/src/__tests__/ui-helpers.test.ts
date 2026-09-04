import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDomainLabel } from '../ui.ts';

test('a configured label wins over the title-cased id', () => {
  const domains = [{ id: 'provider', label: 'Service Provider' }, { id: 'seeker' }];
  assert.equal(formatDomainLabel('provider', domains), 'Service Provider');
});

test('an unlabelled domain falls back to the title-cased id', () => {
  assert.equal(formatDomainLabel('seeker', [{ id: 'seeker' }]), 'Seeker');
  assert.equal(formatDomainLabel('individual_tutor', []), 'Individual Tutor');
});

test('a blank label is not treated as configured', () => {
  assert.equal(formatDomainLabel('provider', [{ id: 'provider', label: '   ' }]), 'Provider');
});
