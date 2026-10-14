import { describe, it, expect } from 'vitest';
import { getExportableStatuses, type ExportEligibilityConfig } from '../export_eligibility';

// #771 follow-up: which action statuses a requester may export = the reveal
// statuses of every interaction that lets their domain export.

const cfg: ExportEligibilityConfig = {
  id: 'n',
  actions: {
    apply: {
      interactions: [
        { from_domain: 'seeker', to_domain: 'provider', reveals_pii_on_status: ['accepted', 'completed'], export: { requester_domains: ['provider'] } },
      ],
    },
    connect: {
      interactions: [
        { from_domain: 'provider', to_domain: 'seeker', reveals_pii_on_status: ['accepted'], export: { requester_domains: ['provider'] } },
        { from_domain: 'seeker', to_domain: 'service_provider', reveals_pii_on_status: ['hired'], export: { requester_domains: ['service_provider'] } },
        { from_domain: 'provider', to_domain: 'provider', reveals_pii_on_status: ['shortlisted'] },
      ],
    },
  },
};

describe('getExportableStatuses', () => {
  it('unions the reveal statuses of interactions the domain may export, sorted', () => {
    expect(getExportableStatuses(cfg, 'provider')).toEqual(['accepted', 'completed']);
  });

  it('ignores interactions without an export block for the domain', () => {
    expect(getExportableStatuses(cfg, 'provider')).not.toContain('shortlisted');
    expect(getExportableStatuses(cfg, 'service_provider')).toEqual(['hired']);
  });

  it('a domain that may not export anything → no statuses', () => {
    expect(getExportableStatuses(cfg, 'seeker')).toEqual([]);
  });

  it('tolerates an interaction with no reveal statuses', () => {
    const c: ExportEligibilityConfig = {
      id: 'n',
      actions: { a: { interactions: [{ from_domain: 'x', to_domain: 'y', export: { requester_domains: ['x'] } }] } },
    };
    expect(getExportableStatuses(c, 'x')).toEqual([]);
  });
});
