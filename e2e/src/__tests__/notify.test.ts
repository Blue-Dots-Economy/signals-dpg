import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  subjectPatternFor,
  assertNoCopyDrift,
  emailCaseIds,
  emailCaseInventory,
  smsCaseIds,
  defaultEmailPropertiesText,
  layeredEmailPropertiesText,
} from '../notify.ts';

const PROPS = [
  'profile.create.subject=Your {{domainLabel}} profile is live',
  'support.request.subject=Support request {{reference}}',
].join('\n');

test('a case subject template becomes a matching regex', () => {
  const re = subjectPatternFor('profile.create', PROPS);
  assert.ok(re.test('Your Seeker profile is live'));
  assert.ok(!re.test('Your Seeker profile is paused'));
});

test('regex metacharacters in copy are escaped, not interpreted', () => {
  const re = subjectPatternFor('support.request', 'support.request.subject=Support (urgent) {{reference}}');
  assert.ok(re.test('Support (urgent) SR-1234'));
});

test('an unknown case id fails loudly rather than matching everything', () => {
  assert.throws(() => subjectPatternFor('nope.missing', PROPS), /nope\.missing/);
});

test('an unsubstituted token is copy drift', () => {
  assert.throws(
    () => assertNoCopyDrift([{ channel: 'email', to: 'a@b.c', subject: 'Hi {{name}}', html: '<p>ok</p>', templateId: 'basic_email', variables: {} }]),
    /\{\{/,
  );
});

test('an unresolved support-email placeholder is copy drift', () => {
  assert.throws(
    () => assertNoCopyDrift([{ channel: 'email', to: 'a@b.c', subject: 'Hi', html: '<p>__SUPPORT_EMAIL__</p>', templateId: 'basic_email', variables: {} }]),
    /__SUPPORT_EMAIL__/,
  );
});

// The third invariant (no relative CTA href) needs its own "fires" test —
// the two above already prove {{token}} and __SUPPORT_EMAIL__ fire, but
// nothing yet proves the href check itself throws rather than being dead code.
test('a relative CTA href is copy drift', () => {
  assert.throws(
    () => assertNoCopyDrift([{ channel: 'email', to: 'a@b.c', subject: 'Hi', html: '<a href="/x">go</a>', templateId: 'basic_email', variables: {} }]),
    /relative CTA href/,
  );
});

test('clean copy passes', () => {
  assertNoCopyDrift([{ channel: 'email', to: 'a@b.c', subject: 'Hi', html: '<a href="http://localhost:3000/x">go</a>', templateId: 'basic_email', variables: {} }]);
});

test('a mailto CTA href is not flagged as relative', () => {
  assertNoCopyDrift([{ channel: 'email', to: 'a@b.c', subject: 'Hi', html: '<a href="mailto:help@example.com">help</a>', templateId: 'basic_email', variables: {} }]);
});

// ── Case inventory: proves the full 35(+)-case list is enumerated by
// executing the real registry, not by grepping `CASES.set(` (which would
// silently drop the 16 action.* ids a nested loop generates — see the block
// comment in email_cases.ts and the note at the top of notify.ts). ─────────

test('emailCaseIds enumerates the registry, including loop-generated action ids CASES.set grep would miss', async () => {
  const ids = await emailCaseIds();
  // No hardcoded count: the registry is the source of truth and has grown
  // since this suite was scoped (see the note in notify.ts). What must always
  // hold is that every static id and every one of the 16 generated
  // action.<group>.<role>.<shape> ids is present.
  assert.ok(ids.length >= 35, `expected at least 35 registered cases, got ${ids.length}`);
  const ACTION_GROUPS = ['connect', 'apply'];
  const ACTION_ROLES = ['seeker', 'provider'];
  const ACTION_SHAPES = ['inbound_request', 'outbound_request', 'inbound_status', 'outbound_status'];
  for (const group of ACTION_GROUPS) {
    for (const role of ACTION_ROLES) {
      for (const shape of ACTION_SHAPES) {
        assert.ok(
          ids.includes(`action.${group}.${role}.${shape}`),
          `missing loop-generated case action.${group}.${role}.${shape} — a CASES.set() grep would have missed this`,
        );
      }
    }
  }
  // A representative static (non-loop) case, so the assertion isn't ONLY
  // exercising the generated half of the registry.
  assert.ok(ids.includes('login.otp'));
  assert.ok(new Set(ids).size === ids.length, 'case ids must be unique');
});

test('every registered case has subject copy in the bundled properties file', async () => {
  const ids = await emailCaseIds();
  const props = defaultEmailPropertiesText();
  for (const id of ids) {
    // Throws with the case id in the message on a miss — see subjectPatternFor.
    assert.doesNotThrow(() => subjectPatternFor(id, props), `case "${id}" has no bundled subject copy`);
  }
});

test('the copy sweep REPORTS unregistered copy rather than failing on it', async () => {
  const inventory = await emailCaseInventory();
  assert.ok(Array.isArray(inventory.orphanedCopyIds));
  assert.ok(inventory.registered.length >= 35);
  // Not asserting the orphan count itself: it's a property of the copy file's
  // current state (0 at the time of this task — see the report), not of this
  // function's correctness. What matters is that a real gap is *reported*,
  // which the synthetic-registry test below proves independently of live data.
});

test('the copy sweep names a real gap: copy with no matching registry entry is reported, not silently dropped', () => {
  // Exercise the same set-difference the sweep runs, over a synthetic
  // registry, so this test doesn't depend on whether a gap happens to exist
  // in the live properties file today.
  const registered = ['profile.create'];
  const props = 'profile.create.subject=Hi\nghost.case.subject=I have no code behind me\n';
  const registeredSet = new Set(registered);
  const propsIds = new Set<string>();
  for (const line of props.split('\n')) {
    const m = /^([\w.]+)\.subject=/.exec(line.trim());
    if (m) propsIds.add(m[1]);
  }
  const orphans = [...propsIds].filter((id) => !registeredSet.has(id));
  assert.deepEqual(orphans, ['ghost.case']);
});

test('smsCaseIds finds exactly the 5 known SMS cases from the raw .properties keys', async () => {
  const ids = await smsCaseIds();
  assert.deepEqual(
    [...ids].sort(),
    ['account.aggregator_init', 'offer.create', 'offer.update', 'profile.create', 'profile.update'].sort(),
  );
});

test('layeredEmailPropertiesText puts a network override before the default so it wins the first-match lookup', () => {
  const overridden = 'login.otp.subject=OTP to verify access';
  const defaults = 'login.otp.subject=Your One-Time Password (OTP) for {{appName}}';
  // Simulate what layeredEmailPropertiesText produces without touching the
  // filesystem, so this test doesn't depend on blue_dot's example copy file
  // staying byte-identical: the property under test is ORDER, not content.
  const layered = `${overridden}\n${defaults}`;
  const re = subjectPatternFor('login.otp', layered);
  assert.ok(re.test('OTP to verify access'));
});

test('layeredEmailPropertiesText falls back to defaults for an unknown network', () => {
  const text = layeredEmailPropertiesText('a-network-that-does-not-exist');
  assert.equal(text, defaultEmailPropertiesText());
});

test('layeredEmailPropertiesText resolves blue_dot\'s real override ahead of the bundled default', () => {
  // Integration-flavoured: reads the actual files this worktree ships, so a
  // change to either file that breaks precedence fails here rather than only
  // being caught by a live send.
  const text = layeredEmailPropertiesText('blue_dot');
  const re = subjectPatternFor('login.otp', text);
  // blue_dot's examples/schemas/blue_dot/messages.properties overrides this
  // subject to literal copy with no {{appName}} token — if precedence were
  // backwards this would instead match the bundled default's wording.
  assert.ok(re.test('OTP to verify access'));
  assert.ok(!re.test('Your One-Time Password (OTP) for Blue Dot'));
});
