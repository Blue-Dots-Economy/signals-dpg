import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const configDir = resolve(here, '..', 'config');

/**
 * The external-mode target configuration. One file per environment under
 * `e2e/config/<env>.json`, selected via `E2E_ENV` (or an explicit path in
 * `E2E_CONFIG`). Secrets (service key, db url) should come from the environment
 * and override the file — never commit real secrets into the JSON.
 *
 * Everything here describes an ALREADY-RUNNING instance. The suite never brings
 * up, migrates, or seeds the target; it only points at it and asserts.
 */
export interface E2EConfig {
  /** Human label, e.g. "local" or "dev". */
  env: string;

  /** Base URL of the running signals-dpg API, e.g. http://localhost:2742 */
  apiBaseUrl: string;
  /** Base URL of the running signals-dpg UI, e.g. http://localhost:5173 */
  uiBaseUrl: string;

  /** Network + served domains the target instance serves. */
  network: string;
  servedDomains: string[];
  /** White-label brand overlay, e.g. "upsdm"; null for the network default. */
  brand: string | null;
  /** Host header for host-routed served-binding; null to skip. */
  servedBindingHost: string | null;
  /** UI language to assert against. */
  language: string;

  /** What the target was launched with — declared, not set by the suite. */
  selfSignupMode: 'gated' | 'allowed';
  loginChannels: Array<'phone' | 'email'>;
  peerAuthMode: 'permissive' | 'enforced';

  /**
   * Action semantics for this network (varies per network.json). `type` is the
   * interaction key (e.g. "connect"/"apply"); `acceptStatus` is the event status
   * that both advances the action and (typically) reveals PII.
   */
  action: { type: string; acceptStatus: string };

  /** Service-caller credentials (P5/P6) — injected, never seeded by the suite. */
  auth: {
    serviceApiKey: string | null;
    actingOrgId: string | null;
  };

  /** OTP retrieval strategy for headless journeys. */
  otp: {
    /** 'test-otp': target runs CREATE_TEST_OTP and exposes the code to the suite.
     *  'notification-stub': read the code from an inspectable notification sink. */
    mode: 'test-otp' | 'notification-stub';
  };

  /** Inspectable notification sink base URL; presence enables @needs-notification-stub. */
  notificationStubUrl: string | null;
  /** DB connection string; presence enables the @needs-db introspection tier. */
  db: { url: string | null };
  /** True only when the target runs a KNOWN SIGNALS_PII_KEY (a local instance you control). */
  deterministicPiiKey: boolean;
  /** True only where infra can be broken (stop Redis / a seam) — a local instance. */
  faultInjection: boolean;

  /** G3 only — the second already-running peer instance. */
  peer: { apiBaseUrl: string | null };
}

type RawConfig = Partial<E2EConfig> & { apiBaseUrl?: string };

function loadFile(): { raw: RawConfig; source: string } {
  const explicit = process.env.E2E_CONFIG;
  const envName = process.env.E2E_ENV ?? 'local';
  const path = explicit
    ? (isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit))
    : resolve(configDir, `${envName}.json`);
  let raw: RawConfig;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as RawConfig;
  } catch (err) {
    throw new Error(
      `[e2e] could not read config "${path}" (E2E_ENV=${envName}). ` +
        `Create e2e/config/${envName}.json from an existing example. Cause: ${(err as Error).message}`,
    );
  }
  return { raw, source: path };
}

/** Environment overrides for secrets and quick targeting, so nothing sensitive is committed. */
function applyEnvOverrides(c: E2EConfig): E2EConfig {
  const e = process.env;
  if (e.E2E_API_BASE_URL) c.apiBaseUrl = e.E2E_API_BASE_URL;
  if (e.E2E_UI_BASE_URL) c.uiBaseUrl = e.E2E_UI_BASE_URL;
  if (e.E2E_SERVICE_API_KEY) c.auth.serviceApiKey = e.E2E_SERVICE_API_KEY;
  if (e.E2E_ACTING_ORG_ID) c.auth.actingOrgId = e.E2E_ACTING_ORG_ID;
  if (e.E2E_DB_URL) c.db.url = e.E2E_DB_URL;
  if (e.E2E_NOTIFICATION_STUB_URL) c.notificationStubUrl = e.E2E_NOTIFICATION_STUB_URL;
  if (e.E2E_PEER_API_BASE_URL) c.peer.apiBaseUrl = e.E2E_PEER_API_BASE_URL;
  if (e.E2E_ACTION_TYPE) c.action.type = e.E2E_ACTION_TYPE;
  if (e.E2E_ACTION_ACCEPT_STATUS) c.action.acceptStatus = e.E2E_ACTION_ACCEPT_STATUS;
  return c;
}

function requireField(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[e2e] invalid config: ${msg}`);
}

let cached: E2EConfig | undefined;

export function loadConfig(): E2EConfig {
  if (cached) return cached;
  const { raw, source } = loadFile();

  const cfg: E2EConfig = {
    env: raw.env ?? process.env.E2E_ENV ?? 'local',
    apiBaseUrl: raw.apiBaseUrl ?? 'http://localhost:2742',
    uiBaseUrl: raw.uiBaseUrl ?? 'http://localhost:5173',
    network: raw.network ?? 'blue_dot',
    servedDomains: raw.servedDomains ?? [],
    brand: raw.brand ?? null,
    servedBindingHost: raw.servedBindingHost ?? null,
    language: raw.language ?? 'en',
    selfSignupMode: raw.selfSignupMode ?? 'gated',
    loginChannels: raw.loginChannels ?? ['phone', 'email'],
    peerAuthMode: raw.peerAuthMode ?? 'permissive',
    action: { type: raw.action?.type ?? 'connect', acceptStatus: raw.action?.acceptStatus ?? 'accepted' },
    auth: { serviceApiKey: raw.auth?.serviceApiKey ?? null, actingOrgId: raw.auth?.actingOrgId ?? null },
    otp: { mode: raw.otp?.mode ?? 'test-otp' },
    notificationStubUrl: raw.notificationStubUrl ?? null,
    db: { url: raw.db?.url ?? null },
    deterministicPiiKey: raw.deterministicPiiKey ?? false,
    faultInjection: raw.faultInjection ?? false,
    peer: { apiBaseUrl: raw.peer?.apiBaseUrl ?? null },
  };

  applyEnvOverrides(cfg);

  requireField(/^https?:\/\//.test(cfg.apiBaseUrl), `apiBaseUrl must be an http(s) URL (got "${cfg.apiBaseUrl}")`);
  requireField(/^https?:\/\//.test(cfg.uiBaseUrl), `uiBaseUrl must be an http(s) URL (got "${cfg.uiBaseUrl}")`);
  requireField(cfg.servedDomains.length > 0, `servedDomains must list at least one "network/domain" (source: ${source})`);

  // strip trailing slashes for predictable URL joining
  cfg.apiBaseUrl = cfg.apiBaseUrl.replace(/\/+$/, '');
  cfg.uiBaseUrl = cfg.uiBaseUrl.replace(/\/+$/, '');

  cached = cfg;
  return cfg;
}
