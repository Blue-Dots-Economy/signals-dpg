#!/usr/bin/env node

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const sourceEnvFile = resolve(root, process.env.ENV_FILE ?? '.env');
const image = process.env.API_IMAGE ?? 'dpg-api:local';
const containerName = process.env.API_CONTAINER_NAME ?? 'dpg-api';
const port = process.env.API_PORT ?? '2742';
const network = process.env.DOCKER_NETWORK;
const shouldBuild = process.env.SKIP_BUILD !== 'true';

function normalizeEnvValue(value) {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;

  const first = trimmed[0];
  const last = trimmed.at(-1);

  if (
    (first === '"' && last === '"') ||
    (first === "'" && last === "'")
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function normalizeDockerEnvEntry(key, value) {
  if (key !== 'NETWORK_CONFIG_LOCAL_FILE') return value;

  const resolvedFromApi = resolve(root, 'apps/api', value);
  const resolvedFromRoot = resolve(root, value);
  const resolvedPath = resolvedFromApi.startsWith(root + sep)
    ? resolvedFromApi
    : resolvedFromRoot;

  if (!resolvedPath.startsWith(root + sep)) return value;

  return relative(root, resolvedPath).split(sep).join('/');
}

function buildServiceUrl(protocol, password, host, port) {
  const auth = password ? `:${password}@` : '';
  return `${protocol}://${auth}${host}:${port}`;
}

function createDockerEnvFile() {
  const contents = readFileSync(sourceEnvFile, 'utf8');
  const entries = new Map();

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const assignment = trimmed.startsWith('export ')
      ? trimmed.slice('export '.length).trim()
      : trimmed;
    const separatorIndex = assignment.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = assignment.slice(0, separatorIndex).trim();
    const value = normalizeEnvValue(assignment.slice(separatorIndex + 1));
    if (!key) continue;

    entries.set(key, normalizeDockerEnvEntry(key, value));
  }

  if (network) {
    const postgresHost = process.env.POSTGRES_HOST ?? 'db';
    const postgresPort = process.env.POSTGRES_PORT ?? '5432';
    const redisHost = process.env.REDIS_HOST ?? 'redis';
    const redisPort = process.env.REDIS_PORT ?? '6379';

    entries.set('POSTGRES_HOST', postgresHost);
    entries.set('POSTGRES_PORT', postgresPort);
    entries.set('REDIS_HOST', redisHost);
    entries.set('REDIS_PORT', redisPort);

    const redisPassword = entries.get('REDIS_PASSWORD');
    const postgresPassword = entries.get('POSTGRES_PASSWORD');
    const postgresUser = entries.get('POSTGRES_USER');
    const postgresDb = entries.get('POSTGRES_DB');

    if (!process.env.REDIS_URL && redisPassword) {
      entries.set(
        'REDIS_URL',
        buildServiceUrl('redis', redisPassword, redisHost, redisPort)
      );
    }

    if (
      !process.env.POSTGRES_URL &&
      postgresUser &&
      postgresPassword &&
      postgresDb
    ) {
      entries.set(
        'POSTGRES_URL',
        `postgres://${postgresUser}:${postgresPassword}@${postgresHost}:${postgresPort}/${postgresDb}`
      );
    }
  }

  const lines = [...entries.entries()].map(([key, value]) => `${key}=${value}`);

  const tmpDir = mkdtempSync(resolve(tmpdir(), 'dpg-api-env-'));
  const dockerEnvFile = resolve(tmpDir, 'api.env');
  writeFileSync(dockerEnvFile, `${lines.join('\n')}\n`);
  return dockerEnvFile;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(`Failed to run ${command}:`, result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (shouldBuild) {
  run('docker', ['build', '-f', 'apps/api/Dockerfile', '-t', image, '.']);
}

const dockerEnvFile = createDockerEnvFile();
const runArgs = [
  'run',
  '--rm',
  '--name',
  containerName,
  '--env-file',
  dockerEnvFile,
  '-p',
  `${port}:2742`,
];

if (network) {
  runArgs.push('--network', network);
} else {
  runArgs.push('--add-host=host.docker.internal:host-gateway');
}

runArgs.push(image);
run('docker', runArgs);
