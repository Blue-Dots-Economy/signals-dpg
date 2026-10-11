import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * `getSmsTemplates()` is a boot-time singleton over four layers. What matters
 * here is the layering order and the failure policy: SMS is best-effort, so no
 * path through this may throw, and a blank `template_id` must survive every
 * merge because it is the "not DLT-approved yet, skip the send" signal.
 */

const { state } = vi.hoisted(() => ({
  state: {
    defaults: 'profile.create.template_id=\nprofile.create.body=bundled\nprofile.create.vars=name',
    overridePath: undefined as string | undefined,
    overrideText: null as string | null,
    files: [] as Array<{ network: string; brand: string | null; text: string }>,
    filesError: null as Error | null,
    source: 'local' as 'local' | 'remote',
  },
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn((target: unknown) => {
    // The bundled defaults are read via a file: URL; the override via a path.
    if (typeof target !== 'string') return Promise.resolve(state.defaults);
    if (state.overrideText === null) return Promise.reject(new Error('ENOENT'));
    return Promise.resolve(state.overrideText);
  }),
}));

vi.mock('@/config', () => ({
  apiConfig: {
    get served_domains() {
      return [{ network: 'purple_dot', domain: 'seeker' }];
    },
    get network_config_source() {
      return state.source;
    },
    network_config_local_file: '/app/schemas/purple_dot.json',
  },
  notification: {
    get SMS_MESSAGES_PATH() {
      return state.overridePath;
    },
  },
}));

vi.mock('@dpg/config', () => ({
  loadSmsTemplatesFiles: vi.fn(() => {
    if (state.filesError) return Promise.reject(state.filesError);
    return Promise.resolve(state.files);
  }),
}));

async function freshGetSmsTemplates() {
  // The index is memoized per module instance, so each case needs a fresh one.
  vi.resetModules();
  const mod = await import('../templates');
  return mod.getSmsTemplates();
}

beforeEach(() => {
  // Usage data only — the vi.mock factories keep their implementations. Without
  // this the call-count assertion below sees every earlier test's calls.
  vi.clearAllMocks();
  state.overridePath = undefined;
  state.overrideText = null;
  state.files = [];
  state.filesError = null;
  state.source = 'local';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('getSmsTemplates', () => {
  it('loads the bundled defaults when nothing else is configured', async () => {
    const index = await freshGetSmsTemplates();
    expect(index.get('profile.create')).toEqual({
      templateId: '',
      body: 'bundled',
      vars: ['name'],
    });
  });

  it('applies network then brand, brand winning', async () => {
    state.files = [
      { network: 'purple_dot', brand: null, text: 'profile.create.body=network' },
      { network: 'purple_dot', brand: 'alimco', text: 'profile.create.body=alimco' },
    ];
    const index = await freshGetSmsTemplates();
    expect(index.get('profile.create')?.body).toBe('alimco');
  });

  it('orders brand last even when the loader returns it first', async () => {
    // Guards the sort: reversed input must not let the network file win.
    state.files = [
      { network: 'purple_dot', brand: 'alimco', text: 'profile.create.body=alimco' },
      { network: 'purple_dot', brand: null, text: 'profile.create.body=network' },
    ];
    const index = await freshGetSmsTemplates();
    expect(index.get('profile.create')?.body).toBe('alimco');
  });

  it('layers SMS_MESSAGES_PATH under the network file', async () => {
    state.overridePath = '/etc/signals/sms/sms.properties';
    state.overrideText = 'profile.create.body=instance';
    state.files = [{ network: 'purple_dot', brand: null, text: 'profile.create.body=network' }];
    const index = await freshGetSmsTemplates();
    expect(index.get('profile.create')?.body).toBe('network');
  });

  it('applies SMS_MESSAGES_PATH when there is no network file', async () => {
    state.overridePath = '/etc/signals/sms/sms.properties';
    state.overrideText = 'profile.create.body=instance';
    const index = await freshGetSmsTemplates();
    expect(index.get('profile.create')?.body).toBe('instance');
  });

  it('keeps a blank template_id rather than falling back to the layer below', async () => {
    // The whole catalogue ships inert this way: an un-approved case must stay
    // un-approved even when a lower layer happens to carry an id.
    state.overridePath = '/etc/signals/sms/sms.properties';
    state.overrideText = 'profile.create.template_id=1507ABC';
    state.files = [{ network: 'purple_dot', brand: null, text: 'profile.create.template_id=' }];
    const index = await freshGetSmsTemplates();
    expect(index.get('profile.create')?.templateId).toBe('');
  });

  it('falls back to bundled templates when the override path is unreadable', async () => {
    state.overridePath = '/nope/sms.properties';
    state.overrideText = null;
    const index = await freshGetSmsTemplates();
    expect(index.get('profile.create')?.body).toBe('bundled');
  });

  it('falls back to bundled templates when the network/brand read fails', async () => {
    state.filesError = new Error('EACCES');
    const index = await freshGetSmsTemplates();
    expect(index.get('profile.create')?.body).toBe('bundled');
  });

  it('never throws — a total failure yields an empty registry, not a boot crash', async () => {
    const fs = await import('node:fs/promises');
    vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('bundled file missing'));
    const index = await freshGetSmsTemplates();
    expect(index.size).toBe(0);
  });

  it('memoizes: a second call does not re-read the layers', async () => {
    vi.resetModules();
    const mod = await import('../templates');
    const { loadSmsTemplatesFiles } = await import('@dpg/config');
    await mod.getSmsTemplates();
    await mod.getSmsTemplates();
    expect(vi.mocked(loadSmsTemplatesFiles)).toHaveBeenCalledTimes(1);
  });
});
