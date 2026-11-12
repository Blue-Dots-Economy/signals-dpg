import { describe, it, expect } from 'vitest';
import { hasProfileChanges } from '@/lib/profile-changes';

describe('hasProfileChanges', () => {
  const stored = { name: 'Asha', skills: ['a', 'b'], address: { city: 'Agra', pin: '282001' }, age: 30 };

  it('is false when every submitted value matches', () => {
    expect(hasProfileChanges({ ...stored, address: { pin: '282001', city: 'Agra' } }, stored)).toBe(false);
  });

  it('treats empty string, null, undefined and [] as the same empty value', () => {
    expect(hasProfileChanges({ name: 'Asha', bio: '', tags: [], note: null }, { name: 'Asha' })).toBe(false);
  });

  it('ignores stored keys the form did not submit', () => {
    expect(hasProfileChanges({ name: 'Asha' }, stored)).toBe(false);
  });

  it('is true when a value, an array entry or a nested value changes', () => {
    expect(hasProfileChanges({ name: 'Ravi' }, stored)).toBe(true);
    expect(hasProfileChanges({ skills: ['b', 'a'] }, stored)).toBe(true);
    expect(hasProfileChanges({ address: { city: 'Agra', pin: '282002' } }, stored)).toBe(true);
    expect(hasProfileChanges({ age: '30' }, stored)).toBe(true);
  });

  it('is true when a field is filled in or emptied', () => {
    expect(hasProfileChanges({ bio: 'hello' }, stored)).toBe(true);
    expect(hasProfileChanges({ name: '' }, stored)).toBe(true);
  });

  it('is true when there is nothing stored to compare with', () => {
    expect(hasProfileChanges({ name: 'Asha' }, null)).toBe(true);
  });
});
