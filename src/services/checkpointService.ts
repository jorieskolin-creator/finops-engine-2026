export type CheckpointKind = 'acquisition' | 'phase1' | 'phase2' | 'synthesis' | 'fact_check' | 'quality_gate' | 'final_report';

export interface CheckpointMetadata {
  checkpoint_id: string;
  run_id: string;
  kind: CheckpointKind;
  scope: string;
  revision: number;
  schema_version: 'checkpoint_v1';
  payload_hash: string;
  char_count: number;
  parent_hash: string | null;
  state: 'available';
  created_at: string;
  expires_at: string;
}

const request = async (url: string, init: RequestInit): Promise<any> => {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'CHECKPOINT_UNAVAILABLE');
  return body;
};

export const saveCheckpoint = (
  runId: string,
  kind: CheckpointKind,
  scope: string,
  payload: Record<string, unknown>,
  parentHash?: string,
): Promise<CheckpointMetadata> => request('/api/checkpoint', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ run_id: runId, kind, scope, payload, ...(parentHash ? { parent_hash: parentHash } : {}) }),
});

export const listCheckpoints = async (runId: string): Promise<CheckpointMetadata[]> => {
  const body = await request(`/api/checkpoint?run_id=${encodeURIComponent(runId)}`, { method: 'GET' });
  return Array.isArray(body?.checkpoints) ? body.checkpoints : [];
};

export const loadCheckpoint = async <T extends Record<string, unknown>>(
  runId: string,
  checkpointId: string,
): Promise<{ metadata: CheckpointMetadata; payload: T }> => request(
  `/api/checkpoint?run_id=${encodeURIComponent(runId)}&checkpoint_id=${encodeURIComponent(checkpointId)}`,
  { method: 'GET' },
);

export const loadLatestCheckpoint = async <T extends Record<string, unknown>>(
  runId: string,
  kind: CheckpointKind,
  scope: string,
): Promise<{ metadata: CheckpointMetadata; payload: T } | null> => {
  const candidates = (await listCheckpoints(runId))
    .filter(checkpoint => checkpoint.kind === kind && checkpoint.scope === scope)
    .sort((a, b) => b.revision - a.revision);
  return candidates[0] ? loadCheckpoint<T>(runId, candidates[0].checkpoint_id) : null;
};
