import { describe, expect, it } from 'bun:test';
import { DeliverSummaryClaimSchema, DeliverSummarySchema } from '../src/deliver-summary';

describe('DeliverSummaryClaimSchema', () => {
  it('accepts semantic fields and rejects host-derived fields', () => {
    const result = DeliverSummaryClaimSchema.safeParse({
      outcome: 'Implemented the task flow contract.',
      roundLabel: 'Host contract',
      tests: [{ name: 'unit tests', pass: true, detail: '99 tests passed' }],
      next: ['Wire the UI projection', 'Review the delivery card', 'Confirm the build', 'Play it', 'Ship it'],
      build: 'V10.1',
    });
    expect(result.success).toBe(true);

    expect(
      DeliverSummaryClaimSchema.safeParse({
        outcome: 'done',
        files: [],
        meta: { durationMs: 1, agents: [] },
      }).success,
    ).toBe(false);
  });

  it('reports explicit boundary failures', () => {
    expect(DeliverSummaryClaimSchema.safeParse({ outcome: '' }).success).toBe(false);
    expect(DeliverSummaryClaimSchema.safeParse({ outcome: 'done', next: ['a', 'b', 'c', 'd', 'e', 'f'] }).success).toBe(false);
    expect(
      DeliverSummaryClaimSchema.safeParse({
        outcome: 'done',
        tests: [{ name: 'missing pass' }],
      }).success,
    ).toBe(false);
  });
});

describe('DeliverSummarySchema', () => {
  it('accepts the host-enriched shape', () => {
    expect(
      DeliverSummarySchema.safeParse({
        outcome: 'done',
        files: [{ path: 'src/main.ts', change: 'edit', insertions: 2, deletions: 1, binary: false }],
        meta: { durationMs: 10, agents: ['forge'] },
      }).success,
    ).toBe(true);
  });
});
