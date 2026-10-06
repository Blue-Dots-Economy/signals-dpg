/**
 * pnpm --filter ns-catalogue generate <schemasRepoDir> [--version <v>]
 *
 * Writes `<dir>/ns-catalogue.json` for every F2-7 directory of a
 * bluedots-schemas checkout and prints the warnings. Run by hand; the output is
 * committed to bluedots-schemas. Exits 1, writing nothing for that directory,
 * when a catalogue would break an NS rule.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { CATALOGUE_FILE, generateForSchemasRepo } from './schemas_repo';

function defaultVersion(schemasDir: string): string {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  try {
    const sha = execFileSync('git', ['-C', schemasDir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    return `${sha}-${date}`;
  } catch {
    process.stderr.write('warning: the schemas dir is not a git checkout; the version is the date only\n');
    return date;
  }
}

function main(argv: string[]): number {
  const args = [...argv];
  let version: string | undefined;
  const vi = args.indexOf('--version');
  if (vi !== -1) {
    version = args[vi + 1];
    args.splice(vi, 2);
  }
  if (args.length !== 1 || (vi !== -1 && !version)) {
    process.stderr.write('usage: pnpm --filter ns-catalogue generate <schemasRepoDir> [--version <v>]\n');
    return 2;
  }
  // pnpm --filter runs scripts in the package dir; resolve against where the user ran it.
  const schemasDir = resolve(process.env.INIT_CWD ?? process.cwd(), args[0]);
  const results = generateForSchemasRepo(schemasDir, { version: version ?? defaultVersion(schemasDir), write: true });

  let failed = false;
  for (const r of results) {
    if (r.catalogue && r.errors.length === 0) {
      process.stdout.write(
        `${r.dir}/${CATALOGUE_FILE}: network ${r.networkId}, ${r.catalogue.templates.length} templates, ${r.catalogue.policies.length} policies\n`,
      );
    } else if (r.errors.length > 0) {
      failed = true;
      process.stdout.write(`${r.dir}: NOT written, NS would reject it:\n`);
      for (const e of r.errors) process.stdout.write(`  error: ${e}\n`);
    }
    for (const w of r.warnings) process.stdout.write(`  warning: ${w}\n`);
  }
  return failed ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
