import { describe, it, expect } from 'vitest';
import { compute_actionable_tags } from '../actionable_tags.js';

const seekerSchema = {
  type: 'object',
  required: ['Phone Number', 'Email'],
  properties: { 'Phone Number': {}, 'Email': {}, 'Bio': {} },
};

const providerSchema = {
  type: 'object',
  required: ['Company Name', 'Role'],
  properties: { 'Company Name': {}, 'Role': {} },
};

describe('compute_actionable_tags (seeker)', () => {
  it('adds missing_<required> in schema.required order; no business tags when never-applied + no rejects', () => {
    const tags = compute_actionable_tags({
      domain: 'seeker',
      payload: { Email: 'a@b' },
      schema: seekerSchema,
      applications_total: 0,
      applications_rejected: 0,
      job_post_age_days: 0,
      last_applied_age_days: null,
      min_decision_age_days: null,
    });
    expect(tags).toEqual(['missing_phone_number']);
  });

  it("adds 'all_applications_rejected' only when total > 0 AND rejected == total", () => {
    const tags = compute_actionable_tags({
      domain: 'seeker',
      payload: { 'Phone Number': '1', Email: 'a@b' },
      schema: seekerSchema,
      applications_total: 3,
      applications_rejected: 3,
      job_post_age_days: 0,
      last_applied_age_days: 5,
      min_decision_age_days: null,
    });
    expect(tags).toContain('all_applications_rejected');
    expect(tags).not.toContain('no_recent_activity');
  });

  it("adds 'no_recent_activity' when last_applied_age > 30", () => {
    const tags = compute_actionable_tags({
      domain: 'seeker',
      payload: { 'Phone Number': '1', Email: 'a@b' },
      schema: seekerSchema,
      applications_total: 1,
      applications_rejected: 0,
      job_post_age_days: 0,
      last_applied_age_days: 45,
      min_decision_age_days: null,
    });
    expect(tags).toContain('no_recent_activity');
  });
});

describe('compute_actionable_tags (provider)', () => {
  it("adds 'no_applications_yet' when applications_total == 0 AND job_post_age > 7", () => {
    const tags = compute_actionable_tags({
      domain: 'provider',
      payload: { 'Company Name': 'Acme', Role: 'Eng' },
      schema: providerSchema,
      applications_total: 0,
      applications_rejected: 0,
      job_post_age_days: 30,
      last_applied_age_days: null,
      min_decision_age_days: null,
    });
    expect(tags).toContain('no_applications_yet');
  });

  it("does NOT add 'no_applications_yet' when job_post_age <= 7", () => {
    const tags = compute_actionable_tags({
      domain: 'provider',
      payload: { 'Company Name': 'Acme', Role: 'Eng' },
      schema: providerSchema,
      applications_total: 0,
      applications_rejected: 0,
      job_post_age_days: 3,
      last_applied_age_days: null,
      min_decision_age_days: null,
    });
    expect(tags).not.toContain('no_applications_yet');
  });

  it("adds 'decisions_overdue' when min_decision_age > 30", () => {
    const tags = compute_actionable_tags({
      domain: 'provider',
      payload: { 'Company Name': 'Acme', Role: 'Eng' },
      schema: providerSchema,
      applications_total: 5,
      applications_rejected: 1,
      job_post_age_days: 60,
      last_applied_age_days: null,
      min_decision_age_days: 45,
    });
    expect(tags).toContain('decisions_overdue');
  });
});
