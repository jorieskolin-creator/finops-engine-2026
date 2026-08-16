# ADR-001: Execution and evidence lineage vocabulary

Status: Accepted

## Decision

The engine uses the following distinct lineage entities. They must not be
collapsed into a generic “packet” or “attempt” in persisted contracts:

- **Source artifact**: a user-supplied file before extraction.
- **Evidence Lane packet**: privacy-approved source chunks selected for one
  FinOps domain and bound to a manifest hash.
- **Knowledge release**: the immutable KB version used as normative context.
- **Analysis context revision**: an ordered change to the evidence available to
  analysis, initially used for targeted semantic rescans.
- **Stage execution**: one logical model task, including its ordered provider
  fallback attempts and one accepted result at most.
- **Model attempt**: one provider/model dispatch within a stage execution.
- **Governed dispatch packet**: the transient, privacy-screened model request
  approved for one model attempt.
- **Validated output**: a model response that passed the governed output and
  stage output contracts.
- **Checkpoint**: a recoverable internal artifact with predecessor and input
  lineage metadata.

`stage_executions` is the parent of existing `model_attempts`. Each browser
`runStage` call creates one stage execution ID and reuses it across fallbacks.
The accepted attempt is recorded only after the durable attempt reaches
`succeeded`. PostgreSQL stores each governed packet's immutable canonical
`BYTEA` body alongside its content-free metadata. Redis stores coordination
state only: attempt notifications, leases, send-authorization markers,
tombstones, checkpoints, and governed results. Terminal cleanup deletes packet
bodies while retaining content-free metadata and hashes for audit.

Checkpoint lineage columns are initially nullable so existing checkpoint
producers remain compatible. New context-revision producers should populate
the predecessor checkpoint, input revision/hash, and producing stage execution
as they are moved to the server-side orchestration boundary.

## Invariants

1. Evidence and KB material are never treated as model-attempt telemetry.
2. Every model attempt created by the lineage-aware application belongs to
   exactly one stage execution and has a unique order within it. The first
   migration keeps these columns nullable only for rolling-deployment
   compatibility with an older replica; a later migration may enforce this
   after the rollout window.
3. A stage execution has at most one accepted attempt.
4. Packet identity, metadata hash, SHA-256 over the exact PostgreSQL canonical
   bytes, run, provider, model, and stage are independently validated before
   external send. Packet bytes are canonicalized once at approval.
5. Any packet-binding mismatch remains fail-closed and is never eligible for
   provider fallback.
6. Neither semantic retrieval nor stage lineage has scoring authority.

## Deferred boundary

Moving approve/reserve/dispatch/recovery and checkpoint orchestration fully
server-side is intentionally incremental. It must reuse these entities and the
existing control plane rather than introduce a parallel attempt system.
