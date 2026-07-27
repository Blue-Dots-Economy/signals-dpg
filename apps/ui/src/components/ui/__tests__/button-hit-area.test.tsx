import { describe, it, expect } from 'vitest';
import { buttonVariants } from '../button';

describe('button hit area on touch', () => {
  it('sub-44px variants carry a coarse-pointer expansion', () => {
    for (const size of ['xs', 'icon-xs', 'sm', 'icon', 'icon-sm'] as const) {
      const cls = buttonVariants({ size });
      expect(cls, `size=${size}`).toMatch(/pointer-coarse:/);
    }
  });
});
