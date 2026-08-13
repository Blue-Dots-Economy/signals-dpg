import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedEmailMessagesFile } from '@dpg/config';
import { requiredMessageKeys } from '../email_cases';

// notification.EMAIL_MESSAGES_PATH and apiConfig fields are read once, at
// import time, by the `@/config` module. vi.hoisted + vi.mock let us swap
// their values per test without re-importing the whole config/env-parsing
// stack.
const mockNotification = vi.hoisted(() => ({
  EMAIL_MESSAGES_PATH: undefined as string | undefined,
}));

const mockApiConfig = vi.hoisted(() => ({
  served_domains: [{ network: 'blue_dot', domain: 'blue.example', key: 'k' }],
  network_config_source: 'remote' as 'local' | 'remote',
  network_config_local_file: '/nonexistent/network.json',
}));

const mockLoadEmailMessagesFiles = vi.hoisted(() => vi.fn());

vi.mock('@/config', () => ({
  notification: mockNotification,
  apiConfig: mockApiConfig,
}));

vi.mock('@dpg/config', () => ({
  loadEmailMessagesFiles: mockLoadEmailMessagesFiles,
}));

import {
  getEmailMessages,
  loadEmailMessagesIndex,
  resetEmailMessagesForTests,
} from '../messages';

/** Minimal valid defaults: every required key present. */
function fullDefaults(): string {
  return requiredMessageKeys()
    .map((k) => `${k}=default ${k}`)
    .join('\n');
}

describe('loadEmailMessagesIndex (base layer: defaults + instance override)', () => {
  it('throws at load when the bundled defaults are incomplete', () => {
    expect(() => loadEmailMessagesIndex({ defaultsText: 'welcome.subject=x' })).toThrow(
      /bundled email messages file is missing/,
    );
  });

  it('serves defaults when no override is given', () => {
    const index = loadEmailMessagesIndex({ defaultsText: fullDefaults() });
    expect(index.forContext().get('welcome.subject')).toBe('default welcome.subject');
  });

  it('merges per-key: override wins, everything else falls back', () => {
    const warn = vi.fn();
    const index = loadEmailMessagesIndex({
      defaultsText: fullDefaults(),
      instanceOverrideText: 'welcome.subject=Custom hello!',
      warn,
    });
    const m = index.forContext();
    expect(m.get('welcome.subject')).toBe('Custom hello!');
    expect(m.get('welcome.body')).toBe('default welcome.body');
  });

  it('warns about unknown override keys (typo catcher)', () => {
    const warn = vi.fn();
    loadEmailMessagesIndex({
      defaultsText: fullDefaults(),
      instanceOverrideText: 'welcom.subject=typo',
      warn,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('welcom.subject'));
  });

  it('warns about undeclared placeholders but keeps the value as written', () => {
    const warn = vi.fn();
    const index = loadEmailMessagesIndex({
      defaultsText: fullDefaults(),
      instanceOverrideText: 'welcome.body=<p>{{otpp}}</p>',
      warn,
    });
    const m = index.forContext();
    expect(m.get('welcome.body')).toBe('<p>{{otpp}}</p>');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('{{otpp}}'));
  });

  it('warns about malformed override lines and ignores them', () => {
    const warn = vi.fn();
    const index = loadEmailMessagesIndex({
      defaultsText: fullDefaults(),
      instanceOverrideText: 'this line has no equals\nwelcome.subject=ok',
      warn,
    });
    expect(index.forContext().get('welcome.subject')).toBe('ok');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('line 1'));
  });

  it('ignores empty override values with a warning (never blanks an email)', () => {
    const warn = vi.fn();
    const index = loadEmailMessagesIndex({
      defaultsText: fullDefaults(),
      instanceOverrideText: 'welcome.subject=\nwelcome.body=Custom body',
      warn,
    });
    expect(index.forContext().get('welcome.subject')).toBe('default welcome.subject');
    expect(index.forContext().get('welcome.body')).toBe('Custom body');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('empty value for "welcome.subject"'),
    );
  });

  it('get() throws for unknown keys', () => {
    const index = loadEmailMessagesIndex({ defaultsText: fullDefaults() });
    expect(() => index.forContext().get('nope.nope')).toThrow(
      'unknown email message key: nope.nope',
    );
  });
});

describe('loadEmailMessagesIndex (network + brand layers)', () => {
  it('network layer overrides base for its network only', () => {
    const layers: LoadedEmailMessagesFile[] = [
      { network: 'blue_dot', brand: null, text: 'welcome.subject=Blue Dot Hello' },
    ];
    const index = loadEmailMessagesIndex({ defaultsText: fullDefaults(), layers });

    expect(index.forContext('blue_dot').get('welcome.subject')).toBe('Blue Dot Hello');
    // Unaffected network: base only.
    expect(index.forContext('yellow_dot').get('welcome.subject')).toBe(
      'default welcome.subject',
    );
    // No network context at all: base only.
    expect(index.forContext().get('welcome.subject')).toBe('default welcome.subject');
  });

  it('brand overrides network, which overrides base', () => {
    const layers: LoadedEmailMessagesFile[] = [
      { network: 'blue_dot', brand: null, text: 'welcome.subject=Network Hello' },
      { network: 'blue_dot', brand: 'upsdm', text: 'welcome.subject=Brand Hello' },
    ];
    const index = loadEmailMessagesIndex({ defaultsText: fullDefaults(), layers });

    expect(index.forContext('blue_dot', 'upsdm').get('welcome.subject')).toBe('Brand Hello');
    expect(index.forContext('blue_dot').get('welcome.subject')).toBe('Network Hello');
    expect(index.forContext().get('welcome.subject')).toBe('default welcome.subject');
  });

  it('brand override inherits non-overridden keys from its network, not just base', () => {
    const layers: LoadedEmailMessagesFile[] = [
      {
        network: 'blue_dot',
        brand: null,
        text: 'welcome.subject=Network Hello\nwelcome.body=Network body',
      },
      { network: 'blue_dot', brand: 'upsdm', text: 'welcome.subject=Brand Hello' },
    ];
    const index = loadEmailMessagesIndex({ defaultsText: fullDefaults(), layers });

    const m = index.forContext('blue_dot', 'upsdm');
    expect(m.get('welcome.subject')).toBe('Brand Hello');
    expect(m.get('welcome.body')).toBe('Network body');
  });

  it('unknown network falls back to base', () => {
    const layers: LoadedEmailMessagesFile[] = [
      { network: 'blue_dot', brand: null, text: 'welcome.subject=Blue Dot Hello' },
    ];
    const index = loadEmailMessagesIndex({ defaultsText: fullDefaults(), layers });

    expect(index.forContext('yellow_dot').get('welcome.subject')).toBe(
      'default welcome.subject',
    );
  });

  it('unknown brand for a known network falls back to the network layer', () => {
    const layers: LoadedEmailMessagesFile[] = [
      { network: 'blue_dot', brand: null, text: 'welcome.subject=Network Hello' },
      { network: 'blue_dot', brand: 'upsdm', text: 'welcome.subject=Brand Hello' },
    ];
    const index = loadEmailMessagesIndex({ defaultsText: fullDefaults(), layers });

    expect(index.forContext('blue_dot', 'no_such_brand').get('welcome.subject')).toBe(
      'Network Hello',
    );
  });

  it('brand file for a network with no network file merges over base', () => {
    const layers: LoadedEmailMessagesFile[] = [
      { network: 'blue_dot', brand: 'upsdm', text: 'welcome.subject=Brand Only Hello' },
    ];
    const index = loadEmailMessagesIndex({ defaultsText: fullDefaults(), layers });

    expect(index.forContext('blue_dot', 'upsdm').get('welcome.subject')).toBe(
      'Brand Only Hello',
    );
    // No network layer was created, so context with only the network falls
    // back to base.
    expect(index.forContext('blue_dot').get('welcome.subject')).toBe(
      'default welcome.subject',
    );
  });

  it('instance override still applies underneath network/brand layers', () => {
    const layers: LoadedEmailMessagesFile[] = [
      { network: 'blue_dot', brand: null, text: 'welcome.body=Network body' },
    ];
    const index = loadEmailMessagesIndex({
      defaultsText: fullDefaults(),
      instanceOverrideText: 'welcome.subject=Instance subject',
      layers,
    });

    const m = index.forContext('blue_dot');
    expect(m.get('welcome.subject')).toBe('Instance subject');
    expect(m.get('welcome.body')).toBe('Network body');
  });

  it('per-layer unknown-key warns carry the network layer label', () => {
    const warn = vi.fn();
    const layers: LoadedEmailMessagesFile[] = [
      { network: 'blue_dot', brand: null, text: 'welcom.subject=typo' },
    ];
    loadEmailMessagesIndex({ defaultsText: fullDefaults(), layers, warn });

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/network blue_dot.*welcom\.subject/),
    );
  });

  it('per-layer unknown-key warns carry the network+brand layer label', () => {
    const warn = vi.fn();
    const layers: LoadedEmailMessagesFile[] = [
      { network: 'blue_dot', brand: null, text: 'welcome.subject=Network Hello' },
      { network: 'blue_dot', brand: 'upsdm', text: 'welcom.subject=typo' },
    ];
    loadEmailMessagesIndex({ defaultsText: fullDefaults(), layers, warn });

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/network blue_dot brand upsdm.*welcom\.subject/),
    );
  });

  it('pins all four tiers on one key: brand wins over network, network over instance override, override over defaults', () => {
    const layers: LoadedEmailMessagesFile[] = [
      { network: 'blue_dot', brand: null, text: 'welcome.subject=Network Hello' },
      { network: 'blue_dot', brand: 'upsdm', text: 'welcome.subject=Brand Hello' },
    ];
    const index = loadEmailMessagesIndex({
      defaultsText: fullDefaults(),
      instanceOverrideText: 'welcome.subject=Instance Hello',
      layers,
    });

    expect(index.forContext('blue_dot', 'upsdm').get('welcome.subject')).toBe('Brand Hello');
    expect(index.forContext('blue_dot').get('welcome.subject')).toBe('Network Hello');
    expect(index.forContext().get('welcome.subject')).toBe('Instance Hello');
  });

  it('per-layer malformed-line warns carry the layer label', () => {
    const warn = vi.fn();
    const layers: LoadedEmailMessagesFile[] = [
      { network: 'blue_dot', brand: null, text: 'not a valid line' },
    ];
    loadEmailMessagesIndex({ defaultsText: fullDefaults(), layers, warn });

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/network blue_dot.*line 1/));
  });
});

describe('getEmailMessages (singleton + EMAIL_MESSAGES_PATH + network/brand wiring)', () => {
  beforeEach(() => {
    resetEmailMessagesForTests();
    mockNotification.EMAIL_MESSAGES_PATH = undefined;
    mockApiConfig.served_domains = [{ network: 'blue_dot', domain: 'blue.example', key: 'k' }];
    mockApiConfig.network_config_source = 'remote';
    mockApiConfig.network_config_local_file = '/nonexistent/network.json';
    mockLoadEmailMessagesFiles.mockReset();
    mockLoadEmailMessagesFiles.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetEmailMessagesForTests();
  });

  it('serves bundled defaults and warns nothing when no override path or layers are set', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockApiConfig.network_config_source = 'local';

    const index = await getEmailMessages();

    expect(index.forContext().get('welcome.subject')).toBe('Welcome!');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns that network/brand copy files are skipped in remote network-config mode', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockApiConfig.network_config_source = 'remote';

    await getEmailMessages();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('network/brand copy files are not loaded'),
    );
  });

  it('warns (with the path) and falls back to bundled defaults when the override file is unreadable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const badPath = '/no/such/path/messages.override.properties';
    mockNotification.EMAIL_MESSAGES_PATH = badPath;

    const index = await getEmailMessages();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(badPath));
    expect(index.forContext().get('welcome.subject')).toBe('Welcome!');
  });

  it('reuses the same instance across calls (singleton) without re-reading', async () => {
    const p1 = getEmailMessages();
    const p2 = getEmailMessages();
    expect(p1).toBe(p2);

    const [m1, m2] = await Promise.all([p1, p2]);
    expect(m1).toBe(m2);
  });

  it('resetEmailMessagesForTests() clears the singleton so the next call re-loads', async () => {
    const m1 = await getEmailMessages();
    resetEmailMessagesForTests();
    const m2 = await getEmailMessages();
    expect(m1).not.toBe(m2);
  });

  it('wires apiConfig fields into loadEmailMessagesFiles and threads the resulting layers', async () => {
    mockApiConfig.network_config_source = 'local';
    mockApiConfig.network_config_local_file = '/fake/dir/network.json';
    mockApiConfig.served_domains = [
      { network: 'blue_dot', domain: 'blue.example', key: 'k1' },
      { network: 'blue_dot', domain: 'blue2.example', key: 'k2' },
    ];
    mockLoadEmailMessagesFiles.mockResolvedValue([
      { network: 'blue_dot', brand: null, text: 'welcome.subject=Blue Dot Hello' },
    ]);

    const index = await getEmailMessages();

    expect(mockLoadEmailMessagesFiles).toHaveBeenCalledWith({
      source: 'local',
      networkLocalFile: '/fake/dir/network.json',
      networks: ['blue_dot'],
    });
    expect(index.forContext('blue_dot').get('welcome.subject')).toBe('Blue Dot Hello');
    expect(index.forContext().get('welcome.subject')).toBe('Welcome!');
  });

  it('falls back to instance/base copy and warns when loadEmailMessagesFiles rejects (e.g. a permissions error)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockApiConfig.network_config_source = 'local';
    mockApiConfig.network_config_local_file = '/fake/dir/network.json';
    const readError = new Error('EACCES: permission denied');
    mockLoadEmailMessagesFiles.mockRejectedValue(readError);

    const index = await getEmailMessages();

    expect(index.forContext().get('welcome.subject')).toBe('Welcome!');
    expect(index.forContext('blue_dot').get('welcome.subject')).toBe('Welcome!');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
  });
});
