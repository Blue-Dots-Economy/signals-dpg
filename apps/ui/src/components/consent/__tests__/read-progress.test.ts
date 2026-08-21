import { describe, it, expect } from 'vitest';
import { computeReadProgress } from '@/components/consent/read-progress';

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
