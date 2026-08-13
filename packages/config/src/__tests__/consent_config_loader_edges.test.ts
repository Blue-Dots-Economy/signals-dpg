import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConsentConfigs } from '../consent_config_loader';

type ConsentDoc = Record<string, unknown>;

function contentDocument(title: string, content: string): ConsentDoc {
  return {
    current_version: 1,
    versions: [{ version: 1, title, content, effective_from: '2026-01-01' }],
  };
}

function statementDocument(statement: string): ConsentDoc {
  return {
    current_version: 1,
    versions: [{ version: 1, statement, effective_from: '2026-01-01' }],
  };
}

function fullConsentConfig(): ConsentDoc {
  return {
    documents: {
      terms: contentDocument('Terms', 'Questions? Write to __SUPPORT_EMAIL__.'),
      privacy: contentDocument('Privacy', 'Privacy body'),
      profile_creation: statementDocument('I agree to publish this profile.'),
    },
  };
}

/**
 * Builds a network folder: `network.json` plus whatever consent files the case
 * needs. The loader resolves everything relative to dirname(networkLocalFile).
 */
async function makeNetworkDir(): Promise<{ dir: string; networkFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dpg-consent-'));
  const networkFile = join(dir, 'network.json');
  await writeFile(networkFile, JSON.stringify({ id: 'yellow_dot' }), 'utf8');
  return { dir, networkFile };
}

describe('loadConsentConfigs guard clauses', () => {
  it('returns [] for the remote source (remote delivery is still a stub)', async () => {
    const { dir, networkFile } = await makeNetworkDir();
    // A perfectly good local consent.json is present and still ignored.
    await writeFile(join(dir, 'consent.json'), JSON.stringify(fullConsentConfig()), 'utf8');

    await expect(
      loadConsentConfigs({
        source: 'remote',
        networkLocalFile: networkFile,
        networks: ['yellow_dot'],
      })
    ).resolves.toEqual([]);
  });

  it('returns [] when no networks are supplied', async () => {
    const { dir, networkFile } = await makeNetworkDir();
    await writeFile(join(dir, 'consent.json'), JSON.stringify(fullConsentConfig()), 'utf8');

    await expect(
      loadConsentConfigs({ source: 'local', networkLocalFile: networkFile, networks: [] })
    ).resolves.toEqual([]);
  });

  it('returns [] when the network has no consent.json beside network.json', async () => {
    const { networkFile } = await makeNetworkDir();

    await expect(
      loadConsentConfigs({
        source: 'local',
        networkLocalFile: networkFile,
        networks: ['yellow_dot'],
      })
    ).resolves.toEqual([]);
  });

  it('uses only the first network entry (local mode is single-network)', async () => {
    const { dir, networkFile } = await makeNetworkDir();
    await writeFile(join(dir, 'consent.json'), JSON.stringify(fullConsentConfig()), 'utf8');

    const loaded = await loadConsentConfigs({
      source: 'local',
      networkLocalFile: networkFile,
      networks: ['yellow_dot', 'blue_dot'],
    });

    expect(loaded).toHaveLength(1);
    expect(loaded[0].network).toBe('yellow_dot');
    expect(loaded.some((e) => e.network === 'blue_dot')).toBe(false);
  });

  it('rethrows a read error that is not ENOENT', async () => {
    const { dir, networkFile } = await makeNetworkDir();
    // A directory where consent.json is expected → EISDIR, not ENOENT.
    await mkdir(join(dir, 'consent.json'));

    await expect(
      loadConsentConfigs({
        source: 'local',
        networkLocalFile: networkFile,
        networks: ['yellow_dot'],
      })
    ).rejects.toThrow(/EISDIR|EACCES|illegal operation/i);
  });

  it('rejects a consent.json that is not a valid full document set', async () => {
    const { dir, networkFile } = await makeNetworkDir();
    // profile_creation missing → ConsentConfigSchema rejects the network default.
    await writeFile(
      join(dir, 'consent.json'),
      JSON.stringify({
        documents: {
          terms: contentDocument('Terms', 'body'),
          privacy: contentDocument('Privacy', 'body'),
        },
      }),
      'utf8'
    );

    await expect(
      loadConsentConfigs({
        source: 'local',
        networkLocalFile: networkFile,
        networks: ['yellow_dot'],
      })
    ).rejects.toThrow();
  });
});

describe('loadConsentConfigs brand overrides', () => {
  it('accepts a brand override that sets only one document', async () => {
    const { dir, networkFile } = await makeNetworkDir();
    await writeFile(join(dir, 'consent.json'), JSON.stringify(fullConsentConfig()), 'utf8');
    await mkdir(join(dir, 'upsdm'));
    await writeFile(
      join(dir, 'upsdm', 'consent.json'),
      JSON.stringify({ documents: { terms: contentDocument('UPSDM Terms', 'Branded body') } }),
      'utf8'
    );

    const loaded = await loadConsentConfigs({
      source: 'local',
      networkLocalFile: networkFile,
      networks: ['yellow_dot'],
    });

    expect(loaded).toHaveLength(2);
    const brand = loaded.find((e) => e.brand === 'upsdm');
    expect(brand).toBeDefined();
    expect(brand!.config.documents?.terms?.versions[0].title).toBe('UPSDM Terms');
    // Unset documents stay absent — the consumer falls back to the network default.
    expect(brand!.config.documents?.privacy).toBeUndefined();
    expect(brand!.config.documents?.profile_creation).toBeUndefined();
  });

  it('skips a sub-folder that has no consent.json', async () => {
    const { dir, networkFile } = await makeNetworkDir();
    await writeFile(join(dir, 'consent.json'), JSON.stringify(fullConsentConfig()), 'utf8');
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'assets', 'logo.txt'), 'not consent', 'utf8');

    const loaded = await loadConsentConfigs({
      source: 'local',
      networkLocalFile: networkFile,
      networks: ['yellow_dot'],
    });

    expect(loaded).toHaveLength(1);
    expect(loaded[0].brand).toBeNull();
  });

  it('ignores sibling files, only immediate sub-folders are brands', async () => {
    const { dir, networkFile } = await makeNetworkDir();
    await writeFile(join(dir, 'consent.json'), JSON.stringify(fullConsentConfig()), 'utf8');
    await writeFile(join(dir, 'README.md'), 'docs', 'utf8');

    const loaded = await loadConsentConfigs({
      source: 'local',
      networkLocalFile: networkFile,
      networks: ['yellow_dot'],
    });

    expect(loaded.map((e) => e.brand)).toEqual([null]);
  });

  it('substitutes __SUPPORT_EMAIL__ in brand files too, not just the default', async () => {
    const { dir, networkFile } = await makeNetworkDir();
    await writeFile(join(dir, 'consent.json'), JSON.stringify(fullConsentConfig()), 'utf8');
    await mkdir(join(dir, 'upsdm'));
    await writeFile(
      join(dir, 'upsdm', 'consent.json'),
      JSON.stringify({
        documents: {
          terms: contentDocument('UPSDM Terms', 'Grievances: __SUPPORT_EMAIL__ only.'),
        },
      }),
      'utf8'
    );

    const loaded = await loadConsentConfigs({
      source: 'local',
      networkLocalFile: networkFile,
      networks: ['yellow_dot'],
      supportEmail: 'grievance@example.test',
    });

    const brand = loaded.find((e) => e.brand === 'upsdm');
    expect(brand!.config.documents?.terms?.versions[0].content).toBe(
      'Grievances: grievance@example.test only.'
    );
  });

  it('replaces every occurrence of the placeholder in one document', async () => {
    const { dir, networkFile } = await makeNetworkDir();
    await writeFile(
      join(dir, 'consent.json'),
      JSON.stringify({
        documents: {
          terms: contentDocument('Terms', 'Mail __SUPPORT_EMAIL__ or __SUPPORT_EMAIL__ again.'),
          privacy: contentDocument('Privacy', 'Contact __SUPPORT_EMAIL__.'),
          profile_creation: statementDocument('Questions to __SUPPORT_EMAIL__.'),
        },
      }),
      'utf8'
    );

    const loaded = await loadConsentConfigs({
      source: 'local',
      networkLocalFile: networkFile,
      networks: ['yellow_dot'],
      supportEmail: 'ops@example.test',
    });

    const def = loaded[0].config;
    expect(def.documents?.terms?.versions[0].content).toBe(
      'Mail ops@example.test or ops@example.test again.'
    );
    expect(def.documents?.profile_creation?.versions[0].statement).toBe(
      'Questions to ops@example.test.'
    );
  });
});
