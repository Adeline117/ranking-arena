-- Migration: 20260729054400_leaderboard_rank_generation_private_staging.sql
-- Created: 2026-07-29T05:44:00Z
-- Description: Add an inert, owner-only, LOGGED generation store. A future
--   writer can place scorer batches here as immutable private versions; this
--   migration does not activate that writer or grant serving authority.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL quote_all_identifiers = 'off';

DO $dependency_preflight$
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR pg_catalog.to_regnamespace('arena') IS NULL
     OR pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regclass(
          'arena.leaderboard_rank_generation_heads'
        ) IS NULL
     OR pg_catalog.to_regclass(
          'arena.leaderboard_rank_generation_claims'
        ) IS NULL
     OR pg_catalog.to_regclass(
          'arena.leaderboard_rank_generation_manifest_bindings'
        ) IS NULL
     OR pg_catalog.to_regclass(
          'arena.leaderboard_rank_manifest_attestations'
        ) IS NULL
     OR pg_catalog.to_regclass(
          'arena.leaderboard_rank_manifest_attestation_chunks'
        ) IS NULL
     OR pg_catalog.to_regtype(
          'arena.leaderboard_rank_batch_row_v1'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.build_leaderboard_rank_typed_batch_evidence_v1(text,uuid,timestamptz,arena.leaderboard_rank_batch_row_v1[])'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.build_leaderboard_rank_generation_write_set_sha256_v1(text,uuid,text,timestamptz,integer,text[])'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.build_leaderboard_rank_typed_field_commitment_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.reject_leaderboard_rank_publication_mutation()'
        ) IS NULL THEN
    RAISE EXCEPTION 'private rank staging dependencies are missing';
  END IF;

  IF pg_catalog.to_regclass(
       'arena.leaderboard_rank_generation_stage_batches'
     ) IS NOT NULL
     OR pg_catalog.to_regclass(
          'arena.leaderboard_rank_generation_stage_rows'
        ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
          'arena.guard_leaderboard_rank_generation_stage_row_insert_v1()'
        ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
          'arena.validate_leaderboard_rank_generation_stage_batch_v1()'
        ) IS NOT NULL THEN
    RAISE EXCEPTION 'private rank staging is already partially installed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = relation_row.relnamespace
    WHERE namespace_row.nspname = 'arena'
      AND relation_row.relname IN (
        'leaderboard_rank_generation_stage_batches',
        'leaderboard_rank_generation_stage_rows'
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'arena'
      AND function_row.proname IN (
        'guard_leaderboard_rank_generation_stage_row_insert_v1',
        'validate_leaderboard_rank_generation_stage_batch_v1'
      )
  ) THEN
    RAISE EXCEPTION 'private rank staging has a noncanonical object';
  END IF;
END
$dependency_preflight$;

-- EXCLUSIVE on the admission head conflicts with a writer's SELECT FOR UPDATE,
-- so every old live writer drains before this migration touches any downstream
-- binding or attestation relation. The remaining order matches runtime.
LOCK TABLE ONLY arena.leaderboard_rank_generation_heads IN EXCLUSIVE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_generation_claims IN SHARE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_generation_manifest_bindings
  IN SHARE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_manifest_attestations IN SHARE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_manifest_attestation_chunks
  IN SHARE MODE;

CREATE TABLE arena.leaderboard_rank_generation_stage_batches (
  contract text NOT NULL,
  season_id text NOT NULL,
  generation_seq bigint NOT NULL,
  score_cohort_id uuid NOT NULL,
  batch_index integer NOT NULL,
  score_input_manifest_id uuid NOT NULL,
  score_input_manifest_digest text NOT NULL,
  batch_sha256_plan text[] NOT NULL,
  batch_sha256 text NOT NULL,
  row_count integer NOT NULL,
  source_count integer NOT NULL,
  first_source text COLLATE pg_catalog."C" NOT NULL,
  first_source_trader_id text COLLATE pg_catalog."C" NOT NULL,
  last_source text COLLATE pg_catalog."C" NOT NULL,
  last_source_trader_id text COLLATE pg_catalog."C" NOT NULL,
  staged_at timestamptz NOT NULL,
  CONSTRAINT rank_generation_stage_batch_pkey
    PRIMARY KEY (season_id, generation_seq, batch_index),
  CONSTRAINT rank_generation_stage_batch_cohort_key
    UNIQUE (score_cohort_id, batch_index),
  CONSTRAINT rank_generation_stage_batch_contract_check
    CHECK (contract = 'leaderboard-rank-generation-stage-batch@1'),
  CONSTRAINT rank_generation_stage_batch_season_check
    CHECK (season_id IN ('7D', '30D', '90D')),
  CONSTRAINT rank_generation_stage_batch_sequence_check
    CHECK (generation_seq > 0 AND generation_seq <= 9007199254740000),
  CONSTRAINT rank_generation_stage_batch_index_check
    CHECK (batch_index >= 0 AND batch_index < 64),
  CONSTRAINT rank_generation_stage_batch_manifest_digest_check
    CHECK (score_input_manifest_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT rank_generation_stage_batch_digest_check
    CHECK (batch_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT rank_generation_stage_batch_row_count_check
    CHECK (row_count > 0 AND row_count <= 1000),
  CONSTRAINT rank_generation_stage_batch_source_count_check
    CHECK (source_count > 0 AND source_count <= row_count),
  CONSTRAINT rank_generation_stage_batch_first_identity_check
    CHECK (
      first_source ~ '^[a-z0-9]+(_[a-z0-9]+)*$'
      AND pg_catalog.char_length(first_source) <= 128
      AND first_source_trader_id = pg_catalog.btrim(first_source_trader_id)
      AND first_source_trader_id <> ''
      AND pg_catalog.char_length(first_source_trader_id) <= 512
    ),
  CONSTRAINT rank_generation_stage_batch_last_identity_check
    CHECK (
      last_source ~ '^[a-z0-9]+(_[a-z0-9]+)*$'
      AND pg_catalog.char_length(last_source) <= 128
      AND last_source_trader_id = pg_catalog.btrim(last_source_trader_id)
      AND last_source_trader_id <> ''
      AND pg_catalog.char_length(last_source_trader_id) <= 512
    ),
  CONSTRAINT rank_generation_stage_batch_identity_order_check
    CHECK (
      (row_count = 1 AND ROW(first_source, first_source_trader_id) =
        ROW(last_source, last_source_trader_id))
      OR
      (row_count > 1 AND ROW(first_source, first_source_trader_id) <
        ROW(last_source, last_source_trader_id))
    ),
  CONSTRAINT rank_generation_stage_batch_staged_at_check
    CHECK (pg_catalog.isfinite(staged_at)),
  CONSTRAINT rank_generation_stage_batch_claim_fkey
    FOREIGN KEY (season_id, generation_seq, score_cohort_id)
    REFERENCES arena.leaderboard_rank_generation_claims (
      season_id,
      generation_seq,
      score_cohort_id
    ),
  CONSTRAINT rank_generation_stage_batch_binding_fkey
    FOREIGN KEY (
      season_id,
      generation_seq,
      score_cohort_id,
      score_input_manifest_id,
      score_input_manifest_digest
    )
    REFERENCES arena.leaderboard_rank_generation_manifest_bindings (
      season_id,
      generation_seq,
      score_cohort_id,
      score_input_manifest_id,
      score_input_manifest_digest
    )
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT rank_generation_stage_batch_attestation_fkey
    FOREIGN KEY (
      season_id,
      generation_seq,
      score_cohort_id,
      score_input_manifest_id,
      score_input_manifest_digest,
      batch_index
    )
    REFERENCES arena.leaderboard_rank_manifest_attestation_chunks (
      season_id,
      generation_seq,
      score_cohort_id,
      score_input_manifest_id,
      score_input_manifest_digest,
      chunk_index
    )
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE arena.leaderboard_rank_generation_stage_rows (
  contract text NOT NULL,
  season_id text NOT NULL,
  generation_seq bigint NOT NULL,
  score_cohort_id uuid NOT NULL,
  batch_index integer NOT NULL,
  batch_position integer NOT NULL,
  source text COLLATE pg_catalog."C" NOT NULL,
  source_trader_id text COLLATE pg_catalog."C" NOT NULL,
  row_payload arena.leaderboard_rank_batch_row_v1 NOT NULL,
  staged_at timestamptz NOT NULL,
  CONSTRAINT rank_generation_stage_row_pkey
    PRIMARY KEY (
      season_id,
      generation_seq,
      batch_index,
      batch_position
    ),
  CONSTRAINT rank_generation_stage_row_generation_identity_key
    UNIQUE (season_id, generation_seq, source, source_trader_id),
  CONSTRAINT rank_generation_stage_row_cohort_identity_key
    UNIQUE (score_cohort_id, source, source_trader_id),
  CONSTRAINT rank_generation_stage_row_contract_check
    CHECK (contract = 'leaderboard-rank-generation-stage-row@1'),
  CONSTRAINT rank_generation_stage_row_season_check
    CHECK (season_id IN ('7D', '30D', '90D')),
  CONSTRAINT rank_generation_stage_row_sequence_check
    CHECK (generation_seq > 0 AND generation_seq <= 9007199254740000),
  CONSTRAINT rank_generation_stage_row_batch_index_check
    CHECK (batch_index >= 0 AND batch_index < 64),
  CONSTRAINT rank_generation_stage_row_position_check
    CHECK (batch_position >= 1 AND batch_position <= 1000),
  CONSTRAINT rank_generation_stage_row_source_check
    CHECK (
      source ~ '^[a-z0-9]+(_[a-z0-9]+)*$'
      AND source = pg_catalog.lower(pg_catalog.btrim(source))
      AND pg_catalog.char_length(source) <= 128
    ),
  CONSTRAINT rank_generation_stage_row_trader_id_check
    CHECK (
      source_trader_id = pg_catalog.btrim(source_trader_id)
      AND source_trader_id <> ''
      AND pg_catalog.char_length(source_trader_id) <= 512
    ),
  CONSTRAINT rank_generation_stage_row_payload_identity_check
    CHECK (
      pg_catalog.convert_to(source, 'UTF8') =
        pg_catalog.convert_to((row_payload).source, 'UTF8')
      AND pg_catalog.convert_to(source_trader_id, 'UTF8') =
        pg_catalog.convert_to((row_payload).source_trader_id, 'UTF8')
    ),
  CONSTRAINT rank_generation_stage_row_provisional_state_check
    CHECK (
      (row_payload).rank IS NULL
      AND (row_payload).rank_change IS NULL
      AND (row_payload).is_new IS NULL
    ),
  CONSTRAINT rank_generation_stage_row_staged_at_check
    CHECK (pg_catalog.isfinite(staged_at)),
  CONSTRAINT rank_generation_stage_row_batch_fkey
    FOREIGN KEY (season_id, generation_seq, batch_index)
    REFERENCES arena.leaderboard_rank_generation_stage_batches (
      season_id,
      generation_seq,
      batch_index
    ),
  CONSTRAINT rank_generation_stage_row_claim_fkey
    FOREIGN KEY (season_id, generation_seq, score_cohort_id)
    REFERENCES arena.leaderboard_rank_generation_claims (
      season_id,
      generation_seq,
      score_cohort_id
    )
);

ALTER TABLE arena.leaderboard_rank_generation_stage_batches OWNER TO postgres;
ALTER TABLE arena.leaderboard_rank_generation_stage_rows OWNER TO postgres;

DO $revoke_table_acl$
DECLARE
  v_table regclass;
  v_grantee oid;
  v_role_name text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'arena.leaderboard_rank_generation_stage_batches'::regclass,
    'arena.leaderboard_rank_generation_stage_rows'::regclass
  ] LOOP
    FOR v_grantee IN
      SELECT DISTINCT privilege_row.grantee
      FROM pg_catalog.pg_class AS table_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          table_row.relacl,
          pg_catalog.acldefault('r', table_row.relowner)
        )
      ) AS privilege_row
      WHERE table_row.oid = v_table
        AND privilege_row.grantee <> table_row.relowner
      ORDER BY privilege_row.grantee
    LOOP
      IF v_grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE %s FROM PUBLIC CASCADE',
          v_table
        );
      ELSE
        SELECT role_row.rolname
        INTO STRICT v_role_name
        FROM pg_catalog.pg_roles AS role_row
        WHERE role_row.oid = v_grantee;
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE %s FROM %I CASCADE',
          v_table,
          v_role_name
        );
      END IF;
    END LOOP;
  END LOOP;
END
$revoke_table_acl$;

ALTER TABLE arena.leaderboard_rank_generation_stage_batches
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.leaderboard_rank_generation_stage_rows
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  arena.leaderboard_rank_generation_stage_batches,
  arena.leaderboard_rank_generation_stage_rows
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION arena.guard_leaderboard_rank_generation_stage_row_insert_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  v_current_xid xid8 := pg_catalog.pg_current_xact_id();
BEGIN
  IF EXISTS (
    SELECT 1
    FROM new_stage_rows AS staged
    LEFT JOIN ONLY arena.leaderboard_rank_generation_stage_batches AS batch
      ON batch.season_id = staged.season_id
     AND batch.generation_seq = staged.generation_seq
     AND batch.batch_index = staged.batch_index
     AND batch.score_cohort_id = staged.score_cohort_id
    WHERE batch.season_id IS NULL
       OR batch.xmin::text::xid8 IS DISTINCT FROM v_current_xid
       OR batch.staged_at IS DISTINCT FROM staged.staged_at
  ) THEN
    RAISE EXCEPTION
      'stage rows require their exact batch header from the current transaction'
      USING ERRCODE = '55000';
  END IF;

  RETURN NULL;
END;
$body$;

CREATE FUNCTION arena.validate_leaderboard_rank_generation_stage_batch_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET "TimeZone" = 'UTC'
SET lock_timeout = '10s'
AS $body$
DECLARE
  v_head arena.leaderboard_rank_generation_heads%ROWTYPE;
  v_claim arena.leaderboard_rank_generation_claims%ROWTYPE;
  v_chunk arena.leaderboard_rank_manifest_attestation_chunks%ROWTYPE;
  v_attestation arena.leaderboard_rank_manifest_attestations%ROWTYPE;
  v_current_xid xid8 := pg_catalog.pg_current_xact_id();
  v_header_xid xid8;
  v_rows arena.leaderboard_rank_batch_row_v1[];
  v_row_count integer;
  v_min_position integer;
  v_max_position integer;
  v_all_current_xid boolean;
  v_all_same_staged_at boolean;
  v_identities jsonb;
  v_field_commitments jsonb;
  v_evidence jsonb;
  v_expected_write_set text;
  v_prior_batch_count integer;
  v_prior_row_count integer;
  v_prior_last_source text;
  v_prior_last_source_trader_id text;
  v_now timestamptz;
BEGIN
  SELECT batch.xmin::text::xid8
  INTO STRICT v_header_xid
  FROM ONLY arena.leaderboard_rank_generation_stage_batches AS batch
  WHERE batch.season_id = NEW.season_id
    AND batch.generation_seq = NEW.generation_seq
    AND batch.batch_index = NEW.batch_index;

  IF v_header_xid IS DISTINCT FROM v_current_xid THEN
    RAISE EXCEPTION 'stage batch header is not transaction-atomic'
      USING ERRCODE = '55000';
  END IF;

  SELECT head.*
  INTO STRICT v_head
  FROM ONLY arena.leaderboard_rank_generation_heads AS head
  WHERE head.season_id = NEW.season_id
  FOR SHARE;

  SELECT claim.*
  INTO STRICT v_claim
  FROM ONLY arena.leaderboard_rank_generation_claims AS claim
  WHERE claim.season_id = NEW.season_id
    AND claim.generation_seq = NEW.generation_seq
    AND claim.score_cohort_id = NEW.score_cohort_id
  FOR SHARE;

  SELECT header.*
  INTO STRICT v_attestation
  FROM ONLY arena.leaderboard_rank_manifest_attestations AS header
  WHERE header.season_id = NEW.season_id
    AND header.generation_seq = NEW.generation_seq
    AND header.score_cohort_id = NEW.score_cohort_id
    AND header.score_input_manifest_id = NEW.score_input_manifest_id
    AND header.score_input_manifest_digest =
          NEW.score_input_manifest_digest;

  SELECT chunk.*
  INTO STRICT v_chunk
  FROM ONLY arena.leaderboard_rank_manifest_attestation_chunks AS chunk
  WHERE chunk.season_id = NEW.season_id
    AND chunk.generation_seq = NEW.generation_seq
    AND chunk.score_cohort_id = NEW.score_cohort_id
    AND chunk.score_input_manifest_id = NEW.score_input_manifest_id
    AND chunk.score_input_manifest_digest = NEW.score_input_manifest_digest
    AND chunk.chunk_index = NEW.batch_index;

  v_now := pg_catalog.clock_timestamp();
  v_expected_write_set :=
    arena.build_leaderboard_rank_generation_write_set_sha256_v1(
      NEW.season_id,
      NEW.score_cohort_id,
      NEW.score_input_manifest_digest,
      v_claim.computed_at,
      v_claim.expected_rank_count,
      NEW.batch_sha256_plan
    );
  IF v_claim.expected_rank_count < 1
     OR v_claim.expected_rank_count > 64000
     OR v_claim.expected_batch_count IS DISTINCT FROM
          (v_claim.expected_rank_count + 999) / 1000
     OR NEW.batch_index >= v_claim.expected_batch_count
     OR pg_catalog.cardinality(NEW.batch_sha256_plan) IS DISTINCT FROM
          v_claim.expected_batch_count
     OR NEW.batch_sha256_plan[NEW.batch_index + 1] IS DISTINCT FROM
          NEW.batch_sha256
     OR v_expected_write_set IS DISTINCT FROM v_claim.write_set_sha256
     OR NEW.row_count IS DISTINCT FROM
          LEAST(
            1000,
            v_claim.expected_rank_count - NEW.batch_index * 1000
          )
     OR v_head.generation_seq IS DISTINCT FROM NEW.generation_seq
     OR v_head.score_cohort_id IS DISTINCT FROM NEW.score_cohort_id
     OR v_head.phase NOT IN ('claimed', 'writing')
     OR v_head.lease_expires_at IS DISTINCT FROM v_claim.lease_expires_at
     OR v_head.lease_expires_at <= v_now
     OR v_attestation.manifest_valid_until <= v_now
     OR v_attestation.positive_count IS DISTINCT FROM
          v_claim.expected_rank_count
     OR v_attestation.chunk_count IS DISTINCT FROM
          v_claim.expected_batch_count
     OR NEW.staged_at < v_claim.claimed_at
     OR NEW.staged_at > v_now
     OR NEW.staged_at >= v_claim.lease_expires_at
     OR NEW.staged_at >= v_attestation.manifest_valid_until THEN
    RAISE EXCEPTION 'stage batch lost its exact generation authority'
      USING ERRCODE = '55000';
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.min(staged.batch_position)::integer,
    pg_catalog.max(staged.batch_position)::integer,
    COALESCE(
      pg_catalog.bool_and(
        staged.xmin::text::xid8 = v_current_xid
      ),
      false
    ),
    COALESCE(
      pg_catalog.bool_and(staged.staged_at = NEW.staged_at),
      false
    ),
    pg_catalog.array_agg(
      staged.row_payload ORDER BY staged.batch_position
    ),
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_array(
        staged.source,
        staged.source_trader_id
      )
      ORDER BY staged.batch_position
    ),
    pg_catalog.jsonb_agg(
      pg_catalog.to_jsonb(
        arena.build_leaderboard_rank_typed_field_commitment_v1(
          (staged.row_payload).source,
          (staged.row_payload).source_trader_id,
          (staged.row_payload).roi,
          (staged.row_payload).pnl,
          (staged.row_payload).win_rate,
          (staged.row_payload).max_drawdown,
          (staged.row_payload).sharpe_ratio,
          (staged.row_payload).profit_factor,
          (staged.row_payload).trades_count,
          (staged.row_payload).arena_score,
          (staged.row_payload).score_factors,
          (staged.row_payload).profitability_score,
          (staged.row_payload).risk_control_score,
          (staged.row_payload).execution_score
        )
      )
      ORDER BY staged.batch_position
    )
  INTO STRICT
    v_row_count,
    v_min_position,
    v_max_position,
    v_all_current_xid,
    v_all_same_staged_at,
    v_rows,
    v_identities,
    v_field_commitments
  FROM ONLY arena.leaderboard_rank_generation_stage_rows AS staged
  WHERE staged.season_id = NEW.season_id
    AND staged.generation_seq = NEW.generation_seq
    AND staged.batch_index = NEW.batch_index
    AND staged.score_cohort_id = NEW.score_cohort_id;

  IF v_row_count IS DISTINCT FROM NEW.row_count
     OR v_min_position IS DISTINCT FROM 1
     OR v_max_position IS DISTINCT FROM NEW.row_count
     OR NOT v_all_current_xid
     OR NOT v_all_same_staged_at
     OR pg_catalog.cardinality(v_rows) IS DISTINCT FROM NEW.row_count THEN
    RAISE EXCEPTION 'stage batch is incomplete or not transaction-atomic'
      USING ERRCODE = '55000';
  END IF;

  v_evidence := arena.build_leaderboard_rank_typed_batch_evidence_v1(
    NEW.season_id,
    NEW.score_cohort_id,
    v_claim.computed_at,
    v_rows
  );

  IF v_evidence->>'batch_sha256' IS DISTINCT FROM NEW.batch_sha256
     OR (v_evidence->>'row_count')::integer IS DISTINCT FROM NEW.row_count
     OR (v_evidence->>'source_count')::integer IS DISTINCT FROM
          NEW.source_count
     OR v_evidence->>'first_source' IS DISTINCT FROM NEW.first_source
     OR v_evidence->>'first_source_trader_id' IS DISTINCT FROM
          NEW.first_source_trader_id
     OR v_evidence->>'last_source' IS DISTINCT FROM NEW.last_source
     OR v_evidence->>'last_source_trader_id' IS DISTINCT FROM
          NEW.last_source_trader_id
     OR v_chunk.row_count IS DISTINCT FROM NEW.row_count
     OR v_chunk.first_position IS DISTINCT FROM
          NEW.batch_index * 1000 + 1
     OR v_chunk.identities IS DISTINCT FROM v_identities
     OR v_chunk.field_commitments IS DISTINCT FROM v_field_commitments THEN
    RAISE EXCEPTION 'stage batch diverges from typed or manifest evidence'
      USING ERRCODE = '55000';
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    COALESCE(pg_catalog.sum(prior.row_count), 0)::integer
  INTO STRICT v_prior_batch_count, v_prior_row_count
  FROM ONLY arena.leaderboard_rank_generation_stage_batches AS prior
  WHERE prior.season_id = NEW.season_id
    AND prior.generation_seq = NEW.generation_seq
    AND prior.batch_index < NEW.batch_index;

  IF v_prior_batch_count IS DISTINCT FROM NEW.batch_index
     OR v_prior_row_count IS DISTINCT FROM NEW.batch_index * 1000
     OR EXISTS (
       SELECT 1
       FROM ONLY arena.leaderboard_rank_generation_stage_batches AS prior
       WHERE prior.season_id = NEW.season_id
         AND prior.generation_seq = NEW.generation_seq
         AND prior.batch_index < NEW.batch_index
         AND prior.batch_sha256_plan IS DISTINCT FROM NEW.batch_sha256_plan
     ) THEN
    RAISE EXCEPTION 'stage batches are not a contiguous canonical prefix'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.batch_index > 0 THEN
    SELECT prior.last_source, prior.last_source_trader_id
    INTO STRICT v_prior_last_source, v_prior_last_source_trader_id
    FROM ONLY arena.leaderboard_rank_generation_stage_batches AS prior
    WHERE prior.season_id = NEW.season_id
      AND prior.generation_seq = NEW.generation_seq
      AND prior.batch_index = NEW.batch_index - 1;

    IF ROW(
         v_prior_last_source COLLATE pg_catalog."C",
         v_prior_last_source_trader_id COLLATE pg_catalog."C"
       ) >= ROW(
         NEW.first_source COLLATE pg_catalog."C",
         NEW.first_source_trader_id COLLATE pg_catalog."C"
       ) THEN
      RAISE EXCEPTION 'stage batch identity range overlaps its predecessor'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN NULL;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION 'stage batch is missing immutable generation evidence'
      USING ERRCODE = '23503';
END;
$body$;

ALTER FUNCTION arena.guard_leaderboard_rank_generation_stage_row_insert_v1()
  OWNER TO postgres;
ALTER FUNCTION arena.validate_leaderboard_rank_generation_stage_batch_v1()
  OWNER TO postgres;

DO $revoke_function_acl$
DECLARE
  v_function regprocedure;
  v_grantee oid;
  v_role_name text;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'arena.guard_leaderboard_rank_generation_stage_row_insert_v1()'::regprocedure,
    'arena.validate_leaderboard_rank_generation_stage_batch_v1()'::regprocedure
  ] LOOP
    FOR v_grantee IN
      SELECT DISTINCT privilege_row.grantee
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS privilege_row
      WHERE function_row.oid = v_function
        AND privilege_row.grantee <> function_row.proowner
      ORDER BY privilege_row.grantee
    LOOP
      IF v_grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC CASCADE',
          v_function
        );
      ELSE
        SELECT role_row.rolname
        INTO STRICT v_role_name
        FROM pg_catalog.pg_roles AS role_row
        WHERE role_row.oid = v_grantee;
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE',
          v_function,
          v_role_name
        );
      END IF;
    END LOOP;
  END LOOP;
END
$revoke_function_acl$;

REVOKE ALL ON FUNCTION
  arena.guard_leaderboard_rank_generation_stage_row_insert_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  arena.validate_leaderboard_rank_generation_stage_batch_v1()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER leaderboard_rank_generation_stage_rows_insert_guard
AFTER INSERT ON arena.leaderboard_rank_generation_stage_rows
REFERENCING NEW TABLE AS new_stage_rows
FOR EACH STATEMENT
EXECUTE FUNCTION
  arena.guard_leaderboard_rank_generation_stage_row_insert_v1();

CREATE CONSTRAINT TRIGGER leaderboard_rank_generation_stage_batches_complete
AFTER INSERT ON arena.leaderboard_rank_generation_stage_batches
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION
  arena.validate_leaderboard_rank_generation_stage_batch_v1();

CREATE TRIGGER leaderboard_rank_generation_stage_batches_immutable
BEFORE UPDATE OR DELETE
ON arena.leaderboard_rank_generation_stage_batches
FOR EACH ROW
EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation();

CREATE TRIGGER leaderboard_rank_generation_stage_batches_no_truncate
BEFORE TRUNCATE
ON arena.leaderboard_rank_generation_stage_batches
FOR EACH STATEMENT
EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation();

CREATE TRIGGER leaderboard_rank_generation_stage_rows_immutable
BEFORE UPDATE OR DELETE
ON arena.leaderboard_rank_generation_stage_rows
FOR EACH ROW
EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation();

CREATE TRIGGER leaderboard_rank_generation_stage_rows_no_truncate
BEFORE TRUNCATE
ON arena.leaderboard_rank_generation_stage_rows
FOR EACH STATEMENT
EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation();

COMMENT ON TABLE arena.leaderboard_rank_generation_stage_batches IS
  'Private LOGGED immutable batch headers bound to the complete claimed digest plan for one unactivated rank generation. They are not live publication receipts and grant no serving authority.';
COMMENT ON TABLE arena.leaderboard_rank_generation_stage_rows IS
  'Private LOGGED immutable typed scorer rows. rank, rank_change, and is_new must remain NULL until a later all-generation finalizer derives terminal serving order.';
COMMENT ON FUNCTION
  arena.guard_leaderboard_rank_generation_stage_row_insert_v1() IS
  'Statement guard forbidding stage-row append unless the exact batch header was inserted by the same transaction.';
COMMENT ON FUNCTION
  arena.validate_leaderboard_rank_generation_stage_batch_v1() IS
  'Deferred batch validator binding one complete staged typed batch to its live lease, immutable scorer attestation chunk, complete claimed digest plan, and canonical generation prefix.';

DO $postflight$
DECLARE
  v_guard oid := pg_catalog.to_regprocedure(
    'arena.guard_leaderboard_rank_generation_stage_row_insert_v1()'
  );
  v_validator oid := pg_catalog.to_regprocedure(
    'arena.validate_leaderboard_rank_generation_stage_batch_v1()'
  );
  v_guard_digest text;
  v_validator_digest text;
BEGIN
  IF v_guard IS NULL OR v_validator IS NULL THEN
    RAISE EXCEPTION 'private rank staging functions are missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('arena.leaderboard_rank_generation_stage_batches'::regclass, 16),
        ('arena.leaderboard_rank_generation_stage_rows'::regclass, 10)
    ) AS expected(table_oid, column_count)
    JOIN pg_catalog.pg_class AS table_row
      ON table_row.oid = expected.table_oid
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = table_row.relnamespace
    JOIN pg_catalog.pg_am AS access_method
      ON access_method.oid = table_row.relam
    WHERE namespace_row.nspname <> 'arena'
       OR table_row.relkind <> 'r'
       OR table_row.relpersistence <> 'p'
       OR table_row.relowner <> 'postgres'::pg_catalog.regrole
       OR NOT table_row.relrowsecurity
       OR table_row.relforcerowsecurity
       OR table_row.relispartition
       OR table_row.relreplident <> 'd'
       OR access_method.amname <> 'heap'
       OR table_row.reloptions IS NOT NULL
       OR expected.column_count <> (
         SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid = expected.table_oid
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
       )
  ) THEN
    RAISE EXCEPTION 'private rank staging relation shape is unsafe';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid IN (
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    )
  ) <> 33 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid IN (
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    )
  ) <> 5 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid IN (
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    )
      AND NOT trigger_row.tgisinternal
  ) <> 6 THEN
    RAISE EXCEPTION
      'private rank staging catalog cardinality drifted: constraints %, indexes %, triggers %',
      (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid IN (
          'arena.leaderboard_rank_generation_stage_batches'::regclass,
          'arena.leaderboard_rank_generation_stage_rows'::regclass
        )
      ),
      (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.pg_index AS index_row
        WHERE index_row.indrelid IN (
          'arena.leaderboard_rank_generation_stage_batches'::regclass,
          'arena.leaderboard_rank_generation_stage_rows'::regclass
        )
      ),
      (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid IN (
          'arena.leaderboard_rank_generation_stage_batches'::regclass,
          'arena.leaderboard_rank_generation_stage_rows'::regclass
        )
          AND NOT trigger_row.tgisinternal
      );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid IN (
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    )
  ) OR EXISTS (
    SELECT 1
    FROM (VALUES ('anon'), ('authenticated'), ('service_role'))
      AS api(role_name)
    CROSS JOIN (VALUES
      ('arena.leaderboard_rank_generation_stage_batches'::regclass),
      ('arena.leaderboard_rank_generation_stage_rows'::regclass)
    ) AS target(table_oid)
    WHERE pg_catalog.has_table_privilege(
      api.role_name,
      target.table_oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    ) OR pg_catalog.has_any_column_privilege(
      api.role_name,
      target.table_oid,
      'SELECT,INSERT,UPDATE,REFERENCES'
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS table_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        table_row.relacl,
        pg_catalog.acldefault('r', table_row.relowner)
      )
    ) AS privilege_row
    WHERE table_row.oid IN (
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    )
      AND privilege_row.grantee <> table_row.relowner
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl)
      AS privilege_row
    WHERE attribute.attrelid IN (
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND privilege_row.grantee <> 'postgres'::regrole
  ) THEN
    RAISE EXCEPTION 'private rank staging table ACL is unsafe';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid IN (v_guard, v_validator)
      AND (
        function_row.proowner <> 'postgres'::pg_catalog.regrole
        OR language_row.lanname <> 'plpgsql'
        OR function_row.prokind <> 'f'
        OR function_row.provolatile <> 'v'
        OR function_row.proparallel <> 'u'
        OR NOT function_row.prosecdef
        OR function_row.proisstrict
        OR function_row.proretset
        OR function_row.prorettype <> 'trigger'::pg_catalog.regtype
        OR function_row.pronargs <> 0
        OR function_row.proargtypes <> ''::pg_catalog.oidvector
        OR function_row.prosqlbody IS NOT NULL
        OR function_row.probin IS NOT NULL
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS privilege_row
    WHERE function_row.oid IN (v_guard, v_validator)
      AND privilege_row.grantee <> function_row.proowner
  ) THEN
    RAISE EXCEPTION 'private rank staging function shape or ACL is unsafe';
  END IF;

  SELECT pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
    'hex'
  )
  INTO STRICT v_guard_digest
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_guard;

  SELECT pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
    'hex'
  )
  INTO STRICT v_validator_digest
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_validator;

  IF v_guard_digest IS DISTINCT FROM
       'ba9030dfdd0431721903561fdfa02c106fcedc66cbb32ab20acf5ebd33958dc9'
     OR v_validator_digest IS DISTINCT FROM
       '14063ba832d2bd0a5de0d5975eaf4ea8a68093e63b27f78107770cd8766184b0'
     OR EXISTS (
       SELECT 1
       FROM (
         VALUES
           (
             v_guard,
             ARRAY['search_path=pg_catalog, pg_temp']::text[]
           ),
           (
             v_validator,
             ARRAY[
               'search_path=pg_catalog, pg_temp',
               'TimeZone=UTC',
               'lock_timeout=10s'
             ]::text[]
           )
       ) AS expected(function_oid, configuration)
       JOIN pg_catalog.pg_proc AS function_row
         ON function_row.oid = expected.function_oid
       WHERE function_row.proconfig IS DISTINCT FROM expected.configuration
     ) THEN
    RAISE EXCEPTION 'private rank staging function body drifted: % %',
      COALESCE(v_guard_digest, '-'),
      COALESCE(v_validator_digest, '-');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
          'arena.leaderboard_rank_generation_stage_rows'::regclass
      AND trigger_row.tgname =
          'leaderboard_rank_generation_stage_rows_insert_guard'
      AND trigger_row.tgfoid = v_guard
      AND trigger_row.tgtype = 4
      AND trigger_row.tgnewtable = 'new_stage_rows'
      AND trigger_row.tgoldtable IS NULL
      AND trigger_row.tgconstraint = 0
      AND NOT trigger_row.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
          'arena.leaderboard_rank_generation_stage_batches'::regclass
      AND trigger_row.tgname =
          'leaderboard_rank_generation_stage_batches_complete'
      AND trigger_row.tgfoid = v_validator
      AND trigger_row.tgtype = 5
      AND trigger_row.tgconstraint <> 0
      AND trigger_row.tgdeferrable
      AND trigger_row.tginitdeferred
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'private rank staging validation triggers are unsafe';
  END IF;
END
$postflight$;

COMMIT;
