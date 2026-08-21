import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { RefObject } from 'react';
import { computeReadProgress, initialProgress, useReadProgress } from '@/components/consent/read-progress';

// Three 300px sections stacked in a 200px-tall viewport.
const sections = [
  { id: 'privacy', top: 0, height: 300 },
  { id: 'terms', top: 300, height: 300 },
  { id: 'profile', top: 600, height: 300 },
];
const scroll = (scrollTop: number) => ({ scrollTop, clientHeight: 200, scrollHeight: 900 });

describe('computeReadProgress', () => {
  it('marks nothing read at the top and makes the first section current', () => {
    const p = computeReadProgress(scroll(0), sections, []);
    expect(p.readIds).toEqual([]);
    expect(p.currentId).toBe('privacy');
    expect(p.allRead).toBe(false);
  });

  it('marks a section read once its bottom passes the viewport bottom', () => {
    // viewport bottom = 100 + 200 = 300 === privacy bottom
    const p = computeReadProgress(scroll(100), sections, []);
    expect(p.readIds).toEqual(['privacy']);
    expect(p.currentId).toBe('terms');
  });

  it('advances fill continuously through the section in hand', () => {
    // privacy read (1 of 2 segments = 50%), halfway through terms adds 25%
    const p = computeReadProgress(scroll(250), sections, []);
    expect(p.readIds).toEqual(['privacy']);
    expect(p.fillPercent).toBeGreaterThan(50);
    expect(p.fillPercent).toBeLessThan(100);
  });

  it('reports every section read and 100% fill at the bottom', () => {
    const p = computeReadProgress(scroll(700), sections, []);
    expect(p.readIds).toEqual(['privacy', 'terms', 'profile']);
    expect(p.currentId).toBeNull();
    expect(p.allRead).toBe(true);
    expect(p.fillPercent).toBe(100);
  });

  it('keeps sections read after scrolling back up', () => {
    const p = computeReadProgress(scroll(0), sections, ['privacy', 'terms']);
    expect(p.readIds).toEqual(['privacy', 'terms']);
    expect(p.currentId).toBe('profile');
  });

  it('treats unscrollable content as fully read — the 111-character case', () => {
    const short = [{ id: 'profile', top: 0, height: 40 }];
    const p = computeReadProgress({ scrollTop: 0, clientHeight: 200, scrollHeight: 40 }, short, []);
    expect(p.allRead).toBe(true);
    expect(p.readIds).toEqual(['profile']);
  });

  it('reports allRead for an empty document list rather than blocking forever', () => {
    const p = computeReadProgress(scroll(0), [], []);
    expect(p.allRead).toBe(true);
    expect(p.currentId).toBeNull();
  });

  it('treats an unmeasured 0x0 container as nothing-read, not everything-read', () => {
    const p = computeReadProgress({ scrollTop: 0, clientHeight: 0, scrollHeight: 0 }, sections, []);
    expect(p.allRead).toBe(false);
    expect(p.readIds).toEqual([]);
    expect(p.currentId).toBe('privacy');
  });
});

describe('initialProgress', () => {
  it('reports allRead false for a non-empty document list before any measurement', () => {
    // Deliberately NOT computeReadProgress({...0x0...}, [], []): that hits the
    // pure function's empty-sections branch, which reports allRead: true so a
    // genuinely empty document list cannot block forever. Bootstrapping a
    // non-empty gate through that branch would render the checkbox enabled
    // for the first frame, before useEffect ever measures anything.
    const p = initialProgress(['privacy', 'terms']);
    expect(p.allRead).toBe(false);
    expect(p.readIds).toEqual([]);
    expect(p.currentId).toBe('privacy');
  });

  it('reports allRead true for a genuinely empty document list', () => {
    const p = initialProgress([]);
    expect(p.allRead).toBe(true);
    expect(p.currentId).toBeNull();
  });

  it('diverges from the old empty-sections bootstrap this replaces', () => {
    // Sanity check that this test can actually fail: the expression this
    // hook used to bootstrap its useState with reports allRead true for any
    // doc list, which is the bug finding 1 fixes.
    const oldBootstrap = computeReadProgress({ scrollTop: 0, clientHeight: 0, scrollHeight: 0 }, [], []);
    expect(oldBootstrap.allRead).toBe(true);
    expect(initialProgress(['privacy', 'terms']).allRead).toBe(false);
  });
});

describe('useReadProgress', () => {
  it('does not report allRead before the first measurement has happened', () => {
    // A null ref means measure() and the mount effect both bail out, so the
    // hook is observed at its bootstrap value. This is the only way to see
    // the pre-measurement state: with a real element, RTL flushes the effect
    // inside act() before renderHook returns, and the bootstrap value is gone.
    const ref: RefObject<HTMLElement | null> = { current: null };
    const { result } = renderHook(() => useReadProgress(ref, ['privacy', 'terms']));
    expect(result.current.allRead).toBe(false);
    expect(result.current.readIds).toEqual([]);
    expect(result.current.currentId).toBe('privacy');
  });

  it('reports allRead for a genuinely empty document list so it cannot deadlock', () => {
    const ref: RefObject<HTMLElement | null> = { current: null };
    const { result } = renderHook(() => useReadProgress(ref, []));
    expect(result.current.allRead).toBe(true);
  });
});
