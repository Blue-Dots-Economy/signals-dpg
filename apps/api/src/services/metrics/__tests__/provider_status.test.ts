import { describe, it, expect } from 'vitest';
import { compute_provider_status } from '../provider_status.js';

const NOW = new Date('2026-05-22T00:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

describe('compute_provider_status', () => {
  it("returns 'new' when job_post_age <= 7", () => {
    expect(compute_provider_status({
      profile_created_at: daysAgo(3),
      applications_total: 0,
      applications_shortlisted: 0,
      applications_rejected: 0,
      openings: 5,
      last_shortlisted_at: null,
      last_rejected_at: null,
      now: NOW,
    })).toBe('new');
  });

  it("returns 'satisfied' when decisions >= openings", () => {
    expect(compute_provider_status({
      profile_created_at: daysAgo(30),
      applications_total: 8,
      applications_shortlisted: 5,
      applications_rejected: 0,
      openings: 5,
      last_shortlisted_at: daysAgo(5),
      last_rejected_at: null,
      now: NOW,
    })).toBe('satisfied');
  });

  it("returns 'active' when min_decision_age <= 30 and decisions < openings", () => {
    expect(compute_provider_status({
      profile_created_at: daysAgo(30),
      applications_total: 5,
      applications_shortlisted: 2,
      applications_rejected: 1,
      openings: 10,
      last_shortlisted_at: daysAgo(5),
      last_rejected_at: daysAgo(20),
      now: NOW,
    })).toBe('active');
  });

  it("returns 'at_risk' when min_decision_age in 31..90 and decisions < openings", () => {
    expect(compute_provider_status({
      profile_created_at: daysAgo(100),
      applications_total: 5,
      applications_shortlisted: 2,
      applications_rejected: 1,
      openings: 10,
      last_shortlisted_at: daysAgo(50),
      last_rejected_at: null,
      now: NOW,
    })).toBe('at_risk');
  });

  it("returns 'at_risk' when 7 < job_post_age <= 30 and no applications", () => {
    expect(compute_provider_status({
      profile_created_at: daysAgo(20),
      applications_total: 0,
      applications_shortlisted: 0,
      applications_rejected: 0,
      openings: 5,
      last_shortlisted_at: null,
      last_rejected_at: null,
      now: NOW,
    })).toBe('at_risk');
  });

  it("returns 'inactive' when min_decision_age > 90 and decisions < openings", () => {
    expect(compute_provider_status({
      profile_created_at: daysAgo(200),
      applications_total: 3,
      applications_shortlisted: 1,
      applications_rejected: 0,
      openings: 10,
      last_shortlisted_at: daysAgo(120),
      last_rejected_at: null,
      now: NOW,
    })).toBe('inactive');
  });

  it("returns 'inactive' when 31..90 days old and no applications", () => {
    expect(compute_provider_status({
      profile_created_at: daysAgo(60),
      applications_total: 0,
      applications_shortlisted: 0,
      applications_rejected: 0,
      openings: 5,
      last_shortlisted_at: null,
      last_rejected_at: null,
      now: NOW,
    })).toBe('inactive');
  });

  it("catch-all 'inactive' when job_post_age > 90 and no applications", () => {
    expect(compute_provider_status({
      profile_created_at: daysAgo(180),
      applications_total: 0,
      applications_shortlisted: 0,
      applications_rejected: 0,
      openings: 5,
      last_shortlisted_at: null,
      last_rejected_at: null,
      now: NOW,
    })).toBe('inactive');
  });
});
