import { z } from 'zod';

/**
 * The model-owned part of a delivery summary.
 *
 * Files, line counts, duration, agents, and cost are deliberately absent:
 * those values belong to the host-side enrichment seam and must not be
 * model-authored.
 */
export const DeliverSummaryClaimSchema = z
  .object({
    outcome: z.string().min(1).max(500),
    roundLabel: z.string().max(24).optional(),
    tests: z
      .array(
        z
          .object({
            name: z.string().min(1),
            pass: z.boolean(),
            detail: z.string().max(200).optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    next: z.array(z.string().min(1)).max(5).optional(),
    build: z.string().max(16).optional(),
  })
  .strict();

export type DeliverSummaryClaim = z.infer<typeof DeliverSummaryClaimSchema>;

export const DeliverFileChangeSchema = z
  .object({
    path: z.string().min(1),
    change: z.enum(['edit', 'new', 'del']),
    insertions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    binary: z.boolean(),
  })
  .strict();

export type DeliverFileChange = z.infer<typeof DeliverFileChangeSchema>;

/** The host-enriched shape consumed by the chat projection layer. */
export const DeliverSummarySchema = DeliverSummaryClaimSchema.extend({
  files: z.array(DeliverFileChangeSchema),
  meta: z
    .object({
      durationMs: z.number().int().nonnegative(),
      agents: z.array(z.string()),
      costUsd: z.number().nonnegative().optional(),
      derivedUnavailable: z.boolean().optional(),
      unattributedCount: z.number().int().nonnegative().optional(),
    })
    .strict(),
}).strict();

export type DeliverSummary = z.infer<typeof DeliverSummarySchema>;

/** Tool result envelope used by the host-tool handler. */
export const DeliverSummaryToolResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      summary: DeliverSummarySchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.string().min(1),
    })
    .strict(),
]);

export type DeliverSummaryToolResult = z.infer<typeof DeliverSummaryToolResultSchema>;
