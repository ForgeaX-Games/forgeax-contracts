import { describe, expect, it } from 'bun:test';
import {
  InjectionPolicySchema,
  InjectionPointSchema,
  estimateInjectionTokens,
} from '../src/injection-contract';
import { AgentDefinitionSchema, WriteGlobsSchema } from '../src/agent';

describe('injection contract schema', () => {
  it('accepts the exact five policy fields and rejects a sixth field', () => {
    const policy = {
      budget: { maxTokens: 100 },
      granularity: 'full',
      stability: 'per-session',
      placement: 'system',
      mutation: 'boundary-batch',
    } as const;
    expect(InjectionPolicySchema.parse(policy)).toEqual(policy);
    expect(InjectionPolicySchema.safeParse({ ...policy, extra: true }).success).toBe(false);
  });

  it('rejects an empty budget and per-turn system/tools placement', () => {
    expect(InjectionPolicySchema.safeParse({
      budget: {}, granularity: 'full', stability: 'per-session', placement: 'system', mutation: 'frozen',
    }).success).toBe(false);
    expect(InjectionPolicySchema.safeParse({
      budget: { maxEntries: 1 }, granularity: 'full', stability: 'per-turn', placement: 'tools', mutation: 'append-only',
    }).success).toBe(false);
  });

  it('keeps registry metadata outside the strict policy object', () => {
    const result = InjectionPointSchema.safeParse({
      id: 'memory.test',
      source: 'test fixture',
      policy: {
        budget: { maxEntries: 2 },
        granularity: 'index',
        stability: 'per-turn',
        placement: 'message-tail',
        mutation: 'append-only',
      },
    });
    expect(result.success).toBe(true);
  });

  it('uses a stable estimator for unicode text', () => {
    expect(estimateInjectionTokens('')).toBe(0);
    expect(estimateInjectionTokens('abc')).toBe(1);
    expect(estimateInjectionTokens('你好世界')).toBe(3);
    expect(estimateInjectionTokens('a'.repeat(9))).toBe(3);
  });

  it('shares write-domain validation across manifest and agent definitions', () => {
    expect(WriteGlobsSchema.safeParse(['<active_game>.dir/src/**']).success).toBe(true);
    expect(WriteGlobsSchema.safeParse(['<active_game>.dir']).success).toBe(true);
    expect(WriteGlobsSchema.safeParse(['**/*.ts', '**/*.ts']).success).toBe(false);
    expect(WriteGlobsSchema.safeParse(['!src/**']).success).toBe(false);
    expect(AgentDefinitionSchema.safeParse({
      id: 'writer',
      role: 'writer',
      card: { name: { en: 'Writer' }, color: '#fff', avatar: 'W' },
      personaFile: './persona.md',
      writeGlobs: ['<active_game>.dir/src/**'],
      tools: [],
    }).success).toBe(true);
  });
});
