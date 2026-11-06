import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api-config', () => ({ apiConfig: { getUrl: () => 'http://api.test' } }));

const { clearCsrfToken, currentBffSession, fetchBffSession, getCsrfToken } = await import(
  '../bff-session.js'
);

const fetchMock = vi.fn();

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  clearCsrfToken();
});

describe('currentBffSession', () => {
  it('reuses the page load check for every write of a signed-out visitor', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ authenticated: false }, 401));

    await fetchBffSession();
    await Promise.all([currentBffSession(), currentBffSession(), currentBffSession(), currentBffSession()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getCsrfToken()).toBeNull();
  });

  it('makes a write that starts mid-check wait for that check and its token', async () => {
    let answer: (value: unknown) => void = () => {};
    fetchMock.mockReturnValue(new Promise((resolve) => { answer = resolve; }));

    const pageCheck = fetchBffSession();
    const writeCheck = currentBffSession();
    answer(jsonResponse({ authenticated: true, csrfToken: 'csrf-1' }));

    await expect(writeCheck).resolves.toEqual({ authenticated: true, csrfToken: 'csrf-1' });
    await pageCheck;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getCsrfToken()).toBe('csrf-1');
  });

  it('starts a check when the page has not made one yet', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ authenticated: true, csrfToken: 'csrf-2' }));

    await currentBffSession();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getCsrfToken()).toBe('csrf-2');
  });

  it('checks again after the session is cleared by sign-out or expiry', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ authenticated: false }, 401));
    await fetchBffSession();

    clearCsrfToken();
    await currentBffSession();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not reuse an answer the server could not give', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 503));
    await fetchBffSession();

    fetchMock.mockResolvedValueOnce(jsonResponse({ authenticated: true, csrfToken: 'csrf-3' }));
    await currentBffSession();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getCsrfToken()).toBe('csrf-3');
  });
});
