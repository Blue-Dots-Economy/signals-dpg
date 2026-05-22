import { describe, it, expect } from 'vitest';
import { compute_actionable_tags } from '../actionable_tags.js';

const seeker_schema = {
  type: 'object' as const,
  required: ['Full Name', 'Phone Number', 'Email Address'],
  properties: {
    'Full Name': { type: 'string' as const },
    'Phone Number': { type: 'string' as const },
    'Email Address': { type: 'string' as const },
    'Grade': { type: 'string' as const }, // optional
  },
};

describe('compute_actionable_tags', () => {
  describe('schema-derived missing_<field> tags', () => {
    it('emits a missing tag for each required field that is empty', () => {
      const tags = compute_actionable_tags({
        payload: {},
        schema: seeker_schema,
        applications_total: 0,
        applications_rejected: 0,
        idle_days: 0,
      });
      expect(tags).toEqual(
        expect.arrayContaining(['missing_full_name', 'missing_phone_number', 'missing_email_address']),
      );
      // optional 'Grade' should NOT produce a missing tag
      expect(tags).not.toContain('missing_grade');
    });

    it('omits missing tag when required field is populated', () => {
      const tags = compute_actionable_tags({
        payload: { 'Full Name': 'A', 'Phone Number': '9876543210' },
        schema: seeker_schema,
        applications_total: 0,
        applications_rejected: 0,
        idle_days: 0,
      });
      expect(tags).toContain('missing_email_address');
      expect(tags).not.toContain('missing_full_name');
      expect(tags).not.toContain('missing_phone_number');
    });

    it("treats empty string as missing", () => {
      const tags = compute_actionable_tags({
        payload: { 'Full Name': '', 'Phone Number': '9876543210', 'Email Address': 'a@b.com' },
        schema: seeker_schema,
        applications_total: 0,
        applications_rejected: 0,
        idle_days: 0,
      });
      expect(tags).toContain('missing_full_name');
    });

    it('returns no missing tags when schema has no required array', () => {
      const tags = compute_actionable_tags({
        payload: {},
        schema: { type: 'object', properties: { x: { type: 'string' } } },
        applications_total: 0,
        applications_rejected: 0,
        idle_days: 0,
      });
      expect(tags.filter(t => t.startsWith('missing_'))).toEqual([]);
    });

    it('slugifies multi-word and punctuated field names', () => {
      const sch = {
        type: 'object' as const,
        required: ['Student ID', "Mother's Name", 'Service Looking For'],
        properties: {
          'Student ID': { type: 'string' as const },
          "Mother's Name": { type: 'string' as const },
          'Service Looking For': { type: 'string' as const },
        },
      };
      const tags = compute_actionable_tags({
        payload: {},
        schema: sch,
        applications_total: 0,
        applications_rejected: 0,
        idle_days: 0,
      });
      expect(tags).toContain('missing_student_id');
      expect(tags).toContain('missing_mother_s_name');
      expect(tags).toContain('missing_service_looking_for');
    });
  });

  describe('business tags', () => {
    it('emits all_applications_rejected when total > 0 and all rejected', () => {
      const tags = compute_actionable_tags({
        payload: { 'Full Name': 'A', 'Phone Number': '9876543210', 'Email Address': 'a@b.com' },
        schema: seeker_schema,
        applications_total: 3,
        applications_rejected: 3,
        idle_days: 5,
      });
      expect(tags).toContain('all_applications_rejected');
    });

    it('does NOT emit all_applications_rejected when total is 0', () => {
      const tags = compute_actionable_tags({
        payload: { 'Full Name': 'A', 'Phone Number': '9876543210', 'Email Address': 'a@b.com' },
        schema: seeker_schema,
        applications_total: 0,
        applications_rejected: 0,
        idle_days: 5,
      });
      expect(tags).not.toContain('all_applications_rejected');
    });

    it('does NOT emit all_applications_rejected when some applications are not rejected', () => {
      const tags = compute_actionable_tags({
        payload: { 'Full Name': 'A', 'Phone Number': '9876543210', 'Email Address': 'a@b.com' },
        schema: seeker_schema,
        applications_total: 3,
        applications_rejected: 2,
        idle_days: 5,
      });
      expect(tags).not.toContain('all_applications_rejected');
    });

    it('emits no_recent_activity at idle_days=31', () => {
      const tags = compute_actionable_tags({
        payload: { 'Full Name': 'A', 'Phone Number': '9876543210', 'Email Address': 'a@b.com' },
        schema: seeker_schema,
        applications_total: 1,
        applications_rejected: 0,
        idle_days: 31,
      });
      expect(tags).toContain('no_recent_activity');
    });

    it('does NOT emit no_recent_activity at idle_days=30 (strict >)', () => {
      const tags = compute_actionable_tags({
        payload: { 'Full Name': 'A', 'Phone Number': '9876543210', 'Email Address': 'a@b.com' },
        schema: seeker_schema,
        applications_total: 1,
        applications_rejected: 0,
        idle_days: 30,
      });
      expect(tags).not.toContain('no_recent_activity');
    });
  });

  describe('combinations + edges', () => {
    it('returns empty array for a healthy profile', () => {
      const tags = compute_actionable_tags({
        payload: { 'Full Name': 'A', 'Phone Number': '9876543210', 'Email Address': 'a@b.com' },
        schema: seeker_schema,
        applications_total: 2,
        applications_rejected: 0,
        idle_days: 2,
      });
      expect(tags).toEqual([]);
    });

    it('combines schema-derived and business tags', () => {
      const tags = compute_actionable_tags({
        payload: { 'Full Name': 'A' },                       // missing phone + email
        schema: seeker_schema,
        applications_total: 4,
        applications_rejected: 4,                            // all rejected
        idle_days: 45,                                       // > 30
      });
      expect(tags).toEqual(
        expect.arrayContaining([
          'missing_phone_number',
          'missing_email_address',
          'all_applications_rejected',
          'no_recent_activity',
        ]),
      );
      expect(tags).toHaveLength(4);
    });

    it('produces stable order: schema-derived in schema-required order, then business in fixed order', () => {
      const tags = compute_actionable_tags({
        payload: {},
        schema: seeker_schema,
        applications_total: 1,
        applications_rejected: 1,
        idle_days: 35,
      });
      // Order matters for snapshot stability — schema fields first (in
      // required-array order), then all_applications_rejected, then
      // no_recent_activity.
      expect(tags).toEqual([
        'missing_full_name',
        'missing_phone_number',
        'missing_email_address',
        'all_applications_rejected',
        'no_recent_activity',
      ]);
    });
  });
});
