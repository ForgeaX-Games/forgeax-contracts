/**
 * Phase A1 验收 / 回归测试.
 *
 * 跑过 packages/marketplace/extensions/* /forgeax-extension.json + 任何 ~/.forgeax/extensions/
 * 下的玩家自造 plugin。所有真实 manifest 必须 pass；任何失败都 print 详细 path。
 *
 * 用法：bun test/validate-manifests.ts
 *      （也作为 PR-CI 的 lint 步骤接入）
 */
import { lstatSync, readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  ManifestSchema,
  parseManifest,
  type ManifestKind,
  type ExtensionManifest,
} from '../src/manifest';
import {
  PLUGIN_MANIFEST_KINDS,
  classifyPluginManifestRelativePath,
  isPluginManifestKind,
  normalizePluginRelativePath,
} from '../src/plugin-layout';

/** 2026-07-14 migration baseline kind counts (identity gate, not a living census). */
export const MARKETPLACE_KIND_LAYOUT_BASELINE_COUNTS: Record<ManifestKind, number> = {
  agent: 34,
  workbench: 24,
  'cli-provider': 4,
  skill: 2,
  tool: 2,
  'model-binding': 1,
};

export interface ManifestCandidate {
  path: string;
  relativeManifestPath: string;
  layout: 'legacy' | 'canonical';
  bucketKind?: ManifestKind;
}

export interface Finding {
  path: string;
  ok: boolean;
  errors?: string[];
  warnings?: string[];
  manifest?: ExtensionManifest;
}

function findRepoRoot(start: string): string {
  let cur = start;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(cur, 'AGENTS.md')) && existsSync(join(cur, 'packages'))) return cur;
    const parent = resolve(cur, '..');
    if (parent === cur) break;
    cur = parent;
  }
  return start;
}

function posixRelative(root: string, path: string): string {
  return normalizePluginRelativePath(relative(root, path)) ?? relative(root, path).split(/[\\/]/u).join('/');
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function discoverManifestCandidates(layerRoot: string): ManifestCandidate[] {
  // Validation intentionally enumerates existing manifests before parsing so
  // malformed files become findings. Runtime adds IO diagnostics; build
  // discovery skips invalid JSON. Relative shape is shared in plugin-layout.
  if (!existsSync(layerRoot)) return [];
  let entries: string[];
  try {
    entries = readdirSync(layerRoot);
  } catch {
    return [];
  }

  const out: ManifestCandidate[] = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    // Keep this test-only validator aligned with the CLI scanner without
    // introducing an upward contracts → cli package dependency.
    if (isPluginManifestKind(name)) continue;
    const pluginDir = join(layerRoot, name);
    if (!isDirectory(pluginDir)) continue;
    const path = join(pluginDir, 'forgeax-extension.json');
    if (existsSync(path)) {
      const classified = classifyPluginManifestRelativePath(posixRelative(layerRoot, path));
      if (!classified || classified.layout !== 'legacy') continue;
      out.push({
        path,
        relativeManifestPath: classified.relativeManifestPath,
        layout: 'legacy',
      });
    }
  }
  for (const bucketKind of PLUGIN_MANIFEST_KINDS) {
    const bucketDir = join(layerRoot, bucketKind);
    if (!isDirectory(bucketDir)) continue;
    let children: string[];
    try {
      children = readdirSync(bucketDir);
    } catch {
      continue;
    }
    for (const name of children) {
      if (name.startsWith('.')) continue;
      const pluginDir = join(bucketDir, name);
      if (!isDirectory(pluginDir)) continue;
      const path = join(pluginDir, 'forgeax-extension.json');
      if (!existsSync(path)) continue;
      const classified = classifyPluginManifestRelativePath(posixRelative(layerRoot, path));
      if (!classified || classified.layout !== 'canonical') continue;
      out.push({
        path,
        relativeManifestPath: classified.relativeManifestPath,
        layout: 'canonical',
        bucketKind: classified.bucketKind,
      });
    }
  }
  return out.sort((a, b) =>
    a.relativeManifestPath < b.relativeManifestPath
      ? -1
      : a.relativeManifestPath > b.relativeManifestPath
        ? 1
        : 0,
  );
}

function manifestRoots(repoRoot: string): string[] {
  const roots = [join(repoRoot, 'packages/marketplace/extensions')];
  if (process.env.HOME) roots.push(join(process.env.HOME, '.forgeax/extensions'));
  return roots;
}

function listManifests(root: string): string[] {
  return manifestRoots(root).flatMap((dir) =>
    discoverManifestCandidates(dir).map((candidate) => candidate.path),
  );
}

function formatZodIssue(prefix: string, issue: unknown): string {
  if (!issue || typeof issue !== 'object') return `${prefix}: ${String(issue)}`;
  const { path, message, code } = issue as { path?: unknown[]; message?: string; code?: string };
  const where = Array.isArray(path) && path.length ? path.join('.') : '<root>';
  return `${prefix} [${code}] @ ${where}: ${message}`;
}

export function validateCandidate(candidate: ManifestCandidate): Finding {
  const file = candidate.path;
  let raw: string;
  try { raw = readFileSync(file, 'utf-8'); } catch (e) {
    return { path: file, ok: false, errors: [`read failed: ${(e as Error).message}`] };
  }
  let json: unknown;
  try { json = JSON.parse(raw); } catch (e) {
    return { path: file, ok: false, errors: [`invalid JSON: ${(e as Error).message}`] };
  }
  const r = parseManifest(json);
  if (!r.ok) {
    return {
      path: file,
      ok: false,
      errors: r.error?.issues.map((i) => formatZodIssue('zod', i)) ?? ['unknown zod failure'],
      warnings: r.warnings,
    };
  }
  if (
    candidate.layout === 'canonical' &&
    candidate.bucketKind !== r.manifest?.kind
  ) {
    return {
      path: file,
      ok: false,
      errors: [
        `bucket kind ${candidate.bucketKind} does not match manifest kind ${r.manifest?.kind}`,
      ],
      manifest: r.manifest,
      warnings: r.warnings,
    };
  }
  return { path: file, ok: true, manifest: r.manifest, warnings: r.warnings };
}

function validate(file: string): Finding {
  return validateCandidate({
    path: file,
    relativeManifestPath: file.split(/[\\/]/u).pop() ?? file,
    layout: 'legacy',
  });
}

export interface ManifestPair {
  id: string;
  kind: string;
}

function sortPairs(pairs: ManifestPair[]): ManifestPair[] {
  return [...pairs].sort((a, b) => {
    const left = `${a.id}\0${a.kind}`;
    const right = `${b.id}\0${b.kind}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export function marketplaceManifestPairs(layerRoot: string): ManifestPair[] {
  return sortPairs(
    discoverManifestCandidates(layerRoot)
      .map(validateCandidate)
      .filter((finding): finding is Finding & { manifest: ExtensionManifest } =>
        finding.ok && finding.manifest !== undefined)
      .map((finding) => ({
        id: finding.manifest.id,
        kind: finding.manifest.kind,
      })),
  );
}

export function compareManifestPairs(
  actual: ManifestPair[],
  expected: ManifestPair[],
): {
  ok: boolean;
  missing: ManifestPair[];
  additional: ManifestPair[];
} {
  const keyOf = (pair: ManifestPair) => `${pair.id}\0${pair.kind}`;
  const expectedCounts = new Map<string, number>();
  for (const pair of expected) {
    const key = keyOf(pair);
    expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
  }
  const additional: ManifestPair[] = [];
  for (const pair of actual) {
    const key = keyOf(pair);
    const remaining = expectedCounts.get(key) ?? 0;
    if (remaining === 0) additional.push(pair);
    else expectedCounts.set(key, remaining - 1);
  }
  const missing: ManifestPair[] = [];
  for (const pair of expected) {
    const key = keyOf(pair);
    const remaining = expectedCounts.get(key) ?? 0;
    if (remaining === 0) continue;
    missing.push(pair);
    expectedCounts.set(key, remaining - 1);
  }
  const sortedMissing = sortPairs(missing);
  const sortedAdditional = sortPairs(additional);
  return {
    ok: sortedMissing.length === 0 && sortedAdditional.length === 0,
    missing: sortedMissing,
    additional: sortedAdditional,
  };
}

export interface CanonicalMarketplaceLayoutReport {
  ok: boolean;
  errors: string[];
  pairs: ManifestPair[];
  kindCounts: Record<string, number>;
  legacyRelativePaths: string[];
  flatManifestDirs: string[];
  nonKindRootEntries: string[];
  nodeEditorUnderPlugins: boolean;
  nodeEditorUnderVendor: boolean;
}

/**
 * Post-migration inventory gate: every bundled L0 manifest must live at
 * `plugins/<manifest.kind>/<slug>/forgeax-extension.json`, the pre-move
 * `(id, kind)` set must be preserved, and node-editor must sit under vendor/.
 */
export function inspectCanonicalMarketplaceLayout(
  pluginsRoot: string,
  expectedPairs: ManifestPair[],
): CanonicalMarketplaceLayoutReport {
  const marketplaceRoot = dirname(pluginsRoot);
  const errors: string[] = [];
  const candidates = discoverManifestCandidates(pluginsRoot);
  const findings = candidates.map(validateCandidate);
  const pairs = sortPairs(
    findings
      .filter((finding): finding is Finding & { manifest: ExtensionManifest } =>
        finding.ok && finding.manifest !== undefined)
      .map((finding) => ({
        id: finding.manifest.id,
        kind: finding.manifest.kind,
      })),
  );
  const legacyRelativePaths = candidates
    .filter((candidate) => candidate.layout === 'legacy')
    .map((candidate) => candidate.relativeManifestPath)
    .sort();
  const flatManifestDirs: string[] = [];
  const nonKindRootEntries: string[] = [];
  if (existsSync(pluginsRoot)) {
    for (const name of readdirSync(pluginsRoot)) {
      const entryPath = join(pluginsRoot, name);
      if (isPluginManifestKind(name)) {
        if (!isDirectory(entryPath)) {
          errors.push(`plugin kind bucket is not a directory: ${name}`);
        }
        continue;
      }
      nonKindRootEntries.push(name);
      try {
        const st = lstatSync(entryPath);
        if (!st.isDirectory() && !st.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      if (existsSync(join(entryPath, 'forgeax-extension.json'))) {
        flatManifestDirs.push(name);
      }
    }
    flatManifestDirs.sort();
    nonKindRootEntries.sort();
  }

  for (const candidate of candidates) {
    if (candidate.layout !== 'canonical') {
      errors.push(`legacy inventory path: ${candidate.relativeManifestPath}`);
      continue;
    }
    const finding = validateCandidate(candidate);
    if (!finding.ok || !finding.manifest) {
      errors.push(
        `invalid canonical candidate ${candidate.relativeManifestPath}: ${
          finding.errors?.join('; ') ?? 'unknown'
        }`,
      );
      continue;
    }
    const expectedPath = `${finding.manifest.kind}/${candidate.relativeManifestPath.split('/')[1]}/forgeax-extension.json`;
    if (candidate.relativeManifestPath !== expectedPath) {
      errors.push(
        `canonical path mismatch for ${finding.manifest.id}: got ${candidate.relativeManifestPath}, want ${expectedPath}`,
      );
    }
    if (candidate.bucketKind !== finding.manifest.kind) {
      errors.push(
        `bucket/kind mismatch for ${finding.manifest.id}: bucket=${candidate.bucketKind} kind=${finding.manifest.kind}`,
      );
    }
  }

  if (flatManifestDirs.length) {
    errors.push(`flat manifest plugin dirs remain: ${flatManifestDirs.join(', ')}`);
  }
  if (nonKindRootEntries.length) {
    errors.push(
      `plugins/ direct children must be the six kind buckets; found: ${nonKindRootEntries.join(', ')}`,
    );
  }
  if (legacyRelativePaths.length) {
    errors.push(`legacy candidates remain (${legacyRelativePaths.length})`);
  }

  const pairDiff = compareManifestPairs(pairs, expectedPairs);
  if (!pairDiff.ok) {
    for (const pair of pairDiff.missing) {
      errors.push(`missing baseline pair: ${pair.id} (${pair.kind})`);
    }
    for (const pair of pairDiff.additional) {
      errors.push(`additional inventory pair: ${pair.id} (${pair.kind})`);
    }
  }

  const uniqueIds = new Set(pairs.map((pair) => pair.id));
  if (uniqueIds.size !== 67 || pairs.length !== 67) {
    errors.push(
      `expected 67 unique manifest IDs, got ${uniqueIds.size} unique / ${pairs.length} pairs`,
    );
  }

  const kindCounts: Record<string, number> = {};
  for (const pair of pairs) {
    kindCounts[pair.kind] = (kindCounts[pair.kind] ?? 0) + 1;
  }
  for (const kind of PLUGIN_MANIFEST_KINDS) {
    const expected = MARKETPLACE_KIND_LAYOUT_BASELINE_COUNTS[kind];
    const actual = kindCounts[kind] ?? 0;
    if (actual !== expected) {
      errors.push(`kind count for ${kind}: got ${actual}, want ${expected}`);
    }
  }

  const nodeEditorUnderPlugins = existsSync(join(pluginsRoot, 'node-editor'));
  const nodeEditorUnderVendor = existsSync(join(marketplaceRoot, 'vendor', 'node-editor'));
  if (nodeEditorUnderPlugins) {
    errors.push('node-editor still lives under plugins/');
  }
  if (!nodeEditorUnderVendor) {
    errors.push('node-editor missing from vendor/node-editor');
  }

  return {
    ok: errors.length === 0,
    errors,
    pairs,
    kindCounts,
    legacyRelativePaths,
    flatManifestDirs,
    nonKindRootEntries,
    nodeEditorUnderPlugins,
    nodeEditorUnderVendor,
  };
}

function main(): number {
  const root = findRepoRoot(process.cwd());
  const roots = manifestRoots(root);
  const candidates = roots.flatMap(discoverManifestCandidates);
  if (!candidates.length) {
    console.error('no manifest files found under', root);
    return 2;
  }
  console.log(`# Validating ${candidates.length} manifest(s) under ${root}\n`);

  const findings = candidates.map(validateCandidate);
  const failed = findings.filter((f) => !f.ok);
  const passed = findings.filter((f) => f.ok);

  for (const f of passed) {
    const id = f.manifest?.id ?? '?';
    const kind = f.manifest?.kind ?? '?';
    const warn = f.warnings?.length ? ` (warnings: ${f.warnings.length})` : '';
    console.log(`  ok  ${id.padEnd(40)} ${kind.padEnd(14)} ${f.path}${warn}`);
  }

  if (failed.length) {
    console.log('\n# Failures');
    for (const f of failed) {
      console.log(`\n  ❌ ${f.path}`);
      for (const e of f.errors ?? []) console.log(`     ${e}`);
    }
  }

  const marketplaceExtensionsRoot = join(root, 'packages/marketplace/extensions');
  const fixturePath = join(
    import.meta.dirname,
    'fixtures',
    'marketplace-extension-kind-layout-baseline.json',
  );
  let baselineFailed = false;
  if (existsSync(fixturePath)) {
    const expected = JSON.parse(readFileSync(fixturePath, 'utf-8')) as ManifestPair[];
    const layout = inspectCanonicalMarketplaceLayout(marketplaceExtensionsRoot, expected);
    baselineFailed = !layout.ok;
    if (!layout.ok) {
      console.log('\n# Marketplace canonical layout inventory failed');
      for (const error of layout.errors) console.log(`  ${error}`);
    }
  } else {
    console.log(`\n# Missing Marketplace baseline fixture: ${fixturePath}`);
    baselineFailed = true;
  }

  console.log(`\n# Summary: ${passed.length}/${findings.length} ok, ${failed.length} failed`);
  return failed.length === 0 && !baselineFailed ? 0 : 1;
}

if (import.meta.main) {
  process.exit(main());
}

// Re-export for unit tests (bun test consumers)
export { validate, listManifests, findRepoRoot, ManifestSchema };
