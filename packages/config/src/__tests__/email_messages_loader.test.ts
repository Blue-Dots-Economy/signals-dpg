import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEmailMessagesFiles } from '../email_messages_loader';

/**
 * Builds a network folder: `network.json` plus whatever messages.properties
 * files the case needs. The loader resolves everything relative to
 * dirname(networkLocalFile), mirroring the consent loader.
 */
async function makeNetworkDir(): Promise<{ dir: string; networkFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dpg-email-messages-'));
  const networkFile = join(dir, 'network.json');
  await writeFile(networkFile, JSON.stringify({ id: 'yellow_dot' }), 'utf8');
  return { dir, networkFile };
}

describe('loadEmailMessagesFiles guard clauses', () => {
  it('returns [] for the remote source (remote delivery is a follow-up)', async () => {
    const { dir, networkFile } = await makeNetworkDir();
    await writeFile(join(dir, 'messages.properties'), 'welcome.subject=Hi', 'utf8');

    await expect(
      loadEmailMessagesFiles({
        source: 'remote',
        networkLocalFile: networkFile,
        networks: ['yellow_dot'],
      })
    ).resolves.toEqual([]);
  });

  it('returns [] when no networks are supplied', async () => {
    const { dir, networkFile } = await makeNetworkDir();
    await writeFile(join(dir, 'messages.properties'), 'welcome.subject=Hi', 'utf8');

    await expect(
      loadEmailMessagesFiles({ source: 'local', networkLocalFile: networkFile, networks: [] })
    ).resolves.toEqual([]);
  });

  it('returns [] when the network has no messages.properties and no brand sub-folders either', async () => {
    const { networkFile } = await makeNetworkDir();

    await expect(
      loadEmailMessagesFiles({
        source: 'local',
        networkLocalFile: networkFile,
        networks: ['yellow_dot'],
      })
    ).resolves.toEqual([]);
  });

  it('still scans brand sub-folders when the network has no messages.properties beside network.json', async () => {
    const { dir, networkFile } = await makeNetworkDir();
    await mkdir(join(dir, 'upsdm'));
    await writeFile(
      join(dir, 'upsdm', 'messages.properties'),
      'welcome.subject=UPSDM Hi there',
      'utf8'
    );

    const loaded = await loadEmailMessagesFiles({
      source: 'local',
      networkLocalFile: networkFile,
      networks: ['yellow_dot'],
    });

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual({
      network: 'yellow_dot',
      brand: 'upsdm',
      text: 'welcome.subject=UPSDM Hi there',
    });
  });

  it('uses only the first network entry (local mode is single-network)', async () => {
    const { dir, networkFile } = await makeNetworkDir();
    await writeFile(join(dir, 'messages.properties'), 'welcome.subject=Hi', 'utf8');

    const loaded = await loadEmailMessagesFiles({
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
    // A directory where messages.properties is expected → EISDIR, not ENOENT.
    await mkdir(join(dir, 'messages.properties'));

    await expect(
      loadEmailMessagesFiles({
        source: 'local',
        networkLocalFile: networkFile,
        networks: ['yellow_dot'],
      })
    ).rejects.toThrow(/EISDIR|EACCES|illegal operation/i);
  });
});

describe('loadEmailMessagesFiles brand overrides', () => {
  it('loads the network default text with brand null', async () => {
    const { dir, networkFile } = await makeNetworkDir();
    await writeFile(join(dir, 'messages.properties'), 'welcome.subject=Hi there', 'utf8');

    const loaded = await loadEmailMessagesFiles({
      source: 'local',
      networkLocalFile: networkFile,
      networks: ['yellow_dot'],
    });

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual({
      network: 'yellow_dot',
      brand: null,
      text: 'welcome.subject=Hi there',
    });
  });

  it('loads a brand override from an immediate sub-folder, verbatim text and no parsing', async () => {
    const { dir, networkFile } = await makeNetworkDir();
    await writeFile(join(dir, 'messages.properties'), 'welcome.subject=Hi there', 'utf8');
    await mkdir(join(dir, 'upsdm'));
    await writeFile(
      join(dir, 'upsdm', 'messages.properties'),
      'welcome.subject=UPSDM Hi there',
      'utf8'
    );

    const loaded = await loadEmailMessagesFiles({
      source: 'local',
      networkLocalFile: networkFile,
      networks: ['yellow_dot'],
    });

    expect(loaded).toHaveLength(2);
    const brand = loaded.find((e) => e.brand === 'upsdm');
    expect(brand).toEqual({
      network: 'yellow_dot',
      brand: 'upsdm',
      text: 'welcome.subject=UPSDM Hi there',
    });
  });

  it('skips a sub-folder that has no messages.properties', async () => {
    const { dir, networkFile } = await makeNetworkDir();
    await writeFile(join(dir, 'messages.properties'), 'welcome.subject=Hi there', 'utf8');
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'assets', 'logo.txt'), 'not messages', 'utf8');

    const loaded = await loadEmailMessagesFiles({
      source: 'local',
      networkLocalFile: networkFile,
      networks: ['yellow_dot'],
    });

    expect(loaded).toHaveLength(1);
    expect(loaded[0].brand).toBeNull();
  });

  it('ignores sibling files, only immediate sub-folders are brands', async () => {
    const { dir, networkFile } = await makeNetworkDir();
    await writeFile(join(dir, 'messages.properties'), 'welcome.subject=Hi there', 'utf8');
    await writeFile(join(dir, 'README.md'), 'docs', 'utf8');

    const loaded = await loadEmailMessagesFiles({
      source: 'local',
      networkLocalFile: networkFile,
      networks: ['yellow_dot'],
    });

    expect(loaded.map((e) => e.brand)).toEqual([null]);
  });
});
