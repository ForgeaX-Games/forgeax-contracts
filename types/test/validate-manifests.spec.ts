/**
 * Focused regression for flat Marketplace extension discovery + validation.
 * Layout: packages/marketplace/extensions/<slug>/forgeax-extension.json
 * User:   ~/.forgeax/extensions/<slug>/forgeax-extension.json
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listManifests, validate } from './validate-manifests';

const TMP = `/tmp/forgeax-validate-manifests-flat-${process.pid}`;

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('listManifests · flat extension layout', () => {
  it('discovers flat forgeax-extension.json files without a Studio checkout', () => {
    mkdirSync(join(TMP, 'packages', 'marketplace', 'extensions', 'admin'), { recursive: true });
    mkdirSync(join(TMP, 'packages', 'marketplace', 'extensions', 'wb-demo'), { recursive: true });
    for (const [slug, id] of [['admin', '@forgeax-extension/admin'], ['wb-demo', '@forgeax-extension/wb-demo']]) {
      writeFileSync(
        join(TMP, 'packages', 'marketplace', 'extensions', slug, 'forgeax-extension.json'),
        JSON.stringify({
          schemaVersion: 1,
          id,
          version: '0.1.0',
          kind: 'workbench',
          displayName: slug,
          provides: { workbench: { id: slug } },
        }),
      );
    }

    const files = listManifests(TMP).filter((file) =>
      file.startsWith(join(TMP, 'packages/marketplace/extensions'))
    );

    expect(files.sort()).toEqual([
      join(TMP, 'packages/marketplace/extensions/admin/forgeax-extension.json'),
      join(TMP, 'packages/marketplace/extensions/wb-demo/forgeax-extension.json'),
    ]);
    expect(files.every((f) => f.endsWith('/forgeax-extension.json'))).toBe(true);
  });

  it('discovers only depth-one slug dirs (not nested apps/ fixtures)', () => {
    mkdirSync(join(TMP, 'packages', 'marketplace', 'extensions', 'wb-demo'), { recursive: true });
    writeFileSync(
      join(TMP, 'packages', 'marketplace', 'extensions', 'wb-demo', 'forgeax-extension.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: '@forgeax-extension/wb-demo',
        version: '0.1.0',
        kind: 'workbench',
        displayName: 'Demo',
        provides: { workbench: { id: 'wb-demo' } },
      }),
    );
    mkdirSync(
      join(TMP, 'packages', 'marketplace', 'extensions', 'node-editor', 'apps', 'nested'),
      { recursive: true },
    );
    writeFileSync(
      join(
        TMP,
        'packages',
        'marketplace',
        'extensions',
        'node-editor',
        'apps',
        'nested',
        'forgeax-extension.json',
      ),
      JSON.stringify({
        schemaVersion: 1,
        id: '@forgeax-extension/nested',
        version: '0.1.0',
        kind: 'workbench',
        displayName: 'Nested',
        provides: { workbench: { id: 'nested' } },
      }),
    );
    writeFileSync(join(TMP, 'AGENTS.md'), '# test\n');
    mkdirSync(join(TMP, 'packages'), { recursive: true });

    const files = listManifests(TMP).filter((file) =>
      file.startsWith(join(TMP, 'packages/marketplace/extensions'))
    );
    expect(files).toEqual([
      join(TMP, 'packages/marketplace/extensions/wb-demo/forgeax-extension.json'),
    ]);
  });
});

describe('validate · malformed extension', () => {
  it('rejects a malformed forgeax-extension.json', () => {
    mkdirSync(join(TMP, 'bad'), { recursive: true });
    const path = join(TMP, 'bad', 'forgeax-extension.json');
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        id: 'not-a-scoped-id',
        version: '0.1.0',
        kind: 'workbench',
        displayName: 'Bad',
        provides: { workbench: { id: 'bad' } },
      }),
    );

    const finding = validate(path);
    expect(finding.ok).toBe(false);
    expect(finding.errors?.length).toBeGreaterThan(0);
  });
});
