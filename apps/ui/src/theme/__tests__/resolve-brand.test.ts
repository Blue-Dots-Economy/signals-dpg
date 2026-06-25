import { describe, it, expect } from 'vitest';
import { resolveBrand } from '../resolve-brand';

describe('resolveBrand', () => {
  it('defaults to standard when nothing set', () => {
    expect(resolveBrand({})).toBe('standard');
  });
  it('query param wins over everything', () => {
    expect(resolveBrand({ queryParam: 'upsdm', runtimeConfig: 'onetac', buildDefault: 'x' })).toBe('upsdm');
  });
  it('runtime config beats build default', () => {
    expect(resolveBrand({ runtimeConfig: 'onetac', buildDefault: 'x' })).toBe('onetac');
  });
  it('build default used when no query/runtime', () => {
    expect(resolveBrand({ buildDefault: 'upsdm' })).toBe('upsdm');
  });
  it('ignores empty/whitespace values', () => {
    expect(resolveBrand({ queryParam: '  ', runtimeConfig: '', buildDefault: 'upsdm' })).toBe('upsdm');
  });
});
