import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import { AxiosError } from 'axios';
import { apiErrorMessage, isReadableServerMessage, readApiError, thrownErrorMessage } from './api-error';

const t = ((key: string, def?: string) => def ?? key) as unknown as TFunction;

function httpError(status: number, data: unknown) {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
}

describe('readApiError', () => {
  it('reads status, code, message and per-field messages', () => {
    const info = readApiError(
      httpError(400, { error: 'INVALID_ITEM_STATE', message: 'x', fields: { phone: 'bad', n: 3 } }),
    );
    expect(info).toEqual({
      status: 400,
      code: 'INVALID_ITEM_STATE',
      message: 'x',
      fields: { phone: 'bad' },
      network: false,
    });
  });

  it('turns a Fastify request-schema message into fields', () => {
    const info = readApiError(
      httpError(400, { message: 'body/guardianEmail Invalid email, body/name Too small' }),
    );
    expect(info.fields).toEqual({ guardianEmail: 'Invalid email', name: 'Too small' });
  });

  it('flags a request that never reached the server', () => {
    expect(readApiError(new AxiosError('Network Error', 'ERR_NETWORK')).network).toBe(true);
    expect(readApiError(new TypeError('Failed to fetch')).network).toBe(true);
    expect(readApiError(new Error('boom')).network).toBe(false);
  });
});

describe('apiErrorMessage', () => {
  it('never returns raw axios, HTTP or JSON text', () => {
    expect(apiErrorMessage(httpError(403, 'Forbidden'), t)).toBe("You don't have permission to do this.");
    expect(apiErrorMessage(httpError(429, {}), t)).toMatch(/^Too many attempts/);
    expect(apiErrorMessage(httpError(502, '<html>'), t)).toMatch(/on our side/);
    expect(apiErrorMessage(httpError(400, { message: '{"a":1}' }), t, 'Fallback.')).toBe('Fallback.');
    expect(apiErrorMessage(httpError(422, { message: 'ACTION_NOT_ALLOWED' }), t, 'Fallback.')).toBe('Fallback.');
  });

  it('keeps a readable 4xx sentence from the server', () => {
    expect(apiErrorMessage(httpError(409, { message: 'This profile is retired.' }), t)).toBe(
      'This profile is retired.',
    );
  });
});

describe('isReadableServerMessage', () => {
  it('rejects validator output and HTTP text', () => {
    expect(isReadableServerMessage('must match pattern "^[0-9]{10}$"')).toBe(false);
    expect(isReadableServerMessage('Invalid item_state: phone: x')).toBe(false);
    expect(isReadableServerMessage('HTTP error 500')).toBe(false);
    expect(isReadableServerMessage('header_mismatch')).toBe(false);
    expect(isReadableServerMessage('That code has expired')).toBe(true);
  });
});

describe('thrownErrorMessage', () => {
  it('keeps a readable plain Error message but not a network failure', () => {
    expect(thrownErrorMessage(new Error('That code has expired'), t, 'F')).toBe('That code has expired');
    expect(thrownErrorMessage(new Error('HTTP error 401'), t, 'F')).toBe('F');
    expect(thrownErrorMessage(new TypeError('Failed to fetch'), t, 'F')).toMatch(/^Couldn't reach the server/);
  });
});
