import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildExternalApplyUrl, openExternalApply } from '../external-apply';

const NCS = {
  actionType: 'apply',
  urlTemplate: 'https://ncs.gov.in/job-listing/applying/{ncsJobId}',
};

describe('buildExternalApplyUrl', () => {
  it('fills the placeholder from the provider profile', () => {
    expect(buildExternalApplyUrl(NCS, 'apply', { ncsJobId: '2987726' })).toBe(
      'https://ncs.gov.in/job-listing/applying/2987726'
    );
  });

  it('accepts a numeric id and trims whitespace', () => {
    expect(buildExternalApplyUrl(NCS, 'apply', { ncsJobId: 2987726 })).toBe(
      'https://ncs.gov.in/job-listing/applying/2987726'
    );
    expect(buildExternalApplyUrl(NCS, 'apply', { ncsJobId: ' 42 ' })).toBe(
      'https://ncs.gov.in/job-listing/applying/42'
    );
  });

  it('URI-encodes the value so profile data cannot change the target page', () => {
    expect(buildExternalApplyUrl(NCS, 'apply', { ncsJobId: '1/../../admin?x=#y' })).toBe(
      'https://ncs.gov.in/job-listing/applying/1%2F..%2F..%2Fadmin%3Fx%3D%23y'
    );
  });

  it('stays in-app when there is no config', () => {
    expect(buildExternalApplyUrl(null, 'apply', { ncsJobId: '1' })).toBeNull();
    expect(buildExternalApplyUrl(undefined, 'apply', { ncsJobId: '1' })).toBeNull();
  });

  it('stays in-app for a different action type', () => {
    expect(buildExternalApplyUrl(NCS, 'connect', { ncsJobId: '1' })).toBeNull();
  });

  it('stays in-app when the provider has no usable id', () => {
    expect(buildExternalApplyUrl(NCS, 'apply', undefined)).toBeNull();
    expect(buildExternalApplyUrl(NCS, 'apply', {})).toBeNull();
    expect(buildExternalApplyUrl(NCS, 'apply', { ncsJobId: '' })).toBeNull();
    expect(buildExternalApplyUrl(NCS, 'apply', { ncsJobId: '   ' })).toBeNull();
    expect(buildExternalApplyUrl(NCS, 'apply', { ncsJobId: { id: 1 } })).toBeNull();
    expect(buildExternalApplyUrl(NCS, 'apply', { ncsJobId: null })).toBeNull();
  });

  it('refuses a non-https template', () => {
    expect(
      buildExternalApplyUrl(
        { actionType: 'apply', urlTemplate: 'javascript:alert({ncsJobId})' },
        'apply',
        { ncsJobId: '1' }
      )
    ).toBeNull();
  });
});

describe('openExternalApply', () => {
  afterEach(() => vi.restoreAllMocks());

  it('opens a new tab with no opener and no referrer', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openExternalApply('https://ncs.gov.in/job-listing/applying/1');
    expect(open).toHaveBeenCalledWith(
      'https://ncs.gov.in/job-listing/applying/1',
      '_blank',
      'noopener,noreferrer'
    );
  });
});
