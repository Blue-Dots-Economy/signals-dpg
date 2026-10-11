import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadSmsTemplatesFiles } from '../sms_templates_loader';

/**
 * Builds a network folder: `network.json` plus whatever sms.properties files
 * the case needs. Mirrors the email loader's test harness, because the deploy
 * pipeline lays both files out the same way.
 */
async function makeNetworkDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sms-templates-'));
  await writeFile(join(dir, 'network.json'), '{"id":"purple_dot"}', 'utf8');
  return dir;
}

const localOpts = (dir: string, networks = ['purple_dot']) =>
  ({ source: 'local' as const, networkLocalFile: join(dir, 'network.json'), networks });

describe('loadSmsTemplatesFiles', () => {
  it('reads the network-level sms.properties beside network.json', async () => {
    const dir = await makeNetworkDir();
    await writeFile(join(dir, 'sms.properties'), 'profile.create.template_id=', 'utf8');

    await expect(loadSmsTemplatesFiles(localOpts(dir))).resolves.toEqual([
      { network: 'purple_dot', brand: null, text: 'profile.create.template_id=' },
    ]);
  });

  it('reads a brand override from an immediate sub-folder, network layer first', async () => {
    const dir = await makeNetworkDir();
    await writeFile(join(dir, 'sms.properties'), 'profile.create.body=network', 'utf8');
    await mkdir(join(dir, 'alimco'));
    await writeFile(join(dir, 'alimco', 'sms.properties'), 'profile.create.body=alimco', 'utf8');

    const files = await loadSmsTemplatesFiles(localOpts(dir));

    expect(files).toEqual([
      { network: 'purple_dot', brand: null, text: 'profile.create.body=network' },
      { network: 'purple_dot', brand: 'alimco', text: 'profile.create.body=alimco' },
    ]);
  });

  it('still scans brand sub-folders when the network has no sms.properties', async () => {
    // The bundled defaults are always the base layer, so a brand-only file is
    // valid on its own — the ALIMCO case exactly.
    const dir = await makeNetworkDir();
    await mkdir(join(dir, 'alimco'));
    await writeFile(join(dir, 'alimco', 'sms.properties'), 'profile.create.body=alimco', 'utf8');

    await expect(loadSmsTemplatesFiles(localOpts(dir))).resolves.toEqual([
      { network: 'purple_dot', brand: 'alimco', text: 'profile.create.body=alimco' },
    ]);
  });

  it('returns [] when neither the network nor any brand has a file', async () => {
    const dir = await makeNetworkDir();
    await mkdir(join(dir, 'alimco'));

    await expect(loadSmsTemplatesFiles(localOpts(dir))).resolves.toEqual([]);
  });

  it('returns [] for a non-local source', async () => {
    const dir = await makeNetworkDir();
    await writeFile(join(dir, 'sms.properties'), 'profile.create.template_id=x', 'utf8');

    await expect(
      loadSmsTemplatesFiles({ ...localOpts(dir), source: 'remote' })
    ).resolves.toEqual([]);
  });

  it('returns [] when no network is served', async () => {
    const dir = await makeNetworkDir();
    await writeFile(join(dir, 'sms.properties'), 'profile.create.template_id=x', 'utf8');

    await expect(loadSmsTemplatesFiles(localOpts(dir, []))).resolves.toEqual([]);
  });

  it('rethrows a non-ENOENT read error rather than silently dropping the layer', async () => {
    // A directory where the file belongs → EISDIR, not ENOENT. Swallowing it
    // would ship bundled templates with no signal that a file was unreadable.
    const dir = await makeNetworkDir();
    await mkdir(join(dir, 'sms.properties'));

    await expect(loadSmsTemplatesFiles(localOpts(dir))).rejects.toThrow();
  });
});
