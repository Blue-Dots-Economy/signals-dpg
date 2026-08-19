import { describe, it, expect, beforeEach } from 'vitest';
import { setPendingWrongPortal, takePendingWrongPortal } from './pending-wrong-portal';

const NOW = 1_700_000_000_000;

describe('pending-wrong-portal', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('hands the blocked domain across a page load', () => {
    setPendingWrongPortal('seeker', NOW);
    expect(takePendingWrongPortal(NOW + 1_000)).toBe('seeker');
  });

  it('reads once — a second read after the toast has shown finds nothing', () => {
    setPendingWrongPortal('seeker', NOW);
    takePendingWrongPortal(NOW);
    expect(takePendingWrongPortal(NOW)).toBeNull();
  });

  it('returns null when no bounce was parked', () => {
    expect(takePendingWrongPortal(NOW)).toBeNull();
  });

  it('drops a bounce older than the redirect window', () => {
    // Parking and landing are one Keycloak round-trip apart. Anything older is
    // an abandoned logout, and must not ambush a later unrelated visit.
    setPendingWrongPortal('seeker', NOW);
    expect(takePendingWrongPortal(NOW + 6 * 60 * 1000)).toBeNull();
  });

  it('keeps a bounce that is still inside the window', () => {
    setPendingWrongPortal('provider', NOW);
    expect(takePendingWrongPortal(NOW + 4 * 60 * 1000)).toBe('provider');
  });

  it('discards a corrupt payload instead of retrying forever', () => {
    localStorage.setItem('pendingWrongPortal', '{not json');
    expect(takePendingWrongPortal(NOW)).toBeNull();
    expect(localStorage.getItem('pendingWrongPortal')).toBeNull();
  });

  it('ignores a payload with no usable domain', () => {
    localStorage.setItem('pendingWrongPortal', JSON.stringify({ domain: '', at: NOW }));
    expect(takePendingWrongPortal(NOW)).toBeNull();
  });

  it('ignores a payload with no timestamp rather than trusting it forever', () => {
    localStorage.setItem('pendingWrongPortal', JSON.stringify({ domain: 'seeker' }));
    expect(takePendingWrongPortal(NOW)).toBeNull();
  });
});
