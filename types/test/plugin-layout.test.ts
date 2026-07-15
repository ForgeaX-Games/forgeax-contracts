import { describe, expect, it } from 'bun:test';
import {
  PLUGIN_MANIFEST_KINDS,
  classifyPluginManifestRelativePath,
  normalizePluginRelativePath,
  pluginSourceDisplayPath,
  type PluginSourceDescriptor,
} from '../src/plugin-layout';

describe('plugin layout contract', () => {
  it('classifies exact-depth canonical and legacy manifest paths', () => {
    expect(classifyPluginManifestRelativePath('workbench/wb-demo/forgeax-extension.json')).toEqual({
      layout: 'canonical',
      bucketKind: 'workbench',
      slug: 'wb-demo',
      relativeManifestPath: 'workbench/wb-demo/forgeax-extension.json',
    });
    expect(classifyPluginManifestRelativePath('wb-demo/forgeax-extension.json')).toEqual({
      layout: 'legacy',
      slug: 'wb-demo',
      relativeManifestPath: 'wb-demo/forgeax-extension.json',
    });
    expect(classifyPluginManifestRelativePath('workbench/wb-demo/fixtures/forgeax-extension.json')).toBeNull();
    expect(classifyPluginManifestRelativePath('unknown/wb-demo/forgeax-extension.json')).toBeNull();
  });

  it('normalizes separators while rejecting traversal, absolute, and dot-prefixed names', () => {
    expect(normalizePluginRelativePath('workbench\\wb-demo\\forgeax-extension.json')).toBe(
      'workbench/wb-demo/forgeax-extension.json',
    );
    expect(classifyPluginManifestRelativePath('../wb-demo/forgeax-extension.json')).toBeNull();
    expect(classifyPluginManifestRelativePath('/tmp/wb-demo/forgeax-extension.json')).toBeNull();
    expect(classifyPluginManifestRelativePath('.hidden/forgeax-extension.json')).toBeNull();
    expect(classifyPluginManifestRelativePath('workbench/.hidden/forgeax-extension.json')).toBeNull();
    expect([...PLUGIN_MANIFEST_KINDS].sort()).toEqual([
      'agent',
      'cli-provider',
      'model-binding',
      'skill',
      'tool',
      'workbench',
    ]);
  });

  it('renders layer-aware browser-safe source paths', () => {
    const bundled: PluginSourceDescriptor = {
      layer: 'L0',
      layout: 'canonical',
      bucketKind: 'workbench',
      relativeManifestPath: 'workbench/wb-demo/forgeax-extension.json',
    };
    const user: PluginSourceDescriptor = {
      layer: 'L1',
      layout: 'legacy',
      relativeManifestPath: 'wb-demo/forgeax-extension.json',
    };
    const project: PluginSourceDescriptor = {
      layer: 'L2',
      layout: 'canonical',
      bucketKind: 'tool',
      relativeManifestPath: 'tool/wb-demo/forgeax-extension.json',
    };

    expect(pluginSourceDisplayPath(bundled)).toBe(
      'packages/marketplace/extensions/workbench/wb-demo/forgeax-extension.json',
    );
    expect(pluginSourceDisplayPath(user)).toBe(
      '~/.forgeax/extensions/wb-demo/forgeax-extension.json',
    );
    expect(pluginSourceDisplayPath(project)).toBe(
      '.forgeax/extensions/tool/wb-demo/forgeax-extension.json',
    );
    expect(pluginSourceDisplayPath(null)).toBe('');
  });
});
