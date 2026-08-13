import { z } from 'zod';

/** The only representation levels a host-owned injection may expose. */
export const InjectionGranularitySchema = z.enum(['full', 'index', 'directory', 'none']);
export const InjectionStabilitySchema = z.enum(['immutable', 'per-session', 'per-turn']);
export const InjectionPlacementSchema = z.enum(['tools', 'system', 'message-tail', 'tool-result']);
export const InjectionMutationSchema = z.enum(['frozen', 'append-only', 'boundary-batch']);

export const InjectionBudgetSchema = z
  .object({
    maxTokens: z.number().int().positive().optional(),
    maxEntries: z.number().int().positive().optional(),
  })
  .strict()
  .refine((value) => value.maxTokens !== undefined || value.maxEntries !== undefined, {
    message: 'budget must declare maxTokens or maxEntries',
  });

/** Strict five-field policy. Registry metadata belongs outside this object. */
export const InjectionPolicySchema = z
  .object({
    budget: InjectionBudgetSchema,
    granularity: InjectionGranularitySchema,
    stability: InjectionStabilitySchema,
    placement: InjectionPlacementSchema,
    mutation: InjectionMutationSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.stability === 'per-turn' && (value.placement === 'tools' || value.placement === 'system')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['placement'],
        message: 'per-turn injections cannot be placed in tools or system',
      });
    }
  });

export const InjectionPointSchema = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
    policy: InjectionPolicySchema,
  })
  .strict();

export type InjectionGranularity = z.infer<typeof InjectionGranularitySchema>;
export type InjectionPlacement = z.infer<typeof InjectionPlacementSchema>;
export type InjectionMutation = z.infer<typeof InjectionMutationSchema>;
export type InjectionPolicy = z.infer<typeof InjectionPolicySchema>;
export type InjectionPoint = z.infer<typeof InjectionPointSchema>;

export const INJECTION_GRANULARITY_ORDER: readonly InjectionGranularity[] = [
  'full',
  'index',
  'directory',
  'none',
];

/** A deterministic, complete representation at one declared granularity. */
export interface InjectionRepresentation {
  granularity: InjectionGranularity;
  text: string;
  entries: number;
  tokens: number;
}

export interface InjectionBudgetDiagnostic {
  sourceId: string;
  initialGranularity: InjectionGranularity;
  finalGranularity: InjectionGranularity;
  initialTokens: number;
  finalTokens: number;
  initialEntries: number;
  finalEntries: number;
  placement: InjectionPlacement;
  mutation: InjectionMutation;
  boundary?: string;
  estimator: string;
  fallback: boolean;
}

/** Versioned enough to make diagnostics reproducible across providers. */
export const CANONICAL_TOKEN_ESTIMATOR = 'utf8-bytes-v1';

export function estimateInjectionTokens(text: string): number {
  // Provider tokenizers are not available at registry-validation time. This
  // conservative byte estimator is stable and deliberately versioned.
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(new TextEncoder().encode(text).byteLength / 4));
}
