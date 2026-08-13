/** Host-owned file-change result for one settled assistant turn.
 *
 * This is deliberately a small wire contract.  The host decides whether a
 * file belongs to the turn; model-authored delivery claims may only populate
 * `semantic` and can never create an ArtifactSummary by themselves.
 */

export type ArtifactFileChange = {
  path: string;
  change: 'edit' | 'new' | 'del';
  insertions?: number;
  deletions?: number;
  binary?: boolean;
};

export type ArtifactSemantic = {
  outcome?: string;
  tests?: Array<{ name: string; pass: boolean; detail?: string }>;
  next?: string[];
  build?: string;
};

export interface ArtifactSummary {
  id: string;
  sid: string;
  turnId: string;
  checkpointMsgId?: string;
  files: ArtifactFileChange[];
  status: 'complete' | 'partial' | 'unavailable';
  derivedUnavailable?: boolean;
  unavailableReason?: string;
  reliableCandidatePaths?: string[];
  unattributedCount?: number;
  agents: string[];
  durationMs?: number;
  semantic?: ArtifactSemantic;
};

export type ArtifactResolution =
  | { kind: 'no_change' }
  | { kind: 'summary'; summary: ArtifactSummary }
  | {
      kind: 'unavailable';
      reason: string;
      reliableCandidatePaths: string[];
      summary?: ArtifactSummary;
    };

export interface ArtifactResolvedPayload {
  schemaVersion: 1;
  artifactId: string;
  turnId: string;
  checkpointMsgId?: string;
  anchorSeq?: number;
  resolution: ArtifactResolution;
}
