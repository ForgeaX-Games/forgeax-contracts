import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  compareManifestPairs,
  discoverManifestCandidates,
  inspectCanonicalMarketplaceLayout,
  marketplaceManifestPairs,
  validateCandidate,
} from './validate-manifests';

const TMP = `/tmp/forgeax-validate-manifests-${process.pid}`;

function writeWorkbench(path: string, id: string, kind = 'workbench'): void {
  mkdirSync(path, { recursive: true });
  const manifest = kind === 'workbench'
    ? {
        schemaVersion: 1,
        id,
        version: '0.1.0',
        kind,
        displayName: id,
        provides: { workbench: { id } },
      }
    : {
        schemaVersion: 1,
        id,
        version: '0.1.0',
        kind: 'tool',
        displayName: id,
        provides: { tools: [{ id: `${id}.run` }] },
      };
  writeFileSync(join(path, 'forgeax-extension.json'), JSON.stringify(manifest));
}

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('manifest validation discovery', () => {
  it('discovers only legacy depth one and recognized canonical depth two', () => {
    writeWorkbench(join(TMP, 'legacy'), '@me/legacy');
    writeWorkbench(join(TMP, 'workbench'), '@me/bucket-root');
    writeWorkbench(join(TMP, 'workbench', 'canonical'), '@me/canonical');
    writeWorkbench(join(TMP, 'workbench', 'nested', 'too-deep'), '@me/too-deep');
    writeWorkbench(join(TMP, 'vendor', 'hidden'), '@me/hidden');

    expect(discoverManifestCandidates(TMP).map((c) => c.relativeManifestPath)).toEqual([
      'legacy/forgeax-extension.json',
      'workbench/canonical/forgeax-extension.json',
    ]);
  });

  it('reports canonical bucket/kind mismatch as a validation failure', () => {
    writeWorkbench(join(TMP, 'workbench', 'wrong'), '@me/wrong', 'tool');
    const [candidate] = discoverManifestCandidates(TMP);
    const finding = validateCandidate(candidate);

    expect(finding.ok).toBe(false);
    expect(finding.errors?.join('\n')).toContain(
      'bucket kind workbench does not match manifest kind tool',
    );
  });
});

describe('2026-07-14 Marketplace baseline', () => {
  it('treats a duplicate pair as an additional manifest', () => {
    const pair = { id: '@me/duplicate', kind: 'tool' };
    expect(compareManifestPairs([pair, pair], [pair])).toEqual({
      ok: false,
      missing: [],
      additional: [pair],
    });
  });

  it('matches the exact sorted 67 extension-layout (id, kind) pairs', () => {
    const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..');
    const fixturePath = join(
      import.meta.dirname,
      'fixtures',
      'marketplace-extension-kind-layout-baseline.json',
    );
    const expected = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Array<{
      id: string;
      kind: string;
    }>;
    const actual = marketplaceManifestPairs(
      join(repoRoot, 'packages', 'marketplace', 'extensions'),
    );

    expect(expected).toHaveLength(67);
    expect(actual).toHaveLength(67);
    expect(compareManifestPairs(actual, expected)).toEqual({
      ok: true,
      missing: [],
      additional: [],
    });
  });

  it('requires every bundled L0 manifest under extensions/<kind>/<slug>/ with node-editor in vendor/', () => {
    const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..');
    const fixturePath = join(
      import.meta.dirname,
      'fixtures',
      'marketplace-extension-kind-layout-baseline.json',
    );
    const expected = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Array<{
      id: string;
      kind: string;
    }>;
    const report = inspectCanonicalMarketplaceLayout(
      join(repoRoot, 'packages', 'marketplace', 'extensions'),
      expected,
    );

    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.legacyRelativePaths).toEqual([]);
    expect(report.flatManifestDirs).toEqual([]);
    expect(report.nonKindRootEntries).toEqual([]);
    expect(report.nodeEditorUnderPlugins).toBe(false);
    expect(report.nodeEditorUnderVendor).toBe(true);
    expect(report.pairs).toHaveLength(67);
  });

  it('keeps workbench first-party file dependencies resolvable after the kind-layout move', () => {
    const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..');
    const marketplaceRoot = join(repoRoot, 'packages', 'marketplace');
    const expectedSpecifier = 'file:../../../shared/external-asset-meta';

    for (const slug of ['wb-ai-asset', 'wb-gen3d']) {
      const packagePath = join(
        marketplaceRoot,
        'extensions',
        'workbench',
        slug,
        'package.json',
      );
      const pkg = JSON.parse(readFileSync(packagePath, 'utf-8')) as {
        dependencies: Record<string, string>;
      };
      const specifier = pkg.dependencies['@forgeax-extension/external-asset-meta'];
      const target = resolve(dirname(packagePath), specifier.replace(/^file:/u, ''));

      expect(specifier).toBe(expectedSpecifier);
      expect(target).toBe(join(marketplaceRoot, 'shared', 'external-asset-meta'));
      expect(existsSync(join(target, 'package.json'))).toBe(true);
    }
  });
});
