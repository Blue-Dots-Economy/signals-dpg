import { describe, it, expect } from 'vitest';
import { compute_profile_status } from '../profile_status.js';

// Fixed `now` for deterministic age/idle calculations.
const now = new Date('2026-06-01T00:00:00Z');
const daysAgo = (n: number) =>
  new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

describe('compute_profile_status', () => {
  describe('satisfied (any accepted application)', () => {
    it('returns satisfied when applications_accepted > 0, regardless of other state', () => {
      expect(compute_profile_status({
        profile_created_at: daysAgo(1),
        profile_last_updated_at: daysAgo(1),
        applications_total: 1,
        applications_accepted: 1,
        now,
      })).toBe('satisfied');
    });

    it('returns satisfied even when also long-idle (acceptance wins over inactive)', () => {
      expect(compute_profile_status({
        profile_created_at: daysAgo(365),
        profile_last_updated_at: daysAgo(180),
        applications_total: 3,
        applications_accepted: 1,
        now,
      })).toBe('satisfied');
    });
  });

  describe('new (< 7 days old, no applications)', () => {
    it('returns new at age_days=0', () => {
      expect(compute_profile_status({
        profile_created_at: now,
        profile_last_updated_at: now,
        applications_total: 0,
        applications_accepted: 0,
        now,
      })).toBe('new');
    });

    it('returns new at age_days=6', () => {
      expect(compute_profile_status({
        profile_created_at: daysAgo(6),
        profile_last_updated_at: daysAgo(6),
        applications_total: 0,
        applications_accepted: 0,
        now,
      })).toBe('new');
    });

    it('does NOT return new at age_days=7 (boundary: age_days < 7)', () => {
      expect(compute_profile_status({
        profile_created_at: daysAgo(7),
        profile_last_updated_at: daysAgo(7),
        applications_total: 0,
        applications_accepted: 0,
        now,
      })).not.toBe('new');
    });

    it('does NOT return new if any applications exist (even within 7 days)', () => {
      expect(compute_profile_status({
        profile_created_at: daysAgo(1),
        profile_last_updated_at: daysAgo(1),
        applications_total: 1,
        applications_accepted: 0,
        now,
      })).not.toBe('new');
    });
  });

  describe('inactive (> 90 idle days, no acceptance)', () => {
    it('returns inactive at idle_days=91', () => {
      expect(compute_profile_status({
        profile_created_at: daysAgo(120),
        profile_last_updated_at: daysAgo(91),
        applications_total: 0,
        applications_accepted: 0,
        now,
      })).toBe('inactive');
    });

    it('does NOT return inactive at idle_days=90 exactly (boundary: idle_days > 90)', () => {
      expect(compute_profile_status({
        profile_created_at: daysAgo(120),
        profile_last_updated_at: daysAgo(90),
        applications_total: 5,
        applications_accepted: 0,
        now,
      })).toBe('at_risk');
    });
  });

  describe('at_risk (> 30 idle days, ≤ 90, no acceptance)', () => {
    it('returns at_risk at idle_days=31', () => {
      expect(compute_profile_status({
        profile_created_at: daysAgo(60),
        profile_last_updated_at: daysAgo(31),
        applications_total: 5,
        applications_accepted: 0,
        now,
      })).toBe('at_risk');
    });

    it('does NOT return at_risk at idle_days=30 exactly', () => {
      expect(compute_profile_status({
        profile_created_at: daysAgo(60),
        profile_last_updated_at: daysAgo(30),
        applications_total: 5,
        applications_accepted: 0,
        now,
      })).toBe('active');
    });

    it('returns at_risk at idle_days=90 exactly (still inside at_risk band)', () => {
      expect(compute_profile_status({
        profile_created_at: daysAgo(120),
        profile_last_updated_at: daysAgo(90),
        applications_total: 5,
        applications_accepted: 0,
        now,
      })).toBe('at_risk');
    });
  });

  describe('active (fallthrough)', () => {
    it('returns active for a non-new profile with no acceptance and recent activity', () => {
      expect(compute_profile_status({
        profile_created_at: daysAgo(45),
        profile_last_updated_at: daysAgo(10),
        applications_total: 3,
        applications_accepted: 0,
        now,
      })).toBe('active');
    });

    it('returns active for an old profile updated yesterday with pending apps', () => {
      expect(compute_profile_status({
        profile_created_at: daysAgo(180),
        profile_last_updated_at: daysAgo(1),
        applications_total: 5,
        applications_accepted: 0,
        now,
      })).toBe('active');
    });
  });
});
