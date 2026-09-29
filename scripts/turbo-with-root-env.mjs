#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch (error) {
    console.error(`Failed to load ${envPath}:`, error);
    process.exit(1);
  }
}

const turboArgs = process.argv.slice(2);
if (turboArgs.length === 0) {
  console.error('Usage: node scripts/turbo-with-root-env.mjs <turbo args>');
  process.exit(1);
}

/**
 * turbo's own entry point (`turbo/bin/turbo`, a Node script), run with the
 * current `node`. Spawning it this way needs no shell on any platform.
 *
 * The previous version spawned `node_modules/.bin/turbo.cmd` on Windows. Since
 * the CVE-2024-27980 fix (Node 18.20.2 / 20.12.2 / 21.7.3 and every later
 * major), Node refuses to spawn a `.cmd`/`.bat` without `shell: true` and
 * throws `spawn EINVAL` — so `pnpm dev:api` / `pnpm dev:ui` failed on every
 * Windows machine. `shell: true` is not the fix either: passing arguments with
 * it is deprecated (DEP0190) and re-parses them through cmd.exe.
 */
function resolveTurboEntry() {
  try {
    const require = createRequire(resolve(process.cwd(), 'package.json'));
    const pkgPath = require.resolve('turbo/package.json');
    const bin = JSON.parse(readFileSync(pkgPath, 'utf8')).bin;
    const rel = typeof bin === 'string' ? bin : bin?.turbo;
    return rel ? resolve(dirname(pkgPath), rel) : null;
  } catch {
    return null;
  }
}

const turboEntry = resolveTurboEntry();
const [command, args, options] = turboEntry
  ? [process.execPath, [turboEntry, ...turboArgs], {}]
  : // No local turbo: fall back to one on PATH. On Windows that is a .cmd
    // shim, which only a shell can start.
    ['turbo', turboArgs, { shell: process.platform === 'win32' }];

const child = spawn(command, args, {
  stdio: 'inherit',
  env: process.env,
  ...options,
});

child.on('error', (error) => {
  console.error('Failed to start turbo:', error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
