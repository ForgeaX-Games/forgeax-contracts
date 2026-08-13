import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { publicImportStatements } from '../scripts/accept-release-tarballs.mjs';
import {
  assertPackedManifestIsPublishable,
  assertTarballEntriesAreClean,
} from '../scripts/pack-packages.mjs';

type PackageManifest = {
  name: string;
  version: string;
  private?: boolean;
  main?: string;
  exports: Record<string, string>;
  files?: string[];
  dependencies?: Record<string, string>;
  publishConfig?: { access?: string };
  scripts?: Record<string, string>;
};

function readManifest(relativePath: string): PackageManifest {
  return JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), 'utf8'),
  ) as PackageManifest;
}

function allBuiltExportTargets(...manifests: PackageManifest[]): string[] {
  return manifests.flatMap((manifest) =>
    Object.entries(manifest.exports)
      .filter(([exportPath]) => !exportPath.startsWith('./schemas/'))
      .map(([, target]) => target),
  );
}

const repositoryRoot = resolve(new URL('..', import.meta.url).pathname);

function run(
  command: string,
  args: string[],
  cwd = repositoryRoot,
  env = process.env,
  timeout = 15_000,
) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env,
    timeout,
  });

  return {
    exitCode: result.status ?? 1,
    stderr: result.stderr ?? result.error?.message ?? '',
    stdout: result.stdout ?? '',
  };
}

function assertTarballIsClean(tarball: string) {
  const listing = run('tar', ['-tzf', tarball]);
  expect(listing.exitCode).toBe(0);

  const entries = listing.stdout.trim().split('\n').filter(Boolean);
  expect(() => assertTarballEntriesAreClean(entries, tarball)).not.toThrow();
}

function sourceDeclarations(packageDirectory: string) {
  return readdirSync(join(packageDirectory, 'src'), { recursive: true })
    .map(String)
    .filter((entry) => entry.endsWith('.d.ts'));
}

type WorkflowStep = {
  name?: string;
  uses?: string;
  id?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  'continue-on-error'?: boolean;
};

type WorkflowDefinition = {
  on: Record<string, unknown>;
  jobs: Record<string, { needs?: string; steps: WorkflowStep[] }>;
};

function readWorkflow(name: string): WorkflowDefinition {
  return Bun.YAML.parse(
    readFileSync(join(repositoryRoot, '.github', 'workflows', name), 'utf8'),
  ) as WorkflowDefinition;
}

function workflowSteps(workflow: WorkflowDefinition, job: string): WorkflowStep[] {
  const steps = workflow.jobs[job]?.steps;
  expect(steps, `missing workflow job: ${job}`).toBeArray();
  return steps;
}

function namedStep(steps: WorkflowStep[], name: string): WorkflowStep {
  const step = steps.find((candidate) => candidate.name === name);
  expect(step, `missing workflow step: ${name}`).toBeDefined();
  return step as WorkflowStep;
}

function indexOfStep(steps: WorkflowStep[], name: string) {
  const index = steps.findIndex((candidate) => candidate.name === name);
  expect(index, `missing workflow step: ${name}`).toBeGreaterThanOrEqual(0);
  return index;
}

function indexOfUse(steps: WorkflowStep[], action: string) {
  const index = steps.findIndex((candidate) => candidate.uses === action);
  expect(index, `missing workflow action: ${action}`).toBeGreaterThanOrEqual(0);
  return index;
}

test('publishes lockstep built contracts', () => {
  const root = readManifest('../package.json');
  const types = readManifest('../types/package.json');
  const runtime = readManifest('../agent-runtime/package.json');

  expect(types.name).toBe('@forgeax/types');
  expect(runtime.name).toBe('@forgeax/agent-runtime');
  expect(types.private).not.toBe(true);
  expect(runtime.private).not.toBe(true);
  expect(types.publishConfig?.access).toBe('public');
  expect(runtime.publishConfig?.access).toBe('public');
  expect(types.version).toBe('0.1.1');
  expect(runtime.version).toBe(types.version);
  expect(runtime.dependencies?.['@forgeax/types']).toBe(types.version);

  for (const manifest of [types, runtime]) {
    expect(manifest.main).toMatch(/^\.\/dist\/.*\.js$/);
    expect(manifest.files).toContain('dist');
    expect(manifest.files?.every((file) => ['dist', 'schemas', 'README.md'].includes(file))).toBe(true);
  }

  expect(types.files).toContain('schemas');
  for (const target of allBuiltExportTargets(types, runtime)) {
    expect(target).toMatch(/^\.\/dist\/.*\.(?:js|d\.ts)$/);
    expect(target).not.toContain('/src/');
  }

  expect(root.scripts).toMatchObject({
    'accept:tarballs': 'node scripts/accept-release-tarballs.mjs',
    build: 'node scripts/build-packages.mjs',
    'check:publish-contract': 'bun test test/npm-publish-contract.test.ts',
    'pack:all': 'node scripts/pack-packages.mjs',
  });
});

test('@forgeax/types does not depend on @forgeax/agent-runtime', () => {
  const types = readManifest('../types/package.json');

  expect(types.dependencies?.['@forgeax/agent-runtime']).toBeUndefined();
});

test('published manifests contain no local protocols or parent paths', () => {
  const types = readManifest('../types/package.json');
  const runtime = readManifest('../agent-runtime/package.json');

  expect(JSON.stringify([types, runtime])).not.toMatch(
    /workspace:|file:|link:|\.\.\//,
  );
});

test('packed manifest validator rejects local protocols and parent paths', () => {
  const invalidManifests = [
    { dependencies: { local: 'workspace:*' } },
    { dependencies: { local: 'file:../local' } },
    { dependencies: { local: 'link:../local' } },
    { dependencies: { local: '../local' } },
  ];

  for (const manifest of invalidManifests) {
    expect(() => assertPackedManifestIsPublishable(JSON.stringify(manifest), 'fixture.tgz')).toThrow(
      /fixture\.tgz contains a local dependency reference/,
    );
  }
});

test('tarball entry validator rejects private and non-portable archive paths', () => {
  const invalidEntries = [
    'package/config/.env.local',
    'package/src/index.ts',
    'package/test/fixture.js',
    'package/tests/fixture.js',
    'package/bun.lock',
    'package/bun.lockb',
    'package/package-lock.json',
    'package/npm-shrinkwrap.json',
    'package/yarn.lock',
    'package/pnpm-lock.yaml',
    '/absolute/secret.txt',
    String.raw`C:\absolute\secret.txt`,
    String.raw`\\server\share\secret.txt`,
  ];

  for (const entry of invalidEntries) {
    expect(() => assertTarballEntriesAreClean([entry], 'fixture.tgz')).toThrow(
      /fixture\.tgz contains unsafe archive entry/,
    );
  }
});

test('wildcard imports recursively include nested JSON targets with import attributes', () => {
  const packageDirectory = mkdtempSync(join(tmpdir(), 'forgeax-contracts-wildcard-'));
  try {
    const nestedDirectory = join(packageDirectory, 'schemas', 'nested');
    mkdirSync(nestedDirectory, { recursive: true });
    writeFileSync(join(nestedDirectory, 'fixture.schema.json'), '{}');

    const statements = publicImportStatements({
      name: '@fixture/contracts',
      version: '1.0.0',
      exports: { './schemas/*': './schemas/*' },
    }, packageDirectory);

    expect(statements).toEqual([
      `await import("@fixture/contracts/schemas/nested/fixture.schema.json", { with: { type: 'json' } });`,
    ]);
  } finally {
    rmSync(packageDirectory, { force: true, recursive: true });
  }
});

test('clean-room acceptance requires exactly two explicit release tarballs', () => {
  const missing = run('node', ['scripts/accept-release-tarballs.mjs']);
  expect(missing.exitCode).not.toBe(0);
  expect(missing.stderr).toContain(
    'usage: node scripts/accept-release-tarballs.mjs --types <tarball> --agent-runtime <tarball>',
  );

  const extra = run('node', [
    'scripts/accept-release-tarballs.mjs',
    '--types',
    'types.tgz',
    '--agent-runtime',
    'runtime.tgz',
    '--unexpected',
  ]);
  expect(extra.exitCode).not.toBe(0);
  expect(extra.stderr).toContain(
    'usage: node scripts/accept-release-tarballs.mjs --types <tarball> --agent-runtime <tarball>',
  );
});

test('built tarballs contain every declared module and load with plain Node', { timeout: 30_000 }, () => {
  const manifests = [readManifest('../types/package.json'), readManifest('../agent-runtime/package.json')];
  const build = run('node', ['scripts/build-packages.mjs']);
  expect(build.exitCode, build.stderr).toBe(0);

  for (const manifest of manifests) {
    const packageDirectory = join(repositoryRoot, basename(manifest.name));
    expect(sourceDeclarations(packageDirectory)).toEqual([]);
    for (const target of allBuiltExportTargets(manifest)) {
      if (target.includes('*')) {
        const schemaDirectory = resolve(packageDirectory, target.replace(/\*$/, ''));
        expect(readdirSync(schemaDirectory).length).toBeGreaterThan(0);
        continue;
      }

      const modulePath = resolve(packageDirectory, target);
      expect(relative(packageDirectory, modulePath).startsWith('..')).toBe(false);
      expect(existsSync(modulePath)).toBe(true);
      expect(existsSync(modulePath.replace(/\.js$/, '.d.ts'))).toBe(true);
    }
  }

  const destination = mkdtempSync(join(tmpdir(), 'forgeax-contracts-pack-'));
  try {
    const pack = run('node', ['scripts/pack-packages.mjs', '--destination', destination]);
    expect(pack.exitCode, pack.stderr).toBe(0);

    const tarballs = JSON.parse(pack.stdout) as { tarballs: string[] };
    expect(tarballs.tarballs).toHaveLength(2);
    for (const tarball of tarballs.tarballs) {
      expect(tarball).toStartWith(destination);
      expect(tarball).toEndWith('.tgz');
      assertTarballIsClean(tarball);
    }

    const acceptance = run(
      'node',
      [
        'scripts/accept-release-tarballs.mjs',
        '--types',
        tarballs.tarballs[0],
        '--agent-runtime',
        tarballs.tarballs[1],
      ],
      repositoryRoot,
      process.env,
      30_000,
    );
    expect(acceptance.exitCode, acceptance.stderr).toBe(0);
    expect(acceptance.stdout).toContain('clean-room Node acceptance passed');
  } finally {
    rmSync(destination, { force: true, recursive: true });
  }
});

test('canonical release scanner files match their SHA-256 baseline', () => {
  const expectedDigests = new Map([
    ['scripts/check-release-secrets.mjs', '7dfd1dcd524e2010feccdb2d8c3612b35c0e90e0f9f31e42c347bf53a2c38f34'],
    ['scripts/check-release-secrets.test.mjs', '6606fa164929734141f6d9e46228824ecc32848cd746b8f849fee660e65fe432'],
    ['scripts/run-trufflehog-release-scan.sh', '9f38efbdc686657310d12fad304cac09b5398d918eaeec1b0be0ba784664bc89'],
    ['scripts/run-trufflehog-release-scan.test.mjs', '4a1a4abbdec4791a5839c9e466d892154cbd368e6bf267c06eddf5952a096160'],
    ['scripts/verify-release-artifact.py', '916e565aa2ea8e7de7619c0081a043dca5eb588f5d8d9f2bfe755624ca78fb3f'],
    ['scripts/verify-release-artifact.test.py', '891d128928e341e5eaa1dd3607c57a0bb4fd4b1c02f6f316017e19d5110ea47f'],
  ]);

  for (const [path, expected] of expectedDigests) {
    const actual = createHash('sha256').update(readFileSync(join(repositoryRoot, path))).digest('hex');
    expect(actual, path).toBe(expected);
  }
});

test('release workflows gate and publish the exact scanned tarballs in dependency order', () => {
  const ci = readWorkflow('ci.yml');
  const ciSteps = workflowSteps(ci, 'verify');

  expect(Object.keys(ci.on)).toEqual(['pull_request', 'push']);
  expect(ci.on).toEqual({ pull_request: null, push: { branches: ['main'] } });
  expect(JSON.stringify(ci)).not.toMatch(/(?:NPM_TOKEN|NODE_AUTH_TOKEN)/u);
  expect(JSON.stringify(ci)).not.toMatch(/forgeax-studio|studio\//iu);
  expect(JSON.stringify(ci)).not.toContain('continue-on-error');
  const ciSourceScan = namedStep(ciSteps, 'TruffleHog source scan');
  expect(ciSourceScan.run).toBe('./scripts/run-trufflehog-release-scan.sh --mode source --path "$GITHUB_WORKSPACE"');
  expect(indexOfStep(ciSteps, 'TruffleHog source scan')).toBeLessThan(indexOfUse(ciSteps, 'oven-sh/setup-bun@v2'));
  expect(indexOfStep(ciSteps, 'TruffleHog source scan')).toBeLessThan(indexOfStep(ciSteps, 'Install dependencies'));
  expect(indexOfStep(ciSteps, 'TruffleHog source scan')).toBeLessThan(indexOfStep(ciSteps, 'Build packages'));
  expect(namedStep(ciSteps, 'Install dependencies').run).toContain('bun install --frozen-lockfile');
  expect(namedStep(ciSteps, 'Release scanner unit tests').run).toContain(
    'node --test scripts/check-release-secrets.test.mjs',
  );
  expect(namedStep(ciSteps, 'Release scanner unit tests').run).toContain(
    'scripts/run-trufflehog-release-scan.test.mjs',
  );
  expect(namedStep(ciSteps, 'Release workflow contract').run).toBe(
    "bun test test/npm-publish-contract.test.ts --test-name-pattern 'canonical release scanner|release workflows'",
  );
  expect(namedStep(ciSteps, 'Lint').run).toContain('bun run lint');
  expect(namedStep(ciSteps, 'Typecheck').run).toContain('bun run typecheck');
  expect(namedStep(ciSteps, 'Package tests').run).toContain('bun run test');
  expect(namedStep(ciSteps, 'Build packages').run).toContain('bun run build');

  const ciPack = namedStep(ciSteps, 'Pack release tarballs');
  expect(ciPack.id).toBe('pack');
  expect(ciPack.run).toContain('node scripts/pack-packages.mjs --destination');
  expect(ciPack.run).toContain('types_tarball=');
  expect(ciPack.run).toContain('agent_runtime_tarball=');
  expect(ciSteps.filter((step) => step.run?.includes('scripts/pack-packages.mjs'))).toHaveLength(1);

  const ciScan = namedStep(ciSteps, 'Scan packed tarballs');
  const ciAcceptance = namedStep(ciSteps, 'Clean-room Node acceptance');
  for (const output of ['types_tarball', 'agent_runtime_tarball']) {
    expect(ciScan.run).toContain(`tar -xzf "\${{ steps.pack.outputs.${output} }}"`);
  }
  expect(ciScan.run).toContain('node scripts/check-release-secrets.mjs --mode package --path');
  expect(ciScan.run).toContain('scripts/run-trufflehog-release-scan.sh');
  expect(ciAcceptance.run).toContain('node scripts/accept-release-tarballs.mjs');
  expect(ciAcceptance.run).toContain('--types "${{ steps.pack.outputs.types_tarball }}"');
  expect(ciAcceptance.run).toContain('--agent-runtime "${{ steps.pack.outputs.agent_runtime_tarball }}"');
  expect(ciAcceptance.run).not.toContain('check:publish-contract');
  expect(indexOfStep(ciSteps, 'Pack release tarballs')).toBeLessThan(
    indexOfStep(ciSteps, 'Scan packed tarballs'),
  );
  expect(indexOfStep(ciSteps, 'Scan packed tarballs')).toBeLessThan(
    indexOfStep(ciSteps, 'Clean-room Node acceptance'),
  );

  const publish = readWorkflow('publish.yml');
  expect(Object.keys(publish.on)).toEqual(['push', 'workflow_dispatch']);
  expect(publish.on).toEqual({ push: { tags: ['v*'] }, workflow_dispatch: null });
  expect(JSON.stringify(publish)).not.toMatch(/forgeax-studio|studio\//iu);
  expect(JSON.stringify(publish)).not.toContain('continue-on-error');
  expect(Object.keys(publish.jobs)).toEqual(['build', 'scan', 'publish']);
  const buildSteps = workflowSteps(publish, 'build');
  const scanSteps = workflowSteps(publish, 'scan');
  const publishSteps = workflowSteps(publish, 'publish');
  expect(publish.jobs.scan.needs).toBe('build');
  expect(publish.jobs.publish.needs).toBe('scan');

  const tagVersion = namedStep(buildSteps, 'Verify tag matches package versions');
  expect(tagVersion.if).toBe("github.event_name == 'push'");
  expect(tagVersion.run).toContain('types/package.json');
  expect(tagVersion.run).toContain('agent-runtime/package.json');
  expect(tagVersion.run).toContain('test "$expected" = "$types"');
  expect(tagVersion.run).toContain('test "$expected" = "$agent_runtime"');

  expect(indexOfStep(buildSteps, 'TruffleHog source scan')).toBeLessThan(
    indexOfStep(buildSteps, 'Install frozen dependencies after source scans'),
  );
  expect(namedStep(buildSteps, 'Pack both release tarballs exactly once').run).toContain(
    'node scripts/pack-packages.mjs --destination',
  );
  expect(buildSteps.filter((step) => step.run?.includes('scripts/pack-packages.mjs'))).toHaveLength(1);
  expect(namedStep(scanSteps, 'Deterministic package scans without exclusions').run).toContain('--mode package');
  expect(namedStep(scanSteps, 'TruffleHog package scans without exclusions').run).toContain('--mode package');
  expect(publishSteps.some((step) => step.uses?.startsWith('actions/checkout@'))).toBeFalse();
  const finalPublish = namedStep(publishSteps, 'Publish scanned contract packages');
  expect(finalPublish.run).toContain('npm publish "$types_tarball"');
  expect(finalPublish.run).toContain('npm publish "$agent_runtime_tarball"');
  expect(finalPublish.run.indexOf('$types_tarball')).toBeLessThan(finalPublish.run.indexOf('$agent_runtime_tarball'));
  expect(finalPublish.env).toEqual({ NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}' });
  expect(publishSteps.filter((step) => step.env?.NODE_AUTH_TOKEN)).toHaveLength(1);
});
