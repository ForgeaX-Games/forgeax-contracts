import { ManifestKindSchema, type ManifestKind } from './manifest';
export type { ManifestKind } from './manifest';

/** Filesystem bucket names are the literal manifest kinds. */
export const PLUGIN_MANIFEST_KINDS = ManifestKindSchema.options;

export type PluginLayer = 'L0' | 'L1' | 'L2';
export type PluginLayout = 'canonical' | 'legacy';

interface PluginSourceDescriptorBase {
  layer: PluginLayer;
  /** POSIX path relative to the layer root; never absolute. */
  relativeManifestPath: string;
}

export type PluginSourceDescriptor =
  | (PluginSourceDescriptorBase & {
      layout: 'canonical';
      bucketKind: ManifestKind;
    })
  | (PluginSourceDescriptorBase & {
      layout: 'legacy';
      bucketKind?: never;
    });

export type ClassifiedPluginManifestPath =
  | {
      layout: 'canonical';
      bucketKind: ManifestKind;
      slug: string;
      relativeManifestPath: string;
    }
  | {
      layout: 'legacy';
      slug: string;
      relativeManifestPath: string;
    };

const KIND_SET = new Set<string>(PLUGIN_MANIFEST_KINDS);
const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u;

export function isPluginManifestKind(value: string): value is ManifestKind {
  return KIND_SET.has(value);
}

export function isSafePluginLayoutSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value) && !value.startsWith('.');
}

/**
 * Normalize host separators into the portable descriptor representation.
 * Absolute, traversal, empty, and current-directory segments are rejected.
 */
export function normalizePluginRelativePath(value: string): string | null {
  if (!value || value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value)) return null;
  const normalized = value.replace(/\\/gu, '/');
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

/** Classify only the two supported exact-depth manifest shapes. */
export function classifyPluginManifestRelativePath(
  value: string,
): ClassifiedPluginManifestPath | null {
  const relativeManifestPath = normalizePluginRelativePath(value);
  if (!relativeManifestPath) return null;
  const parts = relativeManifestPath.split('/');
  if (parts.at(-1) !== 'forgeax-extension.json') return null;

  if (
    parts.length === 2 &&
    isSafePluginLayoutSegment(parts[0]) &&
    !isPluginManifestKind(parts[0])
  ) {
    return {
      layout: 'legacy',
      slug: parts[0],
      relativeManifestPath,
    };
  }

  if (
    parts.length === 3 &&
    isPluginManifestKind(parts[0]) &&
    isSafePluginLayoutSegment(parts[1])
  ) {
    return {
      layout: 'canonical',
      bucketKind: parts[0],
      slug: parts[1],
      relativeManifestPath,
    };
  }
  return null;
}

/**
 * Build the browser-safe source descriptor from scanner origin metadata.
 * Returns null for malformed relative metadata rather than forwarding it.
 */
export function parsePluginSourceDescriptor(
  source: PluginSourceDescriptor,
): PluginSourceDescriptor | null {
  const classified = classifyPluginManifestRelativePath(source.relativeManifestPath);
  if (!classified || classified.layout !== source.layout) return null;
  if (
    classified.layout === 'canonical' &&
    source.bucketKind !== undefined &&
    source.bucketKind !== classified.bucketKind
  ) {
    return null;
  }
  return classified.layout === 'canonical'
    ? {
        layer: source.layer,
        layout: 'canonical',
        relativeManifestPath: classified.relativeManifestPath,
        bucketKind: classified.bucketKind,
      }
    : {
        layer: source.layer,
        layout: 'legacy',
        relativeManifestPath: classified.relativeManifestPath,
      };
}

/** Scanner/API boundary helper: malformed origin metadata is a contract bug. */
export function toPluginSourceDescriptor(source: PluginSourceDescriptor): PluginSourceDescriptor {
  const parsed = parsePluginSourceDescriptor(source);
  if (!parsed) throw new Error('invalid plugin source descriptor');
  return parsed;
}

/** Human-readable path with layer semantics, never an absolute host path. */
export function pluginSourceDisplayPath(
  source: PluginSourceDescriptor | null | undefined,
): string {
  if (!source) return '';
  const safe = parsePluginSourceDescriptor(source);
  if (!safe) return '';
  const base = safe.layer === 'L0'
    ? 'packages/marketplace/extensions'
    : safe.layer === 'L1'
      ? '~/.forgeax/extensions'
      : '.forgeax/extensions';
  return `${base}/${safe.relativeManifestPath}`;
}
