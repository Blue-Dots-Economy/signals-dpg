#!/usr/bin/env node
/**
 * NCS demo portal — a local stand-in for the National Career Service portal,
 * for testing partner SSO (docs/operations/partner-sso.md) without NCS.
 *
 * It plays both NCS roles:
 *   - the portal a user logs in to and clicks "Open Bluedots" on, which
 *     redirects the browser to Signals with an NCS-style signed link
 *     (?userName=<HS256 JWT>&sig=<CryptoJS AES>&expiry=&featureKey=)
 *   - the partner API Signals calls back: POST /api/integration/validate-token,
 *     with the same HMAC check NCS documents
 *
 * Node built-ins only. Local testing only — never expose it.
 *
 *   NCS_DEMO_CLIENT_SECRET=<same as SSO_NCS_CLIENT_SECRET> node local-setup/ncs-demo/server.mjs
 *
 * Env:
 *   NCS_DEMO_PORT           default 4555  (point SSO_NCS_BASE_URL at http://localhost:4555)
 *   NCS_DEMO_CLIENT_ID      default bluedots-local  (= SSO_NCS_CLIENT_ID)
 *   NCS_DEMO_CLIENT_SECRET  required               (= SSO_NCS_CLIENT_SECRET)
 *   SIGNALS_SSO_URL         default http://localhost:2742/api/v1/auth/sso/login
 */
import http from 'node:http';
import { createCipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.NCS_DEMO_PORT ?? 4555);
const CLIENT_ID = process.env.NCS_DEMO_CLIENT_ID ?? 'bluedots-local';
const SECRET = process.env.NCS_DEMO_CLIENT_SECRET;
const SIGNALS_SSO_URL =
  process.env.SIGNALS_SSO_URL ?? 'http://localhost:2742/api/v1/auth/sso/login';
if (!SECRET) {
  console.error('NCS_DEMO_CLIENT_SECRET is required (use the same value as SSO_NCS_CLIENT_SECRET).');
  process.exit(1);
}

const FEATURE_KEYS = ['placement-prep', 'job-search', 'unknown-feature'];

/** Test users, keyed by the NCS `userName` (the portal's login id). */
const users = new Map(
  [
    ['asha', 'Asha Kulkarni', '9999910001', true, 'ACTIVE'],
    ['ravi', 'Ravi Sharma', '9999910002', true, 'ACTIVE'],
    ['meena', 'Meena Unverified', '9999910003', false, 'ACTIVE'],
    ['blocked', 'Blocked User', '9999910004', true, 'BLOCKED'],
  ].map(([id, fullName, mobile, verified, status], i) => [
    `dge-mole_${id}@demo.ncs`,
    {
      userId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      fullName,
      mobileNumber: mobile,
      role: 'JOBSEEKER',
      email: `${id}@demo.ncs`,
      isEmailVerified: false,
      isMobileVerified: verified,
      isDigilockerVerified: false,
      isProfileComplete: true,
      status,
    },
  ])
);

/** Portal sessions: sid → userName. Last link per session, for the replay button. */
const sessions = new Map();
const lastLink = new Map();

// ── NCS link format ─────────────────────────────────────────────────────────

const b64u = (value) => Buffer.from(value).toString('base64url');

function signJwt(userName, ageSeconds) {
  const iat = Math.floor(Date.now() / 1000) - ageSeconds;
  const exp = iat + 300; // NCS links live 5 minutes
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ userName, iat, exp }));
  const sig = createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return { jwt: `${head}.${body}.${sig}`, exp };
}

/** CryptoJS.AES.encrypt(text, passphrase).toString() — OpenSSL "Salted__" format. */
function cryptoJsEncrypt(text, passphrase) {
  const salt = randomBytes(8);
  let derived = Buffer.alloc(0);
  let block = Buffer.alloc(0);
  while (derived.length < 48) {
    block = createHash('md5').update(Buffer.concat([block, Buffer.from(passphrase), salt])).digest();
    derived = Buffer.concat([derived, block]);
  }
  const cipher = createCipheriv('aes-256-cbc', derived.subarray(0, 32), derived.subarray(32, 48));
  return Buffer.concat([Buffer.from('Salted__'), salt, cipher.update(text, 'utf8'), cipher.final()])
    .toString('base64');
}

function buildLink(userName, featureKey, { expired = false, tampered = false } = {}) {
  const { jwt, exp } = signJwt(userName, expired ? 600 : 0);
  let sig = cryptoJsEncrypt(`${userName}|${exp}`, SECRET);
  if (tampered) sig = `AAAAAAAA${sig.slice(8)}`;
  const q = new URLSearchParams({ userName: jwt, sig, expiry: `${exp}.288`, featureKey });
  return `${SIGNALS_SSO_URL}?${q}`;
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}
const json = (res, status, body) =>
  send(res, status, JSON.stringify(body), { 'content-type': 'application/json' });
const redirect = (res, location, headers = {}) => send(res, 302, '', { location, ...headers });

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw));
  });
}

function sessionOf(req) {
  const sid = /(?:^|;\s*)ncs_demo_sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  return sid && sessions.has(sid) ? { sid, userName: sessions.get(sid) } : null;
}

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(title)}</title><style>
body{font-family:system-ui,sans-serif;margin:0;background:#f4f6fa;color:#1d2433}
header{background:#1a3d7c;color:#fff;padding:14px 28px;display:flex;justify-content:space-between;align-items:center}
header b{font-size:18px} header small{opacity:.8}
main{max-width:860px;margin:28px auto;padding:0 20px}
.card{background:#fff;border-radius:10px;padding:20px 24px;margin-bottom:18px;box-shadow:0 1px 3px #0001}
table{width:100%;border-collapse:collapse} td,th{padding:8px 6px;border-bottom:1px solid #eef0f4;text-align:left;font-size:14px}
button,.btn{background:#1a73e8;color:#fff;border:0;border-radius:6px;padding:8px 14px;font-size:14px;cursor:pointer;text-decoration:none;display:inline-block}
.btn.alt{background:#fff;color:#1a3d7c;border:1px solid #c8d1e0}.btn.warn{background:#b3261e}
input,select{padding:7px;border:1px solid #c8d1e0;border-radius:6px;font-size:14px}
.tag{font-size:12px;padding:2px 8px;border-radius:10px;background:#e8eefb}.bad{background:#fde7e7}
code{background:#eef0f4;padding:1px 5px;border-radius:4px}
</style></head><body><header><b>NCS demo portal</b><small>local stand-in for testing Bluedots SSO — not the real NCS</small></header><main>${body}</main></body></html>`;

// ── Pages ───────────────────────────────────────────────────────────────────

function loginPage() {
  const rows = [...users.entries()]
    .map(
      ([userName, u]) => `<tr><td>${esc(u.fullName)}</td><td>+91 ${esc(u.mobileNumber)}</td>
<td><span class="tag ${u.isMobileVerified ? '' : 'bad'}">${u.isMobileVerified ? 'verified' : 'unverified'}</span>
 <span class="tag ${u.status === 'ACTIVE' ? '' : 'bad'}">${esc(u.status)}</span></td>
<td><form method="post" action="/login"><input type="hidden" name="userName" value="${esc(userName)}"><button>Log in</button></form></td></tr>`
    )
    .join('');
  return page(
    'NCS demo — log in',
    `<div class="card"><h2>Log in to NCS</h2><p>Pick a job seeker. No password — this is a demo.</p>
<table><tr><th>Name</th><th>Mobile</th><th>Status</th><th></th></tr>${rows}</table></div>
<div class="card"><h3>Add a test user</h3><form method="post" action="/users">
<input name="fullName" placeholder="Full name" required> <input name="mobileNumber" placeholder="10-digit mobile" pattern="[6-9][0-9]{9}" required>
<select name="verified"><option value="true">mobile verified</option><option value="false">mobile unverified</option></select>
<select name="status"><option>ACTIVE</option><option>BLOCKED</option></select> <button>Add</button></form>
<p><small>To test linking to an existing Bluedots account, use the mobile number of a user who already exists in Bluedots.</small></p></div>
<div class="card"><small>Redirects to <code>${esc(SIGNALS_SSO_URL)}</code> · client id <code>${esc(CLIENT_ID)}</code> ·
validate-token at <code>http://localhost:${PORT}/api/integration/validate-token</code></small></div>`
  );
}

function homePage(userName) {
  const u = users.get(userName);
  const open = FEATURE_KEYS.map(
    (k) => `<a class="btn" href="/go?featureKey=${encodeURIComponent(k)}">Open Bluedots (${esc(k)})</a>`
  ).join(' ');
  return page(
    'NCS demo — home',
    `<div class="card"><h2>Welcome, ${esc(u.fullName)}</h2>
<p>Logged in to NCS as <code>${esc(userName)}</code> · +91 ${esc(u.mobileNumber)} ·
mobile ${u.isMobileVerified ? 'verified' : '<b>unverified</b>'} · status ${esc(u.status)}</p>
<form method="post" action="/logout"><button class="btn alt">Log out of NCS</button></form></div>
<div class="card"><h3>Partner platforms</h3><p>Bluedots — find jobs near you.</p>${open}</div>
<div class="card"><h3>Failure scenarios</h3><p>Each should land on the Bluedots error page, never an OTP screen.</p>
<a class="btn warn" href="/go?mode=replay">Re-open the last link (already used)</a>
<a class="btn warn" href="/go?mode=expired">Expired link</a>
<a class="btn warn" href="/go?mode=tampered">Tampered link</a></div>`
  );
}

// ── Server ──────────────────────────────────────────────────────────────────

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const session = sessionOf(req);

    // The partner API Signals calls.
    if (req.method === 'POST' && url.pathname === '/api/integration/validate-token') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const expected = createHmac('sha256', SECRET).update(body.token ?? '').digest('hex');
      const hmacOk =
        typeof body.hmac === 'string' &&
        body.hmac.length === expected.length &&
        timingSafeEqual(Buffer.from(body.hmac), Buffer.from(expected));
      const fail = (message) =>
        json(res, 401, { status: 'FAILURE', statusCode: 401, message, data: null, path: null });
      if (body.clientId !== CLIENT_ID) return fail('Token validation failed: Unknown client');
      if (!hmacOk) return fail('Token validation failed: Invalid HMAC signature');
      let claims;
      try {
        const [h, p, s] = body.token.split('.');
        const check = createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
        if (check !== s) return fail('Token validation failed: Invalid token');
        claims = JSON.parse(Buffer.from(p, 'base64url').toString());
      } catch {
        return fail('Token validation failed: Malformed token');
      }
      if (claims.exp * 1000 < Date.now()) return fail('Token validation failed: JWT expired');
      const user = users.get(claims.userName);
      if (!user) return fail('Token validation failed: Unknown user');
      console.log(`[ncs-demo] validate-token OK for ${claims.userName}`);
      return json(res, 200, {
        status: 'SUCCESS',
        statusCode: 200,
        message: 'Token validation successful',
        data: user,
        timestamp: new Date().toISOString(),
        path: null,
      });
    }

    if (req.method === 'POST' && url.pathname === '/login') {
      const userName = new URLSearchParams(await readBody(req)).get('userName');
      if (!users.has(userName)) return redirect(res, '/');
      const sid = randomBytes(16).toString('hex');
      sessions.set(sid, userName);
      return redirect(res, '/home', { 'set-cookie': `ncs_demo_sid=${sid}; HttpOnly; Path=/; SameSite=Lax` });
    }

    if (req.method === 'POST' && url.pathname === '/logout') {
      if (session) sessions.delete(session.sid);
      return redirect(res, '/', { 'set-cookie': 'ncs_demo_sid=; Max-Age=0; Path=/' });
    }

    if (req.method === 'POST' && url.pathname === '/users') {
      const form = new URLSearchParams(await readBody(req));
      const mobile = (form.get('mobileNumber') ?? '').trim();
      const fullName = (form.get('fullName') ?? '').trim();
      if (/^[6-9]\d{9}$/.test(mobile) && fullName) {
        const id = `user${users.size + 1}`;
        users.set(`dge-mole_${id}@demo.ncs`, {
          userId: `00000000-0000-4000-8000-${String(users.size + 1).padStart(12, '0')}`,
          fullName,
          mobileNumber: mobile,
          role: 'JOBSEEKER',
          email: `${id}@demo.ncs`,
          isEmailVerified: false,
          isMobileVerified: form.get('verified') === 'true',
          isDigilockerVerified: false,
          isProfileComplete: true,
          status: form.get('status') === 'BLOCKED' ? 'BLOCKED' : 'ACTIVE',
        });
      }
      return redirect(res, '/');
    }

    if (url.pathname === '/home') {
      return session ? send(res, 200, homePage(session.userName)) : redirect(res, '/');
    }

    // "Open Bluedots": redirect the browser to Signals with a signed link.
    if (url.pathname === '/go') {
      if (!session) return redirect(res, '/');
      const mode = url.searchParams.get('mode');
      if (mode === 'replay') {
        const last = lastLink.get(session.sid);
        return last ? redirect(res, last) : redirect(res, '/home');
      }
      const link = buildLink(session.userName, url.searchParams.get('featureKey') ?? 'placement-prep', {
        expired: mode === 'expired',
        tampered: mode === 'tampered',
      });
      if (!mode) lastLink.set(session.sid, link);
      return redirect(res, link);
    }

    if (url.pathname === '/') return send(res, 200, loginPage());
    send(res, 404, page('Not found', '<div class="card">Not found</div>'));
  })
  .listen(PORT, () => {
    console.log(`[ncs-demo] portal:        http://localhost:${PORT}/`);
    console.log(`[ncs-demo] validate-token: http://localhost:${PORT}/api/integration/validate-token`);
    console.log(`[ncs-demo] redirects to:   ${SIGNALS_SSO_URL}  (client id ${CLIENT_ID})`);
  });
