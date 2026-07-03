import { describe, it, expect } from 'vitest';
import { resolveBrand } from '../resolve-brand';

describe('resolveBrand', () => {
  it('defaults to standard when nothing set', () => {
    expect(resolveBrand({})).toBe('standard');
  });
  it('runtimeConfig wins over buildDefault', () => {
    expect(resolveBrand({ runtimeConfig: 'onetac', buildDefault: 'x' })).toBe('onetac');
  });
  it('buildDefault used when no runtimeConfig', () => {
    expect(resolveBrand({ buildDefault: 'upsdm' })).toBe('upsdm');
  });
  it('ignores empty/whitespace values', () => {
    expect(resolveBrand({ runtimeConfig: '', buildDefault: 'upsdm' })).toBe('upsdm');
  });
  it('ignores whitespace-only values', () => {
    expect(resolveBrand({ runtimeConfig: '  ', buildDefault: 'upsdm' })).toBe('upsdm');
  });
});
