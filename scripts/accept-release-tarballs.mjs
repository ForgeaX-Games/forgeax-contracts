import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'usage: node scripts/accept-release-tarballs.mjs --types <tarball> --agent-runtime <tarball>';

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout || result.error?.message}`);
  }
  return result.stdout;
}

function parseArgs(args) {
  if (
    args.length !== 4
    || args[0] !== '--types'
    || args[2] !== '--agent-runtime'
    || !args[1]
    || !args[3]
  ) {
    throw new Error(usage);
  }

  return {
    typesTarball: resolve(args[1]),
    agentRuntimeTarball: resolve(args[3]),
  };
}

function assertTarballExists(tarball, packageName) {
  if (!tarball.endsWith('.tgz') || !existsSync(tarball)) {
    throw new Error(`${packageName} tarball does not exist: ${tarball}`);
  }
}

function readPackedManifest(tarball) {
  return JSON.parse(run('tar', ['-xOf', tarball, 'package/package.json'], repositoryRoot));
}

function assertReleasePair(typesTarball, agentRuntimeTarball) {
  assertTarballExists(typesTarball, '@forgeax/types');
  assertTarballExists(agentRuntimeTarball, '@forgeax/agent-runtime');

  const types = readPackedManifest(typesTarball);
  const agentRuntime = readPackedManifest(agentRuntimeTarball);
  if (types.name !== '@forgeax/types') {
    throw new Error(`expected @forgeax/types tarball, received ${types.name ?? 'unknown package'}`);
  }
  if (agentRuntime.name !== '@forgeax/agent-runtime') {
    throw new Error(`expected @forgeax/agent-runtime tarball, received ${agentRuntime.name ?? 'unknown package'}`);
  }
  if (agentRuntime.version !== types.version || agentRuntime.dependencies?.['@forgeax/types'] !== types.version) {
    throw new Error('release tarballs are not a lockstep @forgeax/types -> @forgeax/agent-runtime pair');
  }
}

function packInstalledDependency(dependency, destination, npmCache) {
  const dependencyDirectory = resolve(repositoryRoot, 'types', 'node_modules', dependency);
  const output = run(
    'npm',
    [
      'pack',
      '--json',
      '--pack-destination',
      destination,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-update-notifier',
    ],
    dependencyDirectory,
    { ...process.env, npm_config_cache: npmCache },
  );
  const [{ filename }] = JSON.parse(output);
  return resolve(destination, filename);
}

function relativeFilesRecursively(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(directory, entry.name);
    return entry.isDirectory()
      ? relativeFilesRecursively(root, absolutePath)
      : [relative(root, absolutePath).replaceAll('\\', '/')];
  });
}

export function publicImportStatements(manifest, packageDirectory) {
  return Object.entries(manifest.exports).flatMap(([subpath, target]) => {
    const specifier = subpath === '.' ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
    if (target.endsWith('.js')) {
      return [`await import(${JSON.stringify(specifier)});`];
    }
    if (!target.includes('*')) return [];

    const directory = resolve(packageDirectory, target.replace(/\*$/u, ''));
    return relativeFilesRecursively(directory).map((file) => {
      const fileSpecifier = `${specifier.replace(/\*$/u, '')}${file}`;
      return file.endsWith('.json')
        ? `await import(${JSON.stringify(fileSpecifier)}, { with: { type: 'json' } });`
        : `await import(${JSON.stringify(fileSpecifier)});`;
    });
  });
}

export function acceptReleaseTarballs({ typesTarball, agentRuntimeTarball }) {
  const resolvedTypesTarball = resolve(typesTarball);
  const resolvedAgentRuntimeTarball = resolve(agentRuntimeTarball);
  assertReleasePair(resolvedTypesTarball, resolvedAgentRuntimeTarball);

  const acceptanceRoot = mkdtempSync(join(tmpdir(), 'forgeax-contracts-acceptance-'));
  const dependencyTarballs = join(acceptanceRoot, 'dependencies');
  const consumerDirectory = join(acceptanceRoot, 'consumer');
  const npmCache = join(acceptanceRoot, '.npm-cache');
  mkdirSync(dependencyTarballs);
  mkdirSync(consumerDirectory);

  try {
    const externalTarballs = ['zod', 'zod-to-json-schema'].map((dependency) =>
      packInstalledDependency(dependency, dependencyTarballs, npmCache));

    writeFileSync(
      join(consumerDirectory, 'package.json'),
      JSON.stringify({ name: 'contracts-tarball-consumer', private: true, type: 'module' }),
    );
    run(
      'npm',
      [
        'install',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--no-update-notifier',
        '--fetch-timeout=5000',
        '--fetch-retries=0',
        ...externalTarballs,
        resolvedTypesTarball,
        resolvedAgentRuntimeTarball,
      ],
      consumerDirectory,
      { ...process.env, npm_config_cache: npmCache },
    );

    const installedPackages = ['@forgeax/types', '@forgeax/agent-runtime'].map((packageName) => {
      const packageDirectory = join(consumerDirectory, 'node_modules', packageName);
      const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
      return { manifest, packageDirectory };
    });
    const importsToVerify = installedPackages.flatMap(({ manifest, packageDirectory }) =>
      publicImportStatements(manifest, packageDirectory));
    writeFileSync(join(consumerDirectory, 'verify-imports.mjs'), `${importsToVerify.join('\n')}\n`);
    run('node', ['verify-imports.mjs'], consumerDirectory);
  } finally {
    rmSync(acceptanceRoot, { force: true, recursive: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tarballs = parseArgs(process.argv.slice(2));
  acceptReleaseTarballs(tarballs);
  process.stdout.write('clean-room Node acceptance passed\n');
}
