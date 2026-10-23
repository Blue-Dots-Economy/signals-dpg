import z from '@dpg/schemas';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { redis } from '@api/db/secondary/redis';

/**
 * Server-side session store for browser logins. Keycloak tokens never reach
 * the browser: they live in Redis, keyed by an opaque session id that is the
 * only thing in the cookie.
 *
 * The cookie carries the raw id; Redis keys use its SHA-256, so a leaked key
 * listing (`KEYS`/`MONITOR`, backups, support dumps) cannot be replayed as a
 * login.
 */

const SESSION_PREFIX = 'bsess:';

/** Opaque id length. 32 bytes = 256 bits, well past guessability. */
const SESSION_ID_BYTES = 32;

/**
 * Upper bound on a browser session's Redis TTL. `ttlFor` also caps it at the
 * refresh token's remaining life.
 */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

/** The stored shape, as a schema so `readSession` validates rows rather than casting them. */
export const BrowserSessionSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  /** Epoch ms. Used to refresh slightly early rather than on a 401. */
  accessTokenExp: z.number(),
  /** Epoch ms. A session cannot outlive this. */
  refreshTokenExp: z.number(),
  /**
   * Kept only to pass as `id_token_hint` on logout; without it Keycloak shows a
   * "Do you want to log out?" confirmation. Optional because a Keycloak that
   * returns no id token must still yield a session; logout then names the
   * client instead.
   */
  idToken: z.string().optional(),
  /**
   * Per-session CSRF token, echoed by the UI in `x-csrf-token` on every
   * state-changing request. Checked in `plugins/auth/resolve_browser_session.ts`.
   */
  csrfToken: z.string(),
  /**
   * The browser origin this session was opened from, validated against the CORS
   * allowlist at login (see `safeAppOrigin`). Used only to send the user back
   * to the app after logout (the API may be on another origin).
   *
   * Not an authorization input: cross-portal isolation comes from the cookie
   * being host-only.
   */
  appOrigin: z.string(),
  createdAt: z.number(),
  /**
   * Whether this session is the person's first login to the app, decided
   * once — on the session's first `/auth/me` — and then kept, so a reload
   * inside that first session still says true (see `app_first_login.ts`).
   * Optional: absent until decided, and on rows written before it existed.
   */
  firstLogin: z.boolean().optional(),
});

export type BrowserSession = z.infer<typeof BrowserSessionSchema>;

/** Never let a raw session id become a Redis key. */
function storeKey(sessionId: string): string {
  return SESSION_PREFIX + createHash('sha256').update(sessionId).digest('hex');
}

export function newSessionId(): string {
  return randomBytes(SESSION_ID_BYTES).toString('base64url');
}

export function newCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Constant-time compare for the CSRF double-submit check.
 *
 * Lengths are compared first because `timingSafeEqual` throws on a mismatch;
 * length is not the secret.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function createSession(
  sessionId: string,
  data: BrowserSession
): Promise<void> {
  await redis.set(
    storeKey(sessionId),
    JSON.stringify(data),
    'EX',
    ttlFor(data)
  );
}

export async function readSession(
  sessionId: string
): Promise<BrowserSession | null> {
  const raw = await redis.get(storeKey(sessionId));
  if (!raw) return null;
  try {
    // Validated, not cast: a row from an older release missing e.g. `csrfToken`
    // would otherwise make `safeEqual` throw and surface as a 500.
    return BrowserSessionSchema.parse(JSON.parse(raw));
  } catch {
    // Corrupt or superseded shape: treated as no session, so the caller
    // re-logs in.
    return null;
  }
}

export async function updateSession(
  sessionId: string,
  patch: Partial<BrowserSession>
): Promise<BrowserSession | null> {
  const current = await readSession(sessionId);
  if (!current) return null;
  const next = { ...current, ...patch };
  await redis.set(storeKey(sessionId), JSON.stringify(next), 'EX', ttlFor(next));
  return next;
}

export async function destroySession(sessionId: string): Promise<void> {
  await redis.del(storeKey(sessionId));
}

/**
 * Remaining life for a session: the shorter of `SESSION_TTL_SECONDS` and what
 * the refresh token has left, so a session never outlives its refresh token.
 */
function ttlFor(data: BrowserSession): number {
  const untilRefreshExpiry = Math.floor((data.refreshTokenExp - Date.now()) / 1000);
  return Math.max(1, Math.min(SESSION_TTL_SECONDS, untilRefreshExpiry));
}
