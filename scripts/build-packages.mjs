import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDirectories = ['types', 'agent-runtime'];

function readManifest(packageDirectory) {
  return JSON.parse(readFileSync(resolve(packageDirectory, 'package.json'), 'utf8'));
}

function exportTargets(manifest) {
  return Object.values(manifest.exports).flatMap((value) =>
    typeof value === 'string' ? [value] : Object.values(value),
  );
}

function sourceEntrypoints(packageDirectory, manifest) {
  return exportTargets(manifest)
    .filter((target) => target.startsWith('./dist/') && target.endsWith('.js'))
    .map((target) => resolve(packageDirectory, target.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts')));
}

function run(command, args, cwd = repositoryRoot) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout || result.error?.message}`);
  }
}

function runTypeScript(args, cwd) {
  const localTypeScript = resolve(repositoryRoot, 'node_modules/.bin/tsc');
  if (existsSync(localTypeScript)) {
    run(localTypeScript, args, cwd);
    return;
  }
  run('bun', ['x', 'tsc', ...args], cwd);
}

function assertExportTargetsExist(packageDirectory, manifest) {
  for (const target of exportTargets(manifest)) {
    if (target.includes('*')) {
      const directory = resolve(packageDirectory, target.replace(/\*$/, ''));
      if (!existsSync(directory) || readdirSync(directory).length === 0) {
        throw new Error(`${manifest.name} export target ${target} is empty or missing`);
      }
      continue;
    }

    const modulePath = resolve(packageDirectory, target);
    if (!existsSync(modulePath)) {
      throw new Error(`${manifest.name} export target ${target} is missing`);
    }
    if (target.endsWith('.js') && !existsSync(modulePath.replace(/\.js$/, '.d.ts'))) {
      throw new Error(`${manifest.name} declaration for ${target} is missing`);
    }
  }
}

export function buildPackages() {
  for (const packageName of packageDirectories) {
    const packageDirectory = resolve(repositoryRoot, packageName);
    const manifest = readManifest(packageDirectory);
    const distDirectory = resolve(packageDirectory, 'dist');
    rmSync(distDirectory, { force: true, recursive: true });

    const entrypoints = sourceEntrypoints(packageDirectory, manifest);
    run('bun', [
      'build',
      ...entrypoints,
      '--outdir', distDirectory,
      '--root', resolve(packageDirectory, 'src'),
      '--target', 'node',
      '--format', 'esm',
      '--packages', 'external',
    ]);
    runTypeScript(['-p', 'tsconfig.build.json'], packageDirectory);
    assertExportTargetsExist(packageDirectory, manifest);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildPackages();
}
