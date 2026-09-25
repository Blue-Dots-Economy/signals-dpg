import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

const readSession = vi.fn();
const destroySession = vi.fn();
vi.mock('@/services/auth/browser_session', () => ({
  readSession: (...a: unknown[]) => readSession(...a),
  destroySession: (...a: unknown[]) => destroySession(...a),
}));
const deleteSession = vi.fn();
const getKeycloakAdminClient = vi.fn(() => ({ deleteSession }));
vi.mock('@/services/auth/keycloak_admin_instance', () => ({
  getKeycloakAdminClient: () => getKeycloakAdminClient(),
}));

const { endBrowserSessionEverywhere } = await import('../end_browser_session.js');

const idToken = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

const log = { warn: vi.fn() } as unknown as FastifyBaseLogger;

beforeEach(() => {
  vi.clearAllMocks();
  getKeycloakAdminClient.mockReturnValue({ deleteSession });
});

describe('endBrowserSessionEverywhere', () => {
  it('destroys the local session and the Keycloak session behind it', async () => {
    readSession.mockResolvedValue({ idToken: idToken({ sid: 'kc-sess-1' }) });
    await endBrowserSessionEverywhere('local-1', log);
    expect(destroySession).toHaveBeenCalledWith('local-1');
    expect(deleteSession).toHaveBeenCalledWith('kc-sess-1');
  });

  it('still destroys the local session when there is no id token', async () => {
    readSession.mockResolvedValue({});
    await endBrowserSessionEverywhere('local-1', log);
    expect(destroySession).toHaveBeenCalledWith('local-1');
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('does not throw when Keycloak refuses; it logs instead', async () => {
    readSession.mockResolvedValue({ idToken: idToken({ sid: 'kc-sess-1' }) });
    deleteSession.mockRejectedValue(new Error('403'));
    await expect(endBrowserSessionEverywhere('local-1', log)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });

  it('copes with a session that is already gone', async () => {
    readSession.mockResolvedValue(null);
    await endBrowserSessionEverywhere('local-1', log);
    expect(destroySession).toHaveBeenCalledWith('local-1');
  });
});
