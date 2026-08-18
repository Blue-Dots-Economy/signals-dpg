import { describe, it, expect } from 'vitest';
import { resolvePostLoginRedirect, type ProfileLite } from './post-login-route';

const p = (item_id: string, lifecycle_status: string, item_domain = 'seeker'): ProfileLite => ({
  item_id,
  item_domain,
  lifecycle_status,
});

describe('resolvePostLoginRedirect', () => {
  it('no profiles → create page', () => {
    expect(resolvePostLoginRedirect([], null)).toEqual({ path: '/profile/new' });
  });

  it('all draft, no stored active → edit the first draft', () => {
    const profiles = [p('a', 'draft'), p('b', 'draft')];
    expect(resolvePostLoginRedirect(profiles, null)).toEqual({ path: '/profile/a/edit' });
  });

  it('all draft, stored active is a draft → edit that one', () => {
    const profiles = [p('a', 'draft'), p('b', 'draft')];
    expect(resolvePostLoginRedirect(profiles, 'b')).toEqual({ path: '/profile/b/edit' });
  });

  it('all draft, stored active is not among them → first draft', () => {
    const profiles = [p('a', 'draft'), p('b', 'draft')];
    expect(resolvePostLoginRedirect(profiles, 'gone')).toEqual({ path: '/profile/a/edit' });
  });

  it('has a live profile → no redirect (null), even with other drafts', () => {
    const profiles = [p('live1', 'live', 'provider'), p('d1', 'draft'), p('d2', 'draft')];
    expect(resolvePostLoginRedirect(profiles, 'd1')).toBeNull();
  });

  it('paused counts as completed → no redirect', () => {
    expect(resolvePostLoginRedirect([p('x', 'paused')], null)).toBeNull();
  });

  it('retired counts as completed → no redirect', () => {
    expect(resolvePostLoginRedirect([p('x', 'retired')], null)).toBeNull();
  });

  it('draft + paused → no redirect (paused is completed)', () => {
    expect(resolvePostLoginRedirect([p('d', 'draft'), p('x', 'paused')], 'd')).toBeNull();
  });
});
