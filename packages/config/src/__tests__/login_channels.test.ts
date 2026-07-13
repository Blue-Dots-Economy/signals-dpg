import { describe, it, expect } from 'vitest';
import { parseLoginChannels } from '../login_channels';

describe('parseLoginChannels', () => {
  it('parses both channels', () => {
    expect(parseLoginChannels('email,phone')).toEqual(['email', 'phone']);
  });

  it('parses a single channel', () => {
    expect(parseLoginChannels('phone')).toEqual(['phone']);
    expect(parseLoginChannels('email')).toEqual(['email']);
  });

  it('trims whitespace and lowercases', () => {
    expect(parseLoginChannels(' Email , PHONE ')).toEqual(['email', 'phone']);
  });

  it('de-duplicates', () => {
    expect(parseLoginChannels('phone,phone,email')).toEqual(['phone', 'email']);
  });

  it('throws on an unknown channel', () => {
    expect(() => parseLoginChannels('email,sms')).toThrow(/Invalid LOGIN_CHANNELS/);
  });

  it('throws when empty', () => {
    expect(() => parseLoginChannels('')).toThrow(/at least one/);
    expect(() => parseLoginChannels('  ,  ')).toThrow(/at least one/);
  });
});
