-- P05 (ADR 0007, plan §2.15): sqlc queries for embedding_generation and embedding_active.
-- Dynamic vector-table SQL lives in internal/embedding/store (not sqlc).

-- name: InsertPendingEmbeddingGeneration :one
INSERT INTO embedding_generation (
  id,
  provider,
  model,
  model_version,
  preprocessing,
  query_prefix,
  doc_prefix,
  dims,
  partitions,
  hnsw_m,
  hnsw_ef_construction,
  semantic_min_cos,
  calibration_ref,
  item_table,
  tag_table,
  state,
  bootstrap
) VALUES (
  sqlc.arg('id'),
  sqlc.arg('provider'),
  sqlc.arg('model'),
  sqlc.arg('model_version'),
  sqlc.arg('preprocessing'),
  sqlc.arg('query_prefix'),
  sqlc.arg('doc_prefix'),
  sqlc.arg('dims'),
  sqlc.arg('partitions'),
  sqlc.arg('hnsw_m'),
  sqlc.arg('hnsw_ef_construction'),
  sqlc.arg('semantic_min_cos'),
  sqlc.arg('calibration_ref'),
  'item_embedding_g' || sqlc.arg('id')::int,
  'tag_embedding_g'  || sqlc.arg('id')::int,
  'pending',
  sqlc.arg('bootstrap')
)
RETURNING *;

-- name: GetEmbeddingGenerationByID :one
SELECT *
FROM embedding_generation
WHERE id = sqlc.arg('id');

-- name: GetEmbeddingGenerationByIDForUpdate :one
SELECT *
FROM embedding_generation
WHERE id = sqlc.arg('id')
FOR UPDATE;

-- name: GetPendingEmbeddingGeneration :one
SELECT *
FROM embedding_generation
WHERE state = 'pending';

-- name: GetActiveEmbeddingGeneration :one
SELECT g.*
FROM embedding_active a
JOIN embedding_generation g ON g.id = a.generation_id
WHERE a.singleton = true;

-- name: GetEmbeddingActiveRow :one
SELECT *
FROM embedding_active
WHERE singleton = true;

-- name: ListReceivingEmbeddingGenerations :many
SELECT *
FROM embedding_generation
WHERE state IN ('active', 'pending')
   OR (state = 'retired' AND rollback_until IS NOT NULL AND rollback_until > now())
ORDER BY id ASC;

-- name: ListExistingEmbeddingGenerations :many
SELECT *
FROM embedding_generation
WHERE state <> 'dropped'
ORDER BY id ASC;

-- name: ListExistingExternalEmbeddingGenerations :many
SELECT *
FROM embedding_generation
WHERE provider = 'openai_compat'
  AND state <> 'dropped'
ORDER BY id ASC;

-- name: ListAllEmbeddingGenerations :many
SELECT *
FROM embedding_generation
ORDER BY id ASC;

-- name: CountEmbeddingGenerations :one
SELECT count(*)
FROM embedding_generation;

-- name: NextEmbeddingGenerationID :one
SELECT (COALESCE(MAX(id), 0) + 1)::int AS next_id
FROM embedding_generation;

-- name: UpsertEmbeddingActive :one
INSERT INTO embedding_active (
  singleton,
  generation_id,
  flipped_at,
  flipped_reason
) VALUES (
  true,
  sqlc.arg('generation_id'),
  now(),
  sqlc.narg('flipped_reason')
)
ON CONFLICT (singleton) DO UPDATE
SET
  generation_id = EXCLUDED.generation_id,
  flipped_at = now(),
  flipped_reason = EXCLUDED.flipped_reason
RETURNING *;

-- name: ActivateEmbeddingGeneration :one
UPDATE embedding_generation
SET
  state = 'active',
  activated_at = now(),
  rollback_until = NULL
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: RetireEmbeddingGeneration :one
UPDATE embedding_generation
SET
  state = 'retired',
  retired_at = now(),
  rollback_until = sqlc.narg('rollback_until')
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: MarkEmbeddingGenerationDropped :one
UPDATE embedding_generation
SET
  state = 'dropped',
  dropped_at = now(),
  index_ready = false
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: SetEmbeddingGenerationIndexReady :one
UPDATE embedding_generation
SET index_ready = sqlc.arg('index_ready')
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: SetEmbeddingGenerationVerified :one
UPDATE embedding_generation
SET
  verified_at = now(),
  verify_report = sqlc.narg('verify_report')
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: SetEmbeddingGenerationCanary :one
UPDATE embedding_generation
SET canary = sqlc.narg('canary')
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: UpdateEmbeddingGenerationCalibration :one
UPDATE embedding_generation
SET
  semantic_min_cos = sqlc.arg('semantic_min_cos'),
  calibration_ref = sqlc.arg('calibration_ref')
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: CreateEmbeddingGenerationTables :exec
SELECT embedding_generation_create_tables(
  sqlc.arg('id')::int,
  sqlc.arg('dims')::int,
  sqlc.arg('partitions')::int,
  sqlc.arg('with_hnsw')::boolean,
  sqlc.arg('hnsw_m')::int,
  sqlc.arg('hnsw_ef_construction')::int
);

-- name: DropEmbeddingGenerationTables :exec
SELECT embedding_generation_drop_tables(
  sqlc.arg('id')::int
);
