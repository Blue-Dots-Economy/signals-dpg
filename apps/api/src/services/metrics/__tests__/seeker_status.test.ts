import { describe, it, expect } from 'vitest';
import { compute_seeker_status } from '../seeker_status.js';

const NOW = new Date('2026-05-22T00:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

describe('compute_seeker_status', () => {
  it("returns 'new' when profile_age <= 7 days", () => {
    expect(compute_seeker_status({
      profile_created_at: daysAgo(3),
      last_applied_at: null,
      now: NOW,
    })).toBe('new');
  });

  it("returns 'active' when last_applied_age <= 30 days", () => {
    expect(compute_seeker_status({
      profile_created_at: daysAgo(60),
      last_applied_at: daysAgo(10),
      now: NOW,
    })).toBe('active');
  });

  it("returns 'at_risk' when last_applied_age in 31..90 and profile_age > 7", () => {
    expect(compute_seeker_status({
      profile_created_at: daysAgo(120),
      last_applied_at: daysAgo(45),
      now: NOW,
    })).toBe('at_risk');
  });

  it("returns 'inactive' when last_applied_age > 90 days", () => {
    expect(compute_seeker_status({
      profile_created_at: daysAgo(200),
      last_applied_at: daysAgo(100),
      now: NOW,
    })).toBe('inactive');
  });

  it("returns 'inactive' when never applied and profile_age > 7 days", () => {
    expect(compute_seeker_status({
      profile_created_at: daysAgo(30),
      last_applied_at: null,
      now: NOW,
    })).toBe('inactive');
  });

  it("returns 'new' when never applied and profile_age <= 7 days", () => {
    expect(compute_seeker_status({
      profile_created_at: daysAgo(2),
      last_applied_at: null,
      now: NOW,
    })).toBe('new');
  });
});
