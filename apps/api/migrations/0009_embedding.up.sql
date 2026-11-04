-- P05 (ADR 0007): embedding generation registry, active singleton pointer, and
-- dynamic DDL helpers for per-generation partitioned vector tables.
-- No item_embedding_g<N>/tag_embedding_g<N> tables or HNSW indexes are created here;
-- they are created via embedding_generation_create_tables at bootstrap or CLI cutover.
-- Forward-only on production; down is for ephemeral test databases only.

CREATE TABLE embedding_generation (
  id                   int PRIMARY KEY CHECK (id BETWEEN 1 AND 9999),
  provider             text NOT NULL CHECK (provider IN ('tei', 'openai_compat')),
  model                text NOT NULL CHECK (char_length(model) > 0),
  model_version        text NOT NULL CHECK (char_length(model_version) > 0),
  preprocessing        text NOT NULL CHECK (char_length(preprocessing) > 0),
  query_prefix         text NOT NULL,
  doc_prefix           text NOT NULL,
  dims                 int NOT NULL CHECK (dims BETWEEN 1 AND 2000),
  partitions           int NOT NULL DEFAULT 16 CHECK (partitions BETWEEN 1 AND 256),
  hnsw_m               int NOT NULL DEFAULT 16 CHECK (hnsw_m BETWEEN 2 AND 100),
  hnsw_ef_construction int NOT NULL DEFAULT 128 CHECK (hnsw_ef_construction BETWEEN 4 AND 1000),
  semantic_min_cos     real NOT NULL CHECK (semantic_min_cos > 0 AND semantic_min_cos < 1),
  calibration_ref      text NOT NULL CHECK (char_length(calibration_ref) > 0),
  canary               jsonb,
  item_table           text NOT NULL UNIQUE CHECK (item_table = 'item_embedding_g' || id),
  tag_table            text NOT NULL UNIQUE CHECK (tag_table = 'tag_embedding_g' || id),
  state                text NOT NULL CHECK (state IN ('pending', 'active', 'retired', 'dropped')),
  bootstrap            boolean NOT NULL DEFAULT false,
  rollback_until       timestamptz,
  index_ready          boolean NOT NULL DEFAULT false,
  verified_at          timestamptz,
  verify_report        jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  activated_at         timestamptz,
  retired_at           timestamptz,
  dropped_at           timestamptz
);

CREATE UNIQUE INDEX embedding_generation_one_pending
  ON embedding_generation ((true))
  WHERE state = 'pending';

CREATE TABLE embedding_active (
  singleton      boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  generation_id  int NOT NULL REFERENCES embedding_generation (id),
  flipped_at     timestamptz NOT NULL DEFAULT now(),
  flipped_reason text
);

CREATE OR REPLACE FUNCTION embedding_generation_create_tables(
  p_id         int,
  p_dims       int,
  p_partitions int,
  p_with_hnsw  boolean,
  p_m          int,
  p_efc        int
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_item_table text;
  v_tag_table  text;
  v_item_part  text;
  v_tag_part   text;
  v_item_idx   text;
  v_tag_idx    text;
  v_count      bigint;
  i            int;
BEGIN
  IF p_id IS NULL OR p_id < 1 OR p_id > 9999 THEN
    RAISE EXCEPTION 'embedding_generation_create_tables: p_id % out of range 1..9999', p_id
      USING ERRCODE = '22023';
  END IF;
  IF p_dims IS NULL OR p_dims < 1 OR p_dims > 2000 THEN
    RAISE EXCEPTION 'embedding_generation_create_tables: p_dims % out of range 1..2000', p_dims
      USING ERRCODE = '22023';
  END IF;
  IF p_partitions IS NULL OR p_partitions < 1 OR p_partitions > 256 THEN
    RAISE EXCEPTION 'embedding_generation_create_tables: p_partitions % out of range 1..256', p_partitions
      USING ERRCODE = '22023';
  END IF;
  IF p_m IS NULL OR p_m < 2 OR p_m > 100 THEN
    RAISE EXCEPTION 'embedding_generation_create_tables: p_m % out of range 2..100', p_m
      USING ERRCODE = '22023';
  END IF;
  IF p_efc IS NULL OR p_efc < 4 OR p_efc > 1000 THEN
    RAISE EXCEPTION 'embedding_generation_create_tables: p_efc % out of range 4..1000', p_efc
      USING ERRCODE = '22023';
  END IF;
  IF p_efc < 2 * p_m THEN
    RAISE EXCEPTION 'embedding_generation_create_tables: p_efc (%) must be >= 2 * p_m (%)', p_efc, p_m
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM embedding_generation WHERE id = p_id AND state <> 'dropped') THEN
    RAISE EXCEPTION 'embedding_generation_create_tables: generation % does not exist or is dropped', p_id
      USING ERRCODE = '22023';
  END IF;

  v_item_table := 'item_embedding_g' || p_id;
  v_tag_table  := 'tag_embedding_g'  || p_id;

  EXECUTE format($f$
    CREATE TABLE %I (
      user_id       uuid NOT NULL,
      target_id     uuid NOT NULL,
      embedding     vector(%s) NOT NULL,
      model         text NOT NULL,
      model_version text NOT NULL,
      input_hash    bytea NOT NULL CHECK (octet_length(input_hash) = 32),
      embedded_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, target_id),
      FOREIGN KEY (user_id, target_id) REFERENCES item (user_id, id) ON DELETE CASCADE
    ) PARTITION BY HASH (user_id)
  $f$, v_item_table, p_dims);

  EXECUTE format($f$
    CREATE TABLE %I (
      user_id       uuid NOT NULL,
      target_id     uuid NOT NULL,
      embedding     vector(%s) NOT NULL,
      model         text NOT NULL,
      model_version text NOT NULL,
      input_hash    bytea NOT NULL CHECK (octet_length(input_hash) = 32),
      embedded_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, target_id),
      FOREIGN KEY (user_id, target_id) REFERENCES tag (user_id, id) ON DELETE CASCADE
    ) PARTITION BY HASH (user_id)
  $f$, v_tag_table, p_dims);

  FOR i IN 0 .. p_partitions - 1 LOOP
    v_item_part := v_item_table || '_p' || i;
    v_tag_part  := v_tag_table  || '_p' || i;

    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %I FOR VALUES WITH (MODULUS %s, REMAINDER %s)',
      v_item_part, v_item_table, p_partitions, i
    );
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %I FOR VALUES WITH (MODULUS %s, REMAINDER %s)',
      v_tag_part, v_tag_table, p_partitions, i
    );
  END LOOP;

  IF COALESCE(p_with_hnsw, false) THEN
    EXECUTE format('SELECT count(*) FROM %I', v_item_table) INTO v_count;
    IF v_count > 0 THEN
      RAISE EXCEPTION 'embedding_generation_create_tables: % is not empty', v_item_table
        USING ERRCODE = '55000';
    END IF;
    EXECUTE format('SELECT count(*) FROM %I', v_tag_table) INTO v_count;
    IF v_count > 0 THEN
      RAISE EXCEPTION 'embedding_generation_create_tables: % is not empty', v_tag_table
        USING ERRCODE = '55000';
    END IF;

    FOR i IN 0 .. p_partitions - 1 LOOP
      v_item_part := v_item_table || '_p' || i;
      v_tag_part  := v_tag_table  || '_p' || i;
      v_item_idx  := v_item_part  || '_hnsw';
      v_tag_idx   := v_tag_part   || '_hnsw';

      EXECUTE format(
        'CREATE INDEX %I ON %I USING hnsw (embedding vector_cosine_ops) WITH (m = %s, ef_construction = %s)',
        v_item_idx, v_item_part, p_m, p_efc
      );
      EXECUTE format(
        'CREATE INDEX %I ON %I USING hnsw (embedding vector_cosine_ops) WITH (m = %s, ef_construction = %s)',
        v_tag_idx, v_tag_part, p_m, p_efc
      );
    END LOOP;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION embedding_generation_drop_tables(
  p_id int
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_state      text;
  v_item_table text;
  v_tag_table  text;
BEGIN
  IF p_id IS NULL OR p_id < 1 OR p_id > 9999 THEN
    RAISE EXCEPTION 'embedding_generation_drop_tables: p_id % out of range 1..9999', p_id
      USING ERRCODE = '22023';
  END IF;

  SELECT state
    INTO v_state
    FROM embedding_generation
   WHERE id = p_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'embedding_generation_drop_tables: generation % does not exist', p_id
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (SELECT 1 FROM embedding_active WHERE generation_id = p_id) THEN
    RAISE EXCEPTION 'embedding_generation_drop_tables: generation % is currently active', p_id
      USING ERRCODE = '55000';
  END IF;

  IF v_state <> 'retired' THEN
    RAISE EXCEPTION 'embedding_generation_drop_tables: generation % has state %, expected retired', p_id, v_state
      USING ERRCODE = '55000';
  END IF;

  v_item_table := 'item_embedding_g' || p_id;
  v_tag_table  := 'tag_embedding_g'  || p_id;

  EXECUTE format('DROP TABLE IF EXISTS %I', v_item_table);
  EXECUTE format('DROP TABLE IF EXISTS %I', v_tag_table);
END;
$$;
