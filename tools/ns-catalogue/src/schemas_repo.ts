import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { mergeCopy, readDefaultCopyText, type CopyLayer } from './copy';
import { buildCatalogue, type NsCatalogue } from './generate';
import { loginOtpSignoffFor } from './login_otp_email';
import { catalogueErrors } from './ns_rules';

/** F2-7: one catalogue per bluedots-schemas directory, written beside it. */
export const F2_7_DIRS = [
  'blue_dot',
  'blue_dot/up-gzb',
  'blue_dot/ka-dhwd',
  'blue_dot/upsdm',
  'purple_dot',
  'purple_dot/alimco',
  'yellow_dot',
  'orange_dot',
  'orange_dot/onetac',
] as const;

export const CATALOGUE_FILE = 'ns-catalogue.json';

export interface DirResult {
  dir: string;
  networkId: string | null;
  catalogue: NsCatalogue | null;
  warnings: string[];
  /** NS schema or publish rule breaks; the CLI writes nothing when any exist. */
  errors: string[];
}

interface NetworkJson {
  id: string;
  domains: Array<{ id: string }>;
  actions?: Record<string, unknown>;
}

function readNetworkJson(path: string): NetworkJson {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<NetworkJson>;
  if (typeof parsed.id !== 'string' || !Array.isArray(parsed.domains)) {
    throw new Error(`${path}: expected an "id" string and a "domains" array`);
  }
  return {
    id: parsed.id,
    domains: parsed.domains,
    actions: parsed.actions && typeof parsed.actions === 'object' ? parsed.actions : {},
  };
}

function readIfPresent(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/**
 * One directory's catalogue. The network root is the first path segment: its
 * messages.properties is the network copy layer, and a nested directory's own
 * messages.properties is the brand layer (F2-3). The directory's own
 * network.json wins; a brand directory without one uses its root's.
 */
export function generateForDir(schemasDir: string, dir: string, version: string): DirResult {
  const warnings: string[] = [];
  const abs = join(schemasDir, dir);
  if (!existsSync(abs)) {
    return { dir, networkId: null, catalogue: null, warnings: [`${dir}: not found in the schemas repo; skipped`], errors: [] };
  }
  const root = dir.split('/')[0];
  const isBrand = root !== dir;

  let networkPath = join(abs, 'network.json');
  if (!existsSync(networkPath)) {
    networkPath = join(schemasDir, root, 'network.json');
    if (!isBrand || !existsSync(networkPath)) {
      return { dir, networkId: null, catalogue: null, warnings: [`${dir}: no network.json; skipped`], errors: [] };
    }
    warnings.push(`${dir}: has no network.json of its own; uses ${root}/network.json`);
  }
  const network = readNetworkJson(networkPath);

  const layers: CopyLayer[] = [];
  const networkCopy = readIfPresent(join(schemasDir, root, 'messages.properties'));
  if (networkCopy !== null) layers.push({ label: `network ${network.id}`, text: networkCopy });
  if (isBrand) {
    const brandCopy = readIfPresent(join(abs, 'messages.properties'));
    if (brandCopy !== null) layers.push({ label: `network ${network.id} brand ${dir}`, text: brandCopy });
  }
  const merged = mergeCopy(readDefaultCopyText(), layers);
  warnings.push(...merged.warnings);

  const { catalogue, warnings: buildWarnings } = buildCatalogue({
    networkId: network.id,
    domains: network.domains.map((d) => d.id),
    actionTypes: Object.keys(network.actions ?? {}),
    copy: merged.copy,
    version,
    loginOtpSignoff: loginOtpSignoffFor(dir),
  });
  warnings.push(...buildWarnings);
  return { dir, networkId: network.id, catalogue, warnings, errors: catalogueErrors(catalogue) };
}

/** Pretty-printed, key-sorted JSON with a trailing newline, so regenerating is diff-stable. */
export function stableJson(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/** Generate every listed directory's catalogue; writes `<dir>/ns-catalogue.json` when `write` and error-free. */
export function generateForSchemasRepo(
  schemasDir: string,
  opts: { dirs?: readonly string[]; version: string; write: boolean },
): DirResult[] {
  return (opts.dirs ?? F2_7_DIRS).map((dir) => {
    const result = generateForDir(schemasDir, dir, opts.version);
    if (opts.write && result.catalogue && result.errors.length === 0) {
      writeFileSync(join(schemasDir, dir, CATALOGUE_FILE), stableJson(result.catalogue));
    }
    return result;
  });
}
