import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPackages } from './build-packages.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDirectories = ['types', 'agent-runtime'];
const lockfileNames = new Set([
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
]);

function parseDestination(args) {
  if (args.length !== 2 || args[0] !== '--destination') {
    throw new Error('usage: node scripts/pack-packages.mjs --destination <directory>');
  }
  return resolve(args[1]);
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout || result.error?.message}`);
  }
  return result.stdout;
}

export function assertPackedManifestIsPublishable(manifest, source = 'packed manifest') {
  if (/(?:workspace|file|link):|\.\.[/\\]/.test(manifest)) {
    throw new Error(`${source} contains a local dependency reference`);
  }
}

export function assertTarballEntriesAreClean(entries, source = 'tarball') {
  for (const entry of entries) {
    const isAbsolute = /^[/\\]|^[A-Za-z]:[/\\]/.test(entry);
    const segments = entry.replaceAll('\\', '/').split('/').filter(Boolean);
    const filename = segments.at(-1) ?? '';
    const isEnvironmentFile = /^\.env(?:\.|$)/.test(filename);
    const isSourcePath = segments.includes('src');
    const isTestPath = segments.includes('test') || segments.includes('tests');
    const isLockfile = lockfileNames.has(filename);

    if (isAbsolute || isEnvironmentFile || isSourcePath || isTestPath || isLockfile) {
      throw new Error(`${source} contains unsafe archive entry ${entry}`);
    }
  }
}

function assertPackedTarballIsPublishable(tarball) {
  const listing = run('tar', ['-tzf', tarball], repositoryRoot)
    .split('\n')
    .filter(Boolean);
  assertTarballEntriesAreClean(listing, `packed tarball ${tarball}`);

  const manifest = run('tar', ['-xOf', tarball, 'package/package.json'], repositoryRoot);
  assertPackedManifestIsPublishable(manifest, `packed manifest ${tarball}`);
}

export function packPackages(destination) {
  if (!existsSync(destination)) {
    throw new Error(`destination does not exist: ${destination}`);
  }

  buildPackages();
  const npmCache = mkdtempSync(resolve(tmpdir(), 'forgeax-contracts-npm-cache-'));
  try {
    const tarballs = packageDirectories.map((packageName) => {
      const packageDirectory = resolve(repositoryRoot, packageName);
      const packageDestination = resolve(destination, packageName);
      mkdirSync(packageDestination, { recursive: true });
      const output = run(
        'npm',
        ['pack', '--json', '--ignore-scripts', '--pack-destination', packageDestination],
        packageDirectory,
        { ...process.env, npm_config_cache: npmCache },
      );
      const [{ filename }] = JSON.parse(output);
      const tarball = resolve(packageDestination, filename);
      assertPackedTarballIsPublishable(tarball);
      return tarball;
    });

    return { tarballs };
  } finally {
    rmSync(npmCache, { force: true, recursive: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const destination = parseDestination(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(packPackages(destination))}\n`);
}
