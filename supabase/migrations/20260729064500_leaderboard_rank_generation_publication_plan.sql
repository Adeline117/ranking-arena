-- Bind one complete private generation to one exact, registry-complete serving
-- plan before any public leaderboard row is touched. Fresh sources are backed
-- by the current one-statement score-input bundle and immutable staged rows.
-- Retained sources are backed by the current sealed publication preimage.
-- Sources with neither fresh evidence nor a sealed last-good publication are
-- recorded as unavailable with an empty target, never invented as fresh.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
DECLARE
  v_required regclass;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer < 170000 THEN
    RAISE EXCEPTION 'generation publication plans require PostgreSQL 17';
  END IF;

  FOREACH v_required IN ARRAY ARRAY[
    pg_catalog.to_regclass('arena.leaderboard_rank_generation_claims'),
    pg_catalog.to_regclass('arena.leaderboard_rank_generation_heads'),
    pg_catalog.to_regclass('arena.leaderboard_rank_generation_manifest_bindings'),
    pg_catalog.to_regclass('arena.leaderboard_rank_generation_batch_receipts'),
    pg_catalog.to_regclass('arena.leaderboard_rank_generation_stage_batches'),
    pg_catalog.to_regclass('arena.leaderboard_rank_generation_stage_rows'),
    pg_catalog.to_regclass('arena.leaderboard_rank_manifest_attestations'),
    pg_catalog.to_regclass('arena.leaderboard_rank_manifest_attestation_chunks'),
    pg_catalog.to_regclass('arena.leaderboard_score_input_manifests'),
    pg_catalog.to_regclass('arena.leaderboard_rank_mutation_fences'),
    pg_catalog.to_regclass('arena.leaderboard_rank_publications'),
    pg_catalog.to_regclass('arena.metric_rankable_observations'),
    pg_catalog.to_regclass('arena.metric_rankable_score_inputs_shadow'),
    pg_catalog.to_regclass('arena.sources'),
    pg_catalog.to_regclass('arena.traders'),
    pg_catalog.to_regclass('arena.leaderboard_snapshots'),
    pg_catalog.to_regclass('arena.leaderboard_entries'),
    pg_catalog.to_regclass('arena.exchanges'),
    pg_catalog.to_regclass('public.leaderboard_ranks'),
    pg_catalog.to_regclass('public.leaderboard_source_freshness')
  ] LOOP
    IF v_required IS NULL THEN
      RAISE EXCEPTION 'generation publication plan prerequisite is missing';
    END IF;
  END LOOP;


  IF pg_catalog.to_regprocedure(
       'public.arena_score_inputs_publish_bundle_json(text,integer,integer)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.arena_freshness_expected_sources()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.verify_leaderboard_score_input_manifest_v1(uuid)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.encode_leaderboard_rank_row_v1(public.leaderboard_ranks)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.encode_leaderboard_rank_manifest_fields_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.build_leaderboard_rank_manifest_field_commitment_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.build_leaderboard_rank_manifest_chunks_sha256_v1(text,bigint,uuid,uuid,text,integer,integer,jsonb)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.leaderboard_rank_manifest_attestation_chunk_is_valid_v1(text,bigint,uuid,uuid,text,integer,integer,integer,jsonb,jsonb,text)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks,timestamp with time zone)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.reject_leaderboard_rank_publication_mutation()'
     ) IS NULL THEN
    RAISE EXCEPTION 'generation publication plan function prerequisite is missing';
  END IF;

  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'generation publication plan requires exact API roles';
  END IF;

  IF pg_catalog.to_regclass(
       'arena.leaderboard_rank_generation_publication_plans'
     ) IS NOT NULL
     OR pg_catalog.to_regclass(
       'arena.leaderboard_rank_generation_publication_plan_sources'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.seal_leaderboard_rank_generation_publication_plan_v1(text,bigint,uuid,uuid,text)'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.defer_rank_generation_publication_plan_checks_v1()'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.build_leaderboard_metric_trust_projection_v1(text,jsonb,jsonb)'
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'generation publication plan substrate is partially installed';
  END IF;
END
$preflight$;

-- The staging-only writer takes RowShareLock on the admission head before it
-- can append a private graph. Drain every admitted writer first, then prevent
-- a committed or concurrent batch zero from escaping the new publication
-- hook while it is installed. Existing private graphs have no trustworthy
-- same-top-level-XID plan and must be quarantined explicitly, never backfilled
-- by pretending they were planned atomically.
LOCK TABLE ONLY arena.leaderboard_rank_generation_heads IN EXCLUSIVE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_generation_stage_batches
  IN ACCESS EXCLUSIVE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_generation_stage_rows IN SHARE MODE;

DO $empty_stage_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM ONLY arena.leaderboard_rank_generation_stage_batches
  ) OR EXISTS (
    SELECT 1
    FROM ONLY arena.leaderboard_rank_generation_stage_rows
  ) THEN
    RAISE EXCEPTION
      'publication-plan installation requires an empty private stage'
      USING
        ERRCODE = '55000',
        HINT = 'Quarantine the pre-existing generation graph before retrying.';
  END IF;
END
$empty_stage_preflight$;

CREATE TABLE arena.leaderboard_rank_generation_publication_plans (
  contract text NOT NULL,
  season_id text NOT NULL,
  generation_seq bigint NOT NULL,
  score_cohort_id uuid NOT NULL,
  score_input_manifest_id uuid NOT NULL,
  score_input_manifest_digest text NOT NULL,
  plan_write_top_xid xid8 NOT NULL DEFAULT pg_catalog.pg_current_xact_id(),
  manifest_attestation_sha256 text NOT NULL,
  authority_sha256 text NOT NULL,
  plan_sha256 text NOT NULL,
  source_count integer NOT NULL,
  replace_source_count integer NOT NULL,
  retain_source_count integer NOT NULL,
  unavailable_source_count integer NOT NULL,
  staged_rank_count integer NOT NULL,
  retained_rank_count integer NOT NULL,
  target_rank_count integer NOT NULL,
  planned_at timestamptz NOT NULL,
  manifest_valid_until timestamptz NOT NULL,
  CONSTRAINT rank_generation_publication_plan_pkey
    PRIMARY KEY (season_id, generation_seq),
  CONSTRAINT rank_generation_publication_plan_cohort_key
    UNIQUE (score_cohort_id),
  CONSTRAINT rank_generation_publication_plan_identity_cohort_key
    UNIQUE (season_id, generation_seq, score_cohort_id),
  CONSTRAINT rank_generation_publication_plan_identity_key
    UNIQUE (
      season_id,
      generation_seq,
      score_cohort_id,
      score_input_manifest_id,
      score_input_manifest_digest
    ),
  CONSTRAINT rank_generation_publication_plan_contract_check
    CHECK (contract = 'leaderboard-rank-generation-publication-plan@1'),
  CONSTRAINT rank_generation_publication_plan_season_check
    CHECK (season_id IN ('7D', '30D', '90D')),
  CONSTRAINT rank_generation_publication_plan_sequence_check
    CHECK (generation_seq > 0 AND generation_seq <= 9007199254740000),
  CONSTRAINT rank_generation_publication_plan_digest_check
    CHECK (
      score_input_manifest_digest ~ '^[0-9a-f]{64}$'
      AND manifest_attestation_sha256 ~ '^[0-9a-f]{64}$'
      AND authority_sha256 ~ '^[0-9a-f]{64}$'
      AND plan_sha256 ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT rank_generation_publication_plan_source_counts_check
    CHECK (
      source_count > 0 AND source_count <= 256
      AND replace_source_count >= 0
      AND retain_source_count >= 0
      AND unavailable_source_count >= 0
      AND replace_source_count + retain_source_count
          + unavailable_source_count = source_count
    ),
  CONSTRAINT rank_generation_publication_plan_rank_counts_check
    CHECK (
      staged_rank_count >= 0 AND staged_rank_count <= 64000
      AND retained_rank_count >= 0 AND retained_rank_count <= 250000
      AND target_rank_count = staged_rank_count + retained_rank_count
      AND target_rank_count <= 250000
    ),
  CONSTRAINT rank_generation_publication_plan_time_check
    CHECK (
      pg_catalog.isfinite(planned_at)
      AND pg_catalog.isfinite(manifest_valid_until)
      AND planned_at < manifest_valid_until
    ),
  CONSTRAINT rank_generation_publication_plan_claim_fkey
    FOREIGN KEY (season_id, generation_seq, score_cohort_id)
    REFERENCES arena.leaderboard_rank_generation_claims (
      season_id, generation_seq, score_cohort_id
    ),
  CONSTRAINT rank_generation_publication_plan_binding_fkey
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
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE arena.leaderboard_rank_generation_publication_plan_sources (
  contract text NOT NULL,
  season_id text NOT NULL,
  generation_seq bigint NOT NULL,
  score_cohort_id uuid NOT NULL,
  source text COLLATE pg_catalog."C" NOT NULL,
  disposition text NOT NULL,
  source_as_of timestamptz,
  registry_slugs jsonb NOT NULL,
  snapshot_ids jsonb NOT NULL,
  source_evidence jsonb NOT NULL,
  source_evidence_sha256 text NOT NULL,
  target_rank_count integer NOT NULL,
  target_identity_sha256 text NOT NULL,
  target_payload_sha256 text,
  metric_input_count integer NOT NULL,
  metric_evidence_valid_until timestamptz,
  metric_evidence_sha256 text,
  prior_score_cohort_id uuid,
  prior_rank_mutation_seq bigint,
  prior_recorded_at timestamptz,
  CONSTRAINT rank_generation_publication_plan_source_pkey
    PRIMARY KEY (season_id, generation_seq, source),
  CONSTRAINT rank_generation_publication_plan_source_cohort_key
    UNIQUE (score_cohort_id, source),
  CONSTRAINT rank_generation_publication_plan_source_contract_check
    CHECK (
      contract = 'leaderboard-rank-generation-publication-plan-source@1'
    ),
  CONSTRAINT rank_generation_publication_plan_source_season_check
    CHECK (season_id IN ('7D', '30D', '90D')),
  CONSTRAINT rank_generation_publication_plan_source_sequence_check
    CHECK (generation_seq > 0 AND generation_seq <= 9007199254740000),
  CONSTRAINT rank_generation_publication_plan_source_name_check
    CHECK (
      source ~ '^[a-z0-9]+(_[a-z0-9]+)*$'
      AND source = pg_catalog.lower(pg_catalog.btrim(source))
      AND pg_catalog.char_length(source) <= 128
    ),
  CONSTRAINT rank_generation_publication_plan_source_evidence_check
    CHECK (
      pg_catalog.jsonb_typeof(registry_slugs) = 'array'
      AND pg_catalog.jsonb_array_length(registry_slugs) > 0
      AND pg_catalog.jsonb_typeof(snapshot_ids) = 'array'
      AND pg_catalog.jsonb_typeof(source_evidence) = 'array'
      AND pg_catalog.jsonb_array_length(source_evidence) > 0
      AND pg_catalog.pg_column_size(source_evidence) <= 1048576
      AND source_evidence_sha256 ~ '^[0-9a-f]{64}$'
      AND source_evidence_sha256 = pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(source_evidence::text, 'UTF8')
        ),
        'hex'
      )
    ),
  CONSTRAINT rank_generation_publication_plan_source_target_check
    CHECK (
      target_rank_count >= 0 AND target_rank_count <= 250000
      AND target_identity_sha256 ~ '^[0-9a-f]{64}$'
      AND (
        target_payload_sha256 IS NULL
        OR target_payload_sha256 ~ '^[0-9a-f]{64}$'
      )
      AND metric_input_count >= 0
      AND metric_input_count <= 64000
      AND metric_input_count >= target_rank_count
      AND (
        metric_evidence_sha256 IS NULL
        OR metric_evidence_sha256 ~ '^[0-9a-f]{64}$'
      )
    ),
  CONSTRAINT rank_generation_publication_plan_source_state_check
    CHECK (
      (
        disposition = 'replace'
        AND source_as_of IS NOT NULL
        AND pg_catalog.isfinite(source_as_of)
        AND target_payload_sha256 IS NOT NULL
        AND (
          (
            metric_input_count = 0
            AND metric_evidence_valid_until IS NULL
            AND metric_evidence_sha256 IS NULL
          )
          OR (
            metric_input_count > 0
            AND metric_evidence_valid_until IS NOT NULL
            AND pg_catalog.isfinite(metric_evidence_valid_until)
            AND metric_evidence_sha256 IS NOT NULL
          )
        )
        AND prior_score_cohort_id IS NULL
        AND prior_rank_mutation_seq IS NULL
        AND prior_recorded_at IS NULL
      )
      OR (
        disposition = 'retain'
        AND source_as_of IS NOT NULL
        AND pg_catalog.isfinite(source_as_of)
        AND target_payload_sha256 IS NOT NULL
        AND (
          (
            metric_input_count = 0
            AND metric_evidence_valid_until IS NULL
            AND metric_evidence_sha256 IS NULL
          )
          OR (
            metric_input_count > 0
            AND metric_evidence_valid_until IS NOT NULL
            AND pg_catalog.isfinite(metric_evidence_valid_until)
            AND metric_evidence_sha256 IS NOT NULL
          )
        )
        AND prior_score_cohort_id IS NOT NULL
        AND prior_rank_mutation_seq IS NOT NULL
        AND prior_rank_mutation_seq >= 0
        AND prior_rank_mutation_seq <= 9007199254740000
        AND prior_recorded_at IS NOT NULL
        AND pg_catalog.isfinite(prior_recorded_at)
      )
      OR (
        disposition = 'unavailable'
        AND source_as_of IS NULL
        AND target_rank_count = 0
        AND target_identity_sha256 =
          '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
        AND target_payload_sha256 IS NULL
        AND metric_input_count = 0
        AND metric_evidence_valid_until IS NULL
        AND metric_evidence_sha256 IS NULL
        AND prior_score_cohort_id IS NULL
        AND prior_rank_mutation_seq IS NULL
        AND prior_recorded_at IS NULL
      )
    ),
  CONSTRAINT rank_generation_publication_plan_source_header_fkey
    FOREIGN KEY (season_id, generation_seq, score_cohort_id)
    REFERENCES arena.leaderboard_rank_generation_publication_plans (
      season_id, generation_seq, score_cohort_id
    )
    DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE arena.leaderboard_rank_generation_publication_plans
  OWNER TO postgres;
ALTER TABLE arena.leaderboard_rank_generation_publication_plan_sources
  OWNER TO postgres;

-- Default privileges can name roles that this migration does not know in
-- advance. Strip every non-owner table ACL instead of merely naming the three
-- PostgREST roles; CASCADE also removes grants delegated by those grantees.
DO $revoke_table_acl$
DECLARE
  v_table regclass;
  v_grantee oid;
  v_role_name text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'arena.leaderboard_rank_generation_publication_plans'::regclass,
    'arena.leaderboard_rank_generation_publication_plan_sources'::regclass
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

ALTER TABLE arena.leaderboard_rank_generation_publication_plans
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.leaderboard_rank_generation_publication_plan_sources
  ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION arena.guard_rank_generation_publication_plan_source_insert_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  v_current_xid xid := pg_catalog.pg_current_xact_id()::xid;
  v_current_top_xid xid8 := pg_catalog.pg_current_xact_id();
  v_header_xid xid;
  v_header_top_xid xid8;
BEGIN
  SELECT header.xmin, header.plan_write_top_xid
  INTO STRICT v_header_xid, v_header_top_xid
  FROM ONLY arena.leaderboard_rank_generation_publication_plans AS header
  WHERE header.season_id = NEW.season_id
    AND header.generation_seq = NEW.generation_seq
    AND header.score_cohort_id = NEW.score_cohort_id
  FOR KEY SHARE;

  IF v_header_xid IS DISTINCT FROM v_current_xid
     OR v_header_top_xid IS DISTINCT FROM v_current_top_xid THEN
    RAISE EXCEPTION
      'publication plan sources require their header from the current full transaction id'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
EXCEPTION
  WHEN no_data_found THEN
    RAISE EXCEPTION 'publication plan source has no exact current header'
      USING ERRCODE = '23503';
END;
$body$;


-- Rebuild the only score population that this publication contract accepts.
-- Legacy scoreRows provide the current board identity and a consistency
-- cross-check, never metric authority. Every consumed ROI, PnL, win-rate, and
-- drawdown value must come from the database-owned rankable trust views. The
-- legacy-only Sharpe, profit-factor, and trade-count fields are forced to NULL
-- so display-only or unregistered values cannot affect score or confidence.
CREATE FUNCTION arena.build_leaderboard_metric_trust_projection_v1(
  p_period text,
  p_score_rows jsonb,
  p_physical_boards jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
SET "TimeZone" = 'UTC'
SET extra_float_digits = '3'
AS $body$
DECLARE
  v_timeframe smallint;
  v_core_method_id text;
  v_ranking_method_id text;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_inputs jsonb;
  v_pair_count integer;
  v_valid_until timestamptz;
  v_chunks jsonb;
  v_source_metric_as_of jsonb;
  v_fresh_physical_row_count integer;
  v_physical_mapping_exact boolean;
  v_excluded_off_board_row_count integer;
  v_excluded_off_board_sha256 text;
  v_source_trust_evidence jsonb;
  v_pair_chunks_sha256 text;
  v_enrichment_contract constant text :=
    'leaderboard-score-metric-trust-core-projection@1';
  v_eligibility_contract constant text :=
    'leaderboard-score-trusted-roi-pnl-win-mdd-usdt@1';
  v_enrichment_evidence jsonb;
  v_eligibility_evidence jsonb;
BEGIN
  v_timeframe := CASE p_period
    WHEN '7D' THEN 7::smallint
    WHEN '30D' THEN 30::smallint
    WHEN '90D' THEN 90::smallint
    ELSE NULL::smallint
  END;
  v_core_method_id := CASE p_period
    WHEN '7D' THEN 'arena-core-roi-pnl-7d-usdt@1'
    WHEN '30D' THEN 'arena-core-roi-pnl-30d-usdt@1'
    WHEN '90D' THEN 'arena-core-roi-pnl-90d-usdt@1'
    ELSE NULL
  END;
  v_ranking_method_id := CASE p_period
    WHEN '7D' THEN 'arena-v4-roi-pnl-win-mdd-7d-usdt@1'
    WHEN '30D' THEN 'arena-v4-roi-pnl-win-mdd-30d-usdt@1'
    WHEN '90D' THEN 'arena-v4-roi-pnl-win-mdd-90d-usdt@1'
    ELSE NULL
  END;

  IF v_timeframe IS NULL
     OR p_score_rows IS NULL
     OR pg_catalog.jsonb_typeof(p_score_rows) <> 'array'
     OR pg_catalog.jsonb_array_length(p_score_rows) > 256000
     OR p_physical_boards IS NULL
     OR pg_catalog.jsonb_typeof(p_physical_boards) <> 'array'
     OR pg_catalog.jsonb_array_length(p_physical_boards) < 1
     OR pg_catalog.jsonb_array_length(p_physical_boards) > 1024 THEN
    RAISE EXCEPTION 'metric-trust score projection envelope is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_score_rows) AS score_row(value)
    WHERE pg_catalog.jsonb_typeof(score_row.value) <> 'object'
       OR NOT score_row.value ?& ARRAY[
         'platform', 'trader_key', 'board_rank', 'roi_pct', 'pnl_usd',
         'win_rate', 'max_drawdown'
       ]
       OR pg_catalog.jsonb_typeof(score_row.value->'platform') <> 'string'
       OR pg_catalog.jsonb_typeof(score_row.value->'trader_key') <> 'string'
       OR pg_catalog.jsonb_typeof(score_row.value->'board_rank')
            NOT IN ('number', 'null')
       OR pg_catalog.jsonb_typeof(score_row.value->'roi_pct')
            NOT IN ('number', 'null')
       OR pg_catalog.jsonb_typeof(score_row.value->'pnl_usd')
            NOT IN ('number', 'null')
       OR pg_catalog.jsonb_typeof(score_row.value->'win_rate')
            NOT IN ('number', 'null')
       OR pg_catalog.jsonb_typeof(score_row.value->'max_drawdown')
            NOT IN ('number', 'null')
       OR score_row.value->>'platform' !~ '^[a-z0-9]+(_[a-z0-9]+)*$'
       OR pg_catalog.char_length(score_row.value->>'platform') > 128
       OR score_row.value->>'trader_key' IS DISTINCT FROM
            pg_catalog.btrim(score_row.value->>'trader_key')
       OR pg_catalog.char_length(score_row.value->>'trader_key')
            NOT BETWEEN 1 AND 512
       OR (
         score_row.value->>'trader_key' LIKE '0x%'
         AND score_row.value->>'trader_key' IS DISTINCT FROM
             pg_catalog.lower(score_row.value->>'trader_key')
       )
       OR (score_row.value->>'board_rank')::numeric < 1
       OR (score_row.value->>'board_rank')::numeric > 1000
       OR (score_row.value->>'board_rank')::numeric IS DISTINCT FROM
            pg_catalog.trunc((score_row.value->>'board_rank')::numeric)
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_score_rows) AS score_row(value)
    GROUP BY
      score_row.value->>'platform',
      score_row.value->>'trader_key'
    HAVING pg_catalog.count(*) <> 1
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_physical_boards) AS board(value)
    WHERE pg_catalog.jsonb_typeof(board.value) <> 'object'
       OR NOT board.value ?& ARRAY[
         'registry_slug', 'filter_source', 'window', 'snapshot_id', 'scraped_at',
         'rank_limit', 'rank_limited_entry_count', 'evidence_status'
       ]
       OR pg_catalog.jsonb_typeof(board.value->'registry_slug') <> 'string'
       OR pg_catalog.jsonb_typeof(board.value->'filter_source') <> 'string'
       OR pg_catalog.jsonb_typeof(board.value->'window') <> 'string'
       OR pg_catalog.jsonb_typeof(board.value->'rank_limit') <> 'number'
       OR pg_catalog.jsonb_typeof(
            board.value->'rank_limited_entry_count'
          ) NOT IN ('number', 'null')
       OR board.value->>'window' IS DISTINCT FROM p_period
       OR (board.value->>'rank_limit')::numeric IS DISTINCT FROM 1000
       OR (
         board.value->>'evidence_status' = 'passed'
         AND (
           pg_catalog.jsonb_typeof(board.value->'snapshot_id') <> 'number'
           OR pg_catalog.jsonb_typeof(board.value->'scraped_at') <> 'string'
           OR pg_catalog.jsonb_typeof(
                board.value->'rank_limited_entry_count'
              ) <> 'number'
           OR (board.value->>'rank_limited_entry_count')::numeric < 0
           OR (board.value->>'rank_limited_entry_count')::numeric > 1000
           OR (board.value->>'rank_limited_entry_count')::numeric
                IS DISTINCT FROM pg_catalog.trunc(
                  (board.value->>'rank_limited_entry_count')::numeric
                )
         )
       )
  ) THEN
    RAISE EXCEPTION 'metric-trust score projection input is malformed'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    WITH alias_disposition AS MATERIALIZED (
      SELECT
        board.value->>'filter_source' AS source,
        pg_catalog.bool_and(board.value->>'evidence_status' = 'passed')
          AS is_fresh
      FROM pg_catalog.jsonb_array_elements(p_physical_boards) AS board(value)
      GROUP BY board.value->>'filter_source'
    ), fresh_boards AS MATERIALIZED (
      SELECT
        board.value->>'registry_slug' AS registry_slug,
        board.value->>'filter_source' AS source,
        registry.id AS physical_source_id,
        (board.value->>'snapshot_id')::bigint AS snapshot_id,
        (board.value->>'scraped_at')::timestamptz AS scraped_at,
        (board.value->>'rank_limit')::integer AS rank_limit,
        (board.value->>'rank_limited_entry_count')::integer
          AS expected_row_count
      FROM pg_catalog.jsonb_array_elements(p_physical_boards) AS board(value)
      JOIN alias_disposition AS disposition
        ON disposition.source = board.value->>'filter_source'
       AND disposition.is_fresh
      JOIN arena.sources AS registry
        ON registry.slug = board.value->>'registry_slug'
       AND COALESCE(
             NULLIF(pg_catalog.btrim(
               registry.meta->>'legacy_platform'
             ), ''),
             registry.slug
           ) = board.value->>'filter_source'
      JOIN arena.leaderboard_snapshots AS snapshot
        ON snapshot.id = (board.value->>'snapshot_id')::bigint
       AND snapshot.source_id = registry.id
       AND snapshot.timeframe = v_timeframe
       AND snapshot.scraped_at =
             (board.value->>'scraped_at')::timestamptz
       AND snapshot.count_check_passed
      WHERE board.value->>'evidence_status' = 'passed'
    ), decoded_rows AS MATERIALIZED (
      SELECT
        score_row.ordinality::integer AS row_no,
        score_row.value->>'platform' AS source,
        score_row.value->>'trader_key' AS source_trader_id,
        CASE
          WHEN pg_catalog.jsonb_typeof(score_row.value->'board_rank') = 'number'
            THEN (score_row.value->>'board_rank')::integer
          ELSE NULL::integer
        END AS board_rank,
        CASE
          WHEN pg_catalog.jsonb_typeof(score_row.value->'roi_pct') = 'number'
            THEN (score_row.value->>'roi_pct')::numeric
          ELSE NULL::numeric
        END AS raw_roi,
        CASE
          WHEN pg_catalog.jsonb_typeof(score_row.value->'pnl_usd') = 'number'
            THEN (score_row.value->>'pnl_usd')::numeric
          ELSE NULL::numeric
        END AS raw_pnl,
        CASE
          WHEN pg_catalog.jsonb_typeof(score_row.value->'win_rate') = 'number'
            THEN (score_row.value->>'win_rate')::numeric
          ELSE NULL::numeric
        END AS raw_win_rate,
        CASE
          WHEN pg_catalog.jsonb_typeof(score_row.value->'max_drawdown') = 'number'
            THEN (score_row.value->>'max_drawdown')::numeric
          ELSE NULL::numeric
        END AS raw_max_drawdown
      FROM pg_catalog.jsonb_array_elements(p_score_rows) WITH ORDINALITY
        AS score_row(value, ordinality)
    ), fresh_decoded_rows AS MATERIALIZED (
      SELECT decoded.*
      FROM decoded_rows AS decoded
      JOIN alias_disposition AS disposition
        ON disposition.source = decoded.source
       AND disposition.is_fresh
      WHERE decoded.board_rank IS NOT NULL
    ), excluded_off_board_rows AS MATERIALIZED (
      SELECT
        decoded.source,
        decoded.source_trader_id,
        pg_catalog.row_number() OVER (
          ORDER BY
            decoded.source COLLATE pg_catalog."C",
            decoded.source_trader_id COLLATE pg_catalog."C"
        ) AS position
      FROM decoded_rows AS decoded
      JOIN alias_disposition AS disposition
        ON disposition.source = decoded.source
       AND disposition.is_fresh
      WHERE decoded.board_rank IS NULL
    ), excluded_off_board_chunks AS MATERIALIZED (
      SELECT
        ((excluded.position - 1) / 1024)::integer AS chunk_index,
        pg_catalog.count(*)::integer AS row_count,
        pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to(
            pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_array(
                excluded.source,
                excluded.source_trader_id
              ) ORDER BY excluded.position
            )::text,
            'UTF8'
          )),
          'hex'
        ) AS chunk_sha256
      FROM excluded_off_board_rows AS excluded
      GROUP BY ((excluded.position - 1) / 1024)::integer
    ), excluded_off_board_summary AS MATERIALIZED (
      SELECT
        (SELECT pg_catalog.count(*)::integer FROM excluded_off_board_rows)
          AS row_count,
        pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to(
            pg_catalog.jsonb_build_array(
              'leaderboard-score-excluded-off-board-identities@1',
              p_period,
              (SELECT pg_catalog.count(*)::integer
               FROM excluded_off_board_rows),
              COALESCE(pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_array(
                  chunk.chunk_index,
                  chunk.row_count,
                  chunk.chunk_sha256
                ) ORDER BY chunk.chunk_index
              ), '[]'::jsonb)
            )::text,
            'UTF8'
          )),
          'hex'
        ) AS root_sha256
      FROM excluded_off_board_chunks AS chunk
    ), expected_entries AS MATERIALIZED (
      SELECT
        board.registry_slug,
        board.source,
        board.physical_source_id,
        board.snapshot_id AS physical_snapshot_id,
        board.scraped_at AS physical_board_as_of,
        board.expected_row_count,
        trader.id AS physical_trader_id,
        trader.exchange_trader_id AS source_trader_id,
        entry.rank AS board_rank
      FROM fresh_boards AS board
      JOIN arena.leaderboard_entries AS entry
        ON entry.snapshot_id = board.snapshot_id
       AND entry.scraped_at = board.scraped_at
       AND entry.timeframe = v_timeframe
       AND entry.rank BETWEEN 1 AND board.rank_limit
      JOIN arena.traders AS trader
        ON trader.id = entry.trader_id
       AND trader.source_id = board.physical_source_id
    ), physical_matches AS MATERIALIZED (
      SELECT
        decoded.*,
        expected.physical_source_id,
        expected.physical_trader_id,
        expected.physical_snapshot_id,
        expected.physical_board_as_of,
        pg_catalog.count(*) OVER (
          PARTITION BY decoded.row_no
        ) AS physical_match_count
      FROM fresh_decoded_rows AS decoded
      JOIN expected_entries AS expected
        ON expected.source = decoded.source
       AND expected.source_trader_id = decoded.source_trader_id
       AND expected.board_rank = decoded.board_rank
    ), mapping_summary AS MATERIALIZED (
      SELECT
        (SELECT pg_catalog.count(*)::integer FROM fresh_decoded_rows)
          AS fresh_row_count,
        (
          pg_catalog.count(*)::integer IS NOT DISTINCT FROM
            (SELECT pg_catalog.count(*)::integer FROM fresh_decoded_rows)
          AND pg_catalog.count(*)::integer IS NOT DISTINCT FROM (
            SELECT pg_catalog.count(*)::integer
            FROM expected_entries
          )
          AND (
            SELECT pg_catalog.count(*)::integer
            FROM fresh_boards
          ) IS NOT DISTINCT FROM (
            SELECT pg_catalog.count(*)::integer
            FROM pg_catalog.jsonb_array_elements(p_physical_boards)
              AS claimed_board(value)
            JOIN alias_disposition AS claimed_disposition
              ON claimed_disposition.source =
                   claimed_board.value->>'filter_source'
             AND claimed_disposition.is_fresh
            WHERE claimed_board.value->>'evidence_status' = 'passed'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM fresh_boards AS board
            LEFT JOIN LATERAL (
              SELECT pg_catalog.count(*)::integer AS current_row_count
              FROM expected_entries AS expected
              WHERE expected.physical_source_id = board.physical_source_id
                AND expected.physical_snapshot_id = board.snapshot_id
                AND expected.physical_board_as_of = board.scraped_at
            ) AS current_count ON true
            WHERE current_count.current_row_count IS DISTINCT FROM
                  board.expected_row_count
          )
          AND COALESCE(
            pg_catalog.bool_and(physical.physical_match_count = 1),
            true
          )
          AND NOT EXISTS (
            SELECT 1
            FROM physical_matches AS duplicate
            GROUP BY
              duplicate.physical_board_as_of,
              duplicate.physical_snapshot_id,
              duplicate.physical_trader_id
            HAVING pg_catalog.count(*) <> 1
          )
        ) AS mapping_exact
      FROM physical_matches AS physical
    ), candidates AS MATERIALIZED (
      SELECT
        mapped.source,
        mapped.source_trader_id,
        mapped.board_rank,
        trusted.source_id,
        trusted.trader_id,
        trusted.snapshot_id,
        trusted.source_run_id,
        trusted.source_contract_version,
        trusted.metric_set_id AS roi_pnl_metric_set_id,
        trusted.roi_observation_id,
        trusted.pnl_observation_id,
        trusted.roi_provenance,
        trusted.roi_methodology_version,
        trusted.pnl_provenance,
        trusted.pnl_methodology_version,
        win.id AS win_rate_observation_id,
        win.contract_id AS win_rate_contract_id,
        win.metric_set_id AS win_rate_metric_set_id,
        win.field_path AS win_rate_field_path,
        win.provenance AS win_rate_provenance,
        win.methodology_version AS win_rate_methodology_version,
        mdd.id AS mdd_observation_id,
        mdd.contract_id AS mdd_contract_id,
        mdd.metric_set_id AS mdd_metric_set_id,
        mdd.field_path AS mdd_field_path,
        mdd.provenance AS mdd_provenance,
        mdd.methodology_version AS mdd_methodology_version,
        trusted.roi_pct::numeric AS roi,
        trusted.pnl_usd::numeric AS pnl,
        win.value::numeric AS win_rate,
        mdd.value::numeric AS max_drawdown,
        trusted.as_of AS roi_pnl_as_of,
        win.source_as_of AS win_rate_as_of,
        mdd.source_as_of AS mdd_as_of,
        trusted.window_start,
        trusted.window_end,
        trusted.acquisition_completed_at,
        LEAST(trusted.valid_until, win.valid_until, mdd.valid_until)
          AS valid_until,
        pg_catalog.count(*) OVER (
          PARTITION BY mapped.row_no
        ) AS candidate_count
      FROM physical_matches AS mapped
      JOIN arena.metric_rankable_score_inputs_shadow AS trusted
        ON trusted.source_id = mapped.physical_source_id
       AND trusted.trader_id = mapped.physical_trader_id
       AND trusted.snapshot_id = mapped.physical_snapshot_id
       AND trusted.board_as_of = mapped.physical_board_as_of
       AND trusted.platform = mapped.source
       AND trusted.trader_key = mapped.source_trader_id
       AND trusted.board_rank = mapped.board_rank
       AND trusted."window" = p_period
       AND trusted.ranking_method_id = v_core_method_id
       AND trusted.comparison_currency = 'USDT'
       AND trusted.currency = 'USDT'
       AND trusted.rank_eligible
       AND trusted.valid_until > v_now
      JOIN arena.metric_rankable_observations AS win
        ON win.source_id = trusted.source_id
       AND win.trader_id = trusted.trader_id
       AND win.snapshot_id = trusted.snapshot_id
       AND win.source_run_id = trusted.source_run_id
       AND win.source_contract_version = trusted.source_contract_version
       AND win.metric_set_id = trusted.metric_set_id
       AND win.timeframe = v_timeframe
       AND win.currency = 'USDT'
       AND win.metric = 'win_rate'
       AND win.value_unit = 'percent'
       AND win.window_start = trusted.window_start
       AND win.window_end = trusted.window_end
       AND win.valid_until > v_now
       AND pg_catalog.abs(EXTRACT(
             EPOCH FROM (win.source_as_of - trusted.as_of)
           )) <= 300
      JOIN arena.metric_rankable_observations AS mdd
        ON mdd.source_id = trusted.source_id
       AND mdd.trader_id = trusted.trader_id
       AND mdd.snapshot_id = trusted.snapshot_id
       AND mdd.source_run_id = trusted.source_run_id
       AND mdd.source_contract_version = trusted.source_contract_version
       AND mdd.metric_set_id = trusted.metric_set_id
       AND mdd.timeframe = v_timeframe
       AND mdd.currency = 'USDT'
       AND mdd.metric = 'mdd'
       AND mdd.value_unit = 'percent'
       AND mdd.window_start = trusted.window_start
       AND mdd.window_end = trusted.window_end
       AND mdd.valid_until > v_now
       AND pg_catalog.abs(EXTRACT(
             EPOCH FROM (mdd.source_as_of - trusted.as_of)
           )) <= 300
      WHERE mapped.physical_match_count = 1
        AND mapped.raw_roi IS NOT NULL
        AND mapped.raw_roi = trusted.roi_pct
        AND mapped.raw_pnl IS NOT NULL
        AND mapped.raw_pnl = trusted.pnl_usd
        AND mapped.raw_win_rate IS NOT NULL
        AND mapped.raw_win_rate = win.value
        AND mapped.raw_max_drawdown IS NOT NULL
        -- MDD trust contracts must publish a normalized positive magnitude;
        -- this projection never guesses source sign with abs().
        AND mdd.value >= 0
        AND mapped.raw_max_drawdown = mdd.value
        AND EXTRACT(EPOCH FROM (
              GREATEST(
                trusted.as_of,
                win.source_as_of,
                mdd.source_as_of
              ) - LEAST(
                trusted.as_of,
                win.source_as_of,
                mdd.source_as_of
              )
            )) <= 300
    ), eligible AS MATERIALIZED (
      SELECT candidate.*
      FROM candidates AS candidate
      WHERE candidate.candidate_count = 1
        AND candidate.roi > -90
        AND pg_catalog.abs(candidate.roi) <= CASE p_period
              WHEN '7D' THEN 2000::numeric
              WHEN '30D' THEN 5000::numeric
              WHEN '90D' THEN 10000::numeric
            END
        AND pg_catalog.abs(candidate.roi) < 10000
        AND candidate.pnl >= -10000000
        AND candidate.pnl <= CASE
              WHEN candidate.source = 'hyperliquid' THEN 1000000000::numeric
              ELSE 100000000::numeric
            END
        -- The existing v4 scorer treats zero as missing. Excluding zero keeps
        -- this four-metric contract semantically complete for every member.
        AND candidate.win_rate > 0
        AND candidate.win_rate <= 100
        AND candidate.max_drawdown > 0
        AND candidate.max_drawdown < 100
        AND NOT (
          candidate.max_drawdown = 0
          AND pg_catalog.abs(candidate.roi) > 50
        )
        AND NOT (
          candidate.max_drawdown < 1
          AND candidate.roi > 500
        )
        AND NOT (
          candidate.max_drawdown >= 99
          AND candidate.roi > 0
        )
        AND NOT (
          candidate.win_rate = 0
          AND (candidate.roi > 10 OR candidate.pnl > 0)
        )
        AND NOT (
          candidate.win_rate >= 100
          AND (candidate.roi < -10 OR candidate.pnl < 0)
        )
        AND NOT (candidate.pnl > 500 AND candidate.roi < -50)
        AND NOT (candidate.pnl < -500 AND candidate.roi > 50)
        AND NOT (
          pg_catalog.abs(candidate.roi) > 500
          AND candidate.pnl = 0
        )
    ), ordered AS MATERIALIZED (
      SELECT
        eligible.*,
        pg_catalog.row_number() OVER (
          ORDER BY
            eligible.source COLLATE pg_catalog."C",
            eligible.source_trader_id COLLATE pg_catalog."C"
        ) AS position,
        pg_catalog.row_number() OVER (
          PARTITION BY eligible.source
          ORDER BY eligible.source_trader_id COLLATE pg_catalog."C"
        ) AS source_position,
        pg_catalog.jsonb_build_object(
          'source', eligible.source,
          'source_trader_id', eligible.source_trader_id,
          'roi', eligible.roi::double precision,
          'pnl', eligible.pnl::double precision,
          'max_drawdown', eligible.max_drawdown::double precision,
          'win_rate', eligible.win_rate::double precision,
          'sharpe_ratio', NULL::double precision,
          'profit_factor', NULL::double precision,
          'trades_count', NULL::bigint
        ) AS input_value,
        pg_catalog.jsonb_build_array(
          'leaderboard-score-metric-trust-pair@1',
          eligible.source,
          eligible.source_trader_id,
          eligible.board_rank,
          eligible.source_id,
          eligible.trader_id,
          eligible.snapshot_id,
          eligible.source_run_id,
          eligible.source_contract_version,
          eligible.roi_pnl_metric_set_id,
          eligible.roi_observation_id,
          eligible.pnl_observation_id,
          eligible.roi_provenance,
          eligible.roi_methodology_version,
          eligible.pnl_provenance,
          eligible.pnl_methodology_version,
          eligible.win_rate_observation_id,
          eligible.win_rate_contract_id,
          eligible.win_rate_metric_set_id,
          eligible.win_rate_field_path,
          eligible.win_rate_provenance,
          eligible.win_rate_methodology_version,
          eligible.mdd_observation_id,
          eligible.mdd_contract_id,
          eligible.mdd_metric_set_id,
          eligible.mdd_field_path,
          eligible.mdd_provenance,
          eligible.mdd_methodology_version,
          eligible.roi,
          eligible.pnl,
          eligible.win_rate,
          eligible.max_drawdown,
          pg_catalog.to_char(
            eligible.roi_pnl_as_of AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ),
          pg_catalog.to_char(
            eligible.win_rate_as_of AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ),
          pg_catalog.to_char(
            eligible.mdd_as_of AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ),
          pg_catalog.to_char(
            eligible.window_start AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ),
          pg_catalog.to_char(
            eligible.window_end AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ),
          pg_catalog.to_char(
            eligible.acquisition_completed_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ),
          pg_catalog.to_char(
            eligible.valid_until AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          )
        ) AS evidence_value
      FROM eligible
    ), input_summary AS MATERIALIZED (
      SELECT
        pg_catalog.count(*)::integer AS pair_count,
        COALESCE(pg_catalog.jsonb_agg(
          ordered.input_value ORDER BY ordered.position
        ), '[]'::jsonb) AS inputs,
        pg_catalog.min(ordered.valid_until) AS valid_until
      FROM ordered
    ), pair_chunks AS MATERIALIZED (
      SELECT
        ((ordered.position - 1) / 1024)::integer AS chunk_index,
        pg_catalog.count(*)::integer AS row_count,
        pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to(
            pg_catalog.jsonb_agg(
              ordered.evidence_value ORDER BY ordered.position
            )::text,
            'UTF8'
          )),
          'hex'
        ) AS chunk_sha256
      FROM ordered
      GROUP BY ((ordered.position - 1) / 1024)::integer
    ), source_pair_chunks AS MATERIALIZED (
      SELECT
        ordered.source,
        ((ordered.source_position - 1) / 1024)::integer AS chunk_index,
        pg_catalog.count(*)::integer AS row_count,
        pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to(
            pg_catalog.jsonb_agg(
              ordered.evidence_value ORDER BY ordered.source_position
            )::text,
            'UTF8'
          )),
          'hex'
        ) AS chunk_sha256
      FROM ordered
      GROUP BY
        ordered.source,
        ((ordered.source_position - 1) / 1024)::integer
    ), source_pair_plans AS MATERIALIZED (
      SELECT
        chunk.source,
        pg_catalog.sum(chunk.row_count)::integer AS input_count,
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_array(
            chunk.chunk_index,
            chunk.row_count,
            chunk.chunk_sha256
          ) ORDER BY chunk.chunk_index
        ) AS chunks
      FROM source_pair_chunks AS chunk
      GROUP BY chunk.source
    ), chunk_summary AS MATERIALIZED (
      SELECT COALESCE(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(
          pair_chunks.chunk_index,
          pair_chunks.row_count,
          pair_chunks.chunk_sha256
        ) ORDER BY pair_chunks.chunk_index
      ), '[]'::jsonb) AS chunks
      FROM pair_chunks
    ), source_metric_summary AS MATERIALIZED (
      SELECT COALESCE(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(
          source_metric.source,
          pg_catalog.to_char(
            source_metric.metric_as_of AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          )
        ) ORDER BY source_metric.source COLLATE pg_catalog."C"
      ), '[]'::jsonb) AS source_metric_as_of
      FROM (
        SELECT
          ordered.source,
          pg_catalog.min(LEAST(
            ordered.roi_pnl_as_of,
            ordered.win_rate_as_of,
            ordered.mdd_as_of
          )) AS metric_as_of
        FROM ordered
        GROUP BY ordered.source
      ) AS source_metric
    ), source_trust_summary AS MATERIALIZED (
      SELECT COALESCE(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(
          source_input.source,
          source_input.input_count,
          pg_catalog.to_char(
            source_input.metric_as_of AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ),
          pg_catalog.to_char(
            source_input.valid_until AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ),
          pg_catalog.encode(
            pg_catalog.sha256(pg_catalog.convert_to(
              pg_catalog.jsonb_build_array(
                'leaderboard-score-metric-trust-source-pairs@1',
                p_period,
                v_ranking_method_id,
                'USDT',
                source_input.source,
                source_input.input_count,
                source_input.chunks
              )::text,
              'UTF8'
            )),
            'hex'
          )
        ) ORDER BY source_input.source COLLATE pg_catalog."C"
      ), '[]'::jsonb) AS source_trust_evidence
      FROM (
        SELECT
          plan.source,
          plan.input_count,
          plan.chunks,
          pg_catalog.min(LEAST(
            ordered.roi_pnl_as_of,
            ordered.win_rate_as_of,
            ordered.mdd_as_of
          )) AS metric_as_of,
          pg_catalog.min(ordered.valid_until) AS valid_until
        FROM source_pair_plans AS plan
        JOIN ordered
          ON ordered.source = plan.source
        GROUP BY
          plan.source,
          plan.input_count,
          plan.chunks
      ) AS source_input
    )
    SELECT
      input_summary.inputs,
      input_summary.pair_count,
      input_summary.valid_until,
      chunk_summary.chunks,
      source_metric_summary.source_metric_as_of,
      mapping_summary.fresh_row_count,
      mapping_summary.mapping_exact,
      excluded_off_board_summary.row_count,
      excluded_off_board_summary.root_sha256,
      source_trust_summary.source_trust_evidence
    INTO STRICT
      v_inputs,
      v_pair_count,
      v_valid_until,
      v_chunks,
      v_source_metric_as_of,
      v_fresh_physical_row_count,
      v_physical_mapping_exact,
      v_excluded_off_board_row_count,
      v_excluded_off_board_sha256,
      v_source_trust_evidence
    FROM input_summary
    CROSS JOIN chunk_summary
    CROSS JOIN source_metric_summary
    CROSS JOIN mapping_summary
    CROSS JOIN excluded_off_board_summary
    CROSS JOIN source_trust_summary;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'metric-trust score projection cannot be decoded safely'
      USING ERRCODE = '22023';
  END;

  IF v_physical_mapping_exact IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'fresh score identities do not map one-to-one to physical board entries'
      USING ERRCODE = '23514';
  END IF;

  IF v_pair_count > 64000
     OR pg_catalog.pg_column_size(v_inputs) > 67108864 THEN
    RAISE EXCEPTION 'metric-trust score projection exceeds scorer bounds'
      USING ERRCODE = '54000';
  END IF;

  v_pair_chunks_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        'leaderboard-score-metric-trust-pair-chunks@1',
        p_period,
        v_ranking_method_id,
        'USDT',
        v_pair_count,
        v_chunks
      )::text,
      'UTF8'
    )),
    'hex'
  );

  v_enrichment_evidence := pg_catalog.jsonb_build_object(
    'identityProjection', 'leaderboard-score-publish-bundle@1',
    'metricProjection', 'arena.metric_rankable_score_inputs_shadow',
    'metricAuthority', 'arena.metric_rankable_observations',
    'freshPhysicalRowCount', v_fresh_physical_row_count,
    'excludedOffBoardRows', pg_catalog.jsonb_build_object(
      'contract', 'leaderboard-score-excluded-off-board-identities@1',
      'rowCount', v_excluded_off_board_row_count,
      'rootSha256', v_excluded_off_board_sha256
    ),
    'consumedMetrics', pg_catalog.jsonb_build_array(
      'roi', 'pnl', 'win_rate', 'mdd'
    ),
    'forcedUnknownInputs', pg_catalog.jsonb_build_array(
      'sharpe_ratio', 'profit_factor', 'trades_count'
    )
  );
  v_eligibility_evidence := pg_catalog.jsonb_build_object(
    'rankingMethodId', v_ranking_method_id,
    'comparisonCurrency', 'USDT',
    'requiredMetrics', pg_catalog.jsonb_build_array(
      'roi', 'pnl', 'win_rate', 'mdd'
    ),
    'rankablePairCount', v_pair_count,
    'rankableObservationCount', v_pair_count::bigint * 4,
    'chunkSize', 1024,
    'chunkCount', pg_catalog.jsonb_array_length(v_chunks),
    'pairChunksSha256', v_pair_chunks_sha256,
    'sourceMetricAsOf', v_source_metric_as_of,
    'sourceTrustEvidence', v_source_trust_evidence,
    'validUntil', CASE
      WHEN v_valid_until IS NULL THEN 'null'::jsonb
      ELSE pg_catalog.to_jsonb(pg_catalog.to_char(
        v_valid_until AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ))
    END
  );

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-score-metric-trust-projection@1',
    'inputCount', v_pair_count,
    'inputs', v_inputs,
    'validUntil', CASE
      WHEN v_valid_until IS NULL THEN 'null'::jsonb
      ELSE pg_catalog.to_jsonb(pg_catalog.to_char(
        v_valid_until AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ))
    END,
    'enrichmentContract', v_enrichment_contract,
    'enrichmentEvidence', v_enrichment_evidence,
    'eligibilityContract', v_eligibility_contract,
    'eligibilityEvidence', v_eligibility_evidence
  );
END;
$body$;


CREATE FUNCTION arena.seal_leaderboard_rank_generation_publication_plan_v1(
  p_season_id text,
  p_generation_seq bigint,
  p_score_cohort_id uuid,
  p_score_input_manifest_id uuid,
  p_score_input_manifest_digest text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
SET "TimeZone" = 'UTC'
SET extra_float_digits = '3'
SET lock_timeout = '10s'
AS $body$
DECLARE
  v_existing arena.leaderboard_rank_generation_publication_plans%ROWTYPE;
  v_head arena.leaderboard_rank_generation_heads%ROWTYPE;
  v_claim arena.leaderboard_rank_generation_claims%ROWTYPE;
  v_batch_zero record;
  v_receipt_zero arena.leaderboard_rank_generation_batch_receipts%ROWTYPE;
  v_binding arena.leaderboard_rank_generation_manifest_bindings%ROWTYPE;
  v_attestation record;
  v_manifest arena.leaderboard_score_input_manifests%ROWTYPE;
  v_verification jsonb;
  v_source_evidence jsonb;
  v_current_bundle jsonb;
  v_canonical_score_rows jsonb;
  v_canonical_inputs jsonb;
  v_metric_trust_projection jsonb;
  v_metric_trust_valid_until timestamptz;
  v_metric_source_as_of timestamptz;
  v_metric_source_input_count integer;
  v_metric_source_valid_until timestamptz;
  v_metric_source_evidence_sha256 text;
  v_metric_source_evidence jsonb;
  v_current_bundle_sha256 text;
  v_current_score_rows_sha256 text;
  v_current_physical_boards_sha256 text;
  v_physical_boards jsonb;
  v_rank_limit integer;
  v_fresh_aliases jsonb;
  v_retained_aliases jsonb;
  v_authority jsonb;
  v_authority_sha256 text;
  v_attestation_sha256 text;
  v_plan_sources jsonb;
  v_plan_sha256 text;
  v_source record;
  v_source_boards jsonb;
  v_registry_slugs jsonb;
  v_snapshot_ids jsonb;
  v_is_fresh boolean;
  v_source_as_of timestamptz;
  v_target_count integer;
  v_target_identities jsonb;
  v_target_identity_sha256 text;
  v_target_payload_sha256 text;
  v_freshness public.leaderboard_source_freshness%ROWTYPE;
  v_fence arena.leaderboard_rank_mutation_fences%ROWTYPE;
  v_publication arena.leaderboard_rank_publications%ROWTYPE;
  v_prior_plan arena.leaderboard_rank_generation_publication_plans%ROWTYPE;
  v_prior_source_plan
    arena.leaderboard_rank_generation_publication_plan_sources%ROWTYPE;
  v_prior_manifest arena.leaderboard_score_input_manifests%ROWTYPE;
  v_expected_proof jsonb;
  v_source_evidence_sha256 text;
  v_positive_count integer;
  v_attestation_chunk_count integer;
  v_attestation_row_count integer;
  v_attestation_chunk_plan jsonb;
  v_computed_attestation_sha256 text;
  v_source_count integer;
  v_replace_count integer;
  v_retain_count integer;
  v_unavailable_count integer;
  v_staged_count integer;
  v_retained_count bigint;
  v_target_count_total bigint;
  v_now timestamptz;
  v_planned_at timestamptz;
  v_inserted_count integer;
  v_head_locked boolean := false;
  v_current_xid xid := pg_catalog.pg_current_xact_id()::xid;
  v_current_top_xid xid8 := pg_catalog.pg_current_xact_id();
  v_empty_sha256 constant text :=
    '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'generation publication plans require READ COMMITTED isolation'
      USING ERRCODE = '25001';
  END IF;
  IF p_season_id IS NULL OR p_season_id NOT IN ('7D', '30D', '90D')
     OR p_generation_seq IS NULL
     OR p_generation_seq <= 0
     OR p_generation_seq > 9007199254740000
     OR p_score_cohort_id IS NULL
     OR p_score_input_manifest_id IS NULL
     OR p_score_input_manifest_digest IS NULL
     OR p_score_input_manifest_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'generation publication plan identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  -- A committed plan and its sources are immutable, so response-loss replay
  -- can return without entering the live lock graph. On a miss, preserve the
  -- writer's admission order: head row first, cohort advisory lock second.
  -- Recheck after both waits so a concurrent creator is observed without a
  -- uniqueness race. Taking advisory before head would permit a deadlock with
  -- the batch-zero writer, which already owns the head row.
  LOOP
    SELECT plan.*
    INTO v_existing
    FROM ONLY arena.leaderboard_rank_generation_publication_plans AS plan
    WHERE plan.score_cohort_id = p_score_cohort_id;

    IF FOUND THEN
    IF v_existing.season_id IS DISTINCT FROM p_season_id
       OR v_existing.generation_seq IS DISTINCT FROM p_generation_seq
       OR v_existing.score_input_manifest_id IS DISTINCT FROM
            p_score_input_manifest_id
       OR v_existing.score_input_manifest_digest IS DISTINCT FROM
            p_score_input_manifest_digest THEN
      RAISE EXCEPTION 'publication plan cohort was reused with different input'
        USING ERRCODE = '23505';
    END IF;

    SELECT COALESCE(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_array(
        source_row.source,
        source_row.disposition,
        CASE WHEN source_row.source_as_of IS NULL THEN NULL
          ELSE pg_catalog.to_char(
            source_row.source_as_of AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          )
        END,
        source_row.registry_slugs,
        source_row.snapshot_ids,
        source_row.source_evidence_sha256,
        source_row.target_rank_count,
        source_row.target_identity_sha256,
        source_row.target_payload_sha256,
        source_row.metric_input_count,
        CASE WHEN source_row.metric_evidence_valid_until IS NULL THEN NULL
          ELSE pg_catalog.to_char(
            source_row.metric_evidence_valid_until AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          )
        END,
        source_row.metric_evidence_sha256,
        source_row.prior_score_cohort_id,
        source_row.prior_rank_mutation_seq,
        CASE WHEN source_row.prior_recorded_at IS NULL THEN NULL
          ELSE pg_catalog.to_char(
            source_row.prior_recorded_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          )
        END
      ) ORDER BY source_row.source COLLATE pg_catalog."C"
    ), '[]'::jsonb)
    INTO STRICT v_plan_sources
    FROM ONLY arena.leaderboard_rank_generation_publication_plan_sources
      AS source_row
    WHERE source_row.season_id = v_existing.season_id
      AND source_row.generation_seq = v_existing.generation_seq
      AND source_row.score_cohort_id = v_existing.score_cohort_id;

    v_plan_sha256 := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(
        pg_catalog.jsonb_build_array(
          'leaderboard-rank-generation-publication-plan@1',
          v_existing.season_id,
          v_existing.generation_seq,
          v_existing.score_cohort_id::text,
          v_existing.score_input_manifest_id::text,
          v_existing.score_input_manifest_digest,
          v_existing.manifest_attestation_sha256,
          v_existing.authority_sha256,
          v_plan_sources
        )::text,
        'UTF8'
      )),
      'hex'
    );

    IF pg_catalog.jsonb_array_length(v_plan_sources) IS DISTINCT FROM
         v_existing.source_count
       OR v_plan_sha256 IS DISTINCT FROM v_existing.plan_sha256 THEN
      RAISE EXCEPTION 'stored generation publication plan is incomplete'
        USING ERRCODE = '55000';
    END IF;

      RETURN pg_catalog.jsonb_build_object(
      'contract', 'leaderboard-rank-generation-publication-plan-seal@1',
      'season_id', v_existing.season_id,
      'generation_seq', v_existing.generation_seq,
      'score_cohort_id', v_existing.score_cohort_id,
      'score_input_manifest_id', v_existing.score_input_manifest_id,
      'score_input_manifest_digest', v_existing.score_input_manifest_digest,
      'manifest_attestation_sha256',
        v_existing.manifest_attestation_sha256,
      'authority_sha256', v_existing.authority_sha256,
      'plan_sha256', v_existing.plan_sha256,
      'source_count', v_existing.source_count,
      'replace_source_count', v_existing.replace_source_count,
      'retain_source_count', v_existing.retain_source_count,
      'unavailable_source_count', v_existing.unavailable_source_count,
      'staged_rank_count', v_existing.staged_rank_count,
      'retained_rank_count', v_existing.retained_rank_count,
      'target_rank_count', v_existing.target_rank_count,
      'planned_at', pg_catalog.to_char(
        v_existing.planned_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'is_sealed', true
      );
    END IF;

    EXIT WHEN v_head_locked;

    SELECT head.*
    INTO STRICT v_head
    FROM ONLY arena.leaderboard_rank_generation_heads AS head
    WHERE head.season_id = p_season_id
    FOR UPDATE;
    v_head_locked := true;

    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(p_score_cohort_id::text, 0)
    );
  END LOOP;

  SELECT claim.*
  INTO STRICT v_claim
  FROM ONLY arena.leaderboard_rank_generation_claims AS claim
  WHERE claim.season_id = p_season_id
    AND claim.generation_seq = p_generation_seq
    AND claim.score_cohort_id = p_score_cohort_id
  FOR SHARE;

  IF v_claim.expected_rank_count < 1
     OR v_claim.expected_batch_count < 1 THEN
    RAISE EXCEPTION
      'publication-plan v1 requires one positive canonical generation'
      USING ERRCODE = '23514';
  END IF;

  v_now := pg_catalog.clock_timestamp();
  IF v_head.generation_seq IS DISTINCT FROM p_generation_seq
     OR v_head.score_cohort_id IS DISTINCT FROM p_score_cohort_id
     OR v_head.phase NOT IN ('claimed', 'writing')
     OR v_head.lease_expires_at IS DISTINCT FROM v_claim.lease_expires_at
     OR v_head.lease_expires_at <= v_now THEN
    RAISE EXCEPTION 'publication plan generation lease is expired or superseded'
      USING ERRCODE = '55000';
  END IF;

  SELECT stored.*
  INTO v_manifest
  FROM ONLY arena.leaderboard_score_input_manifests AS stored
  WHERE stored.manifest_id = p_score_input_manifest_id
    AND stored.manifest_digest = p_score_input_manifest_digest
    AND stored.period = p_season_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'publication plan manifest identity is unavailable'
      USING ERRCODE = '23503';
  END IF;

  v_verification := arena.verify_leaderboard_score_input_manifest_v1(
    p_score_input_manifest_id
  );
  IF v_verification->>'contract' IS DISTINCT FROM
       'leaderboard-score-input-manifest-verification@1'
     OR (v_verification->>'contentValid')::boolean IS DISTINCT FROM true
     OR (v_verification->>'valid')::boolean IS DISTINCT FROM true
     OR v_verification->>'manifestId' IS DISTINCT FROM
          p_score_input_manifest_id::text
     OR v_verification->>'manifestDigest' IS DISTINCT FROM
          p_score_input_manifest_digest
     OR v_manifest.valid_until < v_claim.lease_expires_at
     OR v_manifest.valid_until <= v_now THEN
    RAISE EXCEPTION 'publication plan requires one live verified manifest'
      USING ERRCODE = '55000';
  END IF;

  SELECT binding.*
  INTO v_binding
  FROM ONLY arena.leaderboard_rank_generation_manifest_bindings AS binding
  WHERE binding.season_id = p_season_id
    AND binding.generation_seq = p_generation_seq
  FOR SHARE;

  IF FOUND THEN
    IF v_binding.score_cohort_id IS DISTINCT FROM p_score_cohort_id
       OR v_binding.score_input_manifest_id IS DISTINCT FROM
            p_score_input_manifest_id
       OR v_binding.score_input_manifest_digest IS DISTINCT FROM
            p_score_input_manifest_digest THEN
      RAISE EXCEPTION 'publication plan manifest binding conflicts'
        USING ERRCODE = '23505';
    END IF;
  ELSE
    RAISE EXCEPTION 'positive publication plan has no immutable manifest binding'
      USING ERRCODE = '23503';
  END IF;

  BEGIN
    SELECT pg_catalog.count(*)::integer
    INTO STRICT v_positive_count
    FROM pg_catalog.jsonb_array_elements(v_manifest.manifest->'outputs')
      AS output_row(value)
    WHERE (output_row.value->>'totalScore')::numeric > 0;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'publication plan manifest outputs are malformed'
      USING ERRCODE = '22023';
  END;

  IF pg_catalog.jsonb_typeof(v_manifest.manifest->'inputs') <> 'array'
     OR pg_catalog.jsonb_typeof(v_manifest.manifest->'outputs') <> 'array'
     OR pg_catalog.jsonb_array_length(v_manifest.manifest->'inputs')
          IS DISTINCT FROM
        pg_catalog.jsonb_array_length(v_manifest.manifest->'outputs')
     OR v_positive_count IS DISTINCT FROM v_claim.expected_rank_count THEN
    RAISE EXCEPTION 'publication plan manifest population conflicts with claim'
      USING ERRCODE = '23514';
  END IF;

  SELECT header.*, header.xmin AS tuple_xmin
    INTO v_attestation
    FROM ONLY arena.leaderboard_rank_manifest_attestations AS header
    WHERE header.season_id = p_season_id
      AND header.generation_seq = p_generation_seq
      AND header.score_cohort_id = p_score_cohort_id
      AND header.score_input_manifest_id = p_score_input_manifest_id
      AND header.score_input_manifest_digest = p_score_input_manifest_digest;
    IF NOT FOUND
       OR v_attestation.tuple_xmin IS DISTINCT FROM v_current_xid
       OR v_attestation.contract IS DISTINCT FROM
            'leaderboard-rank-manifest-attestation@1'
       OR v_attestation.positive_count IS DISTINCT FROM v_positive_count
       OR v_attestation.chunk_count IS DISTINCT FROM
            v_claim.expected_batch_count
       OR v_attestation.manifest_valid_until IS DISTINCT FROM
            v_manifest.valid_until
       OR v_attestation.chunks_sha256 !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION
        'publication plan requires the batch-zero manifest attestation'
        USING ERRCODE = '55000';
    END IF;

    SELECT
      pg_catalog.count(*)::integer,
      COALESCE(pg_catalog.sum(chunk.row_count), 0)::integer,
      COALESCE(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(
          chunk.chunk_index,
          chunk.first_position,
          chunk.row_count,
          chunk.chunk_sha256
        ) ORDER BY chunk.chunk_index
      ), '[]'::jsonb)
    INTO STRICT
      v_attestation_chunk_count,
      v_attestation_row_count,
      v_attestation_chunk_plan
    FROM ONLY arena.leaderboard_rank_manifest_attestation_chunks AS chunk
    WHERE chunk.season_id = p_season_id
      AND chunk.generation_seq = p_generation_seq
      AND chunk.score_cohort_id = p_score_cohort_id
      AND chunk.score_input_manifest_id = p_score_input_manifest_id
      AND chunk.score_input_manifest_digest = p_score_input_manifest_digest;

    v_computed_attestation_sha256 :=
      arena.build_leaderboard_rank_manifest_chunks_sha256_v1(
        p_season_id,
        p_generation_seq,
        p_score_cohort_id,
        p_score_input_manifest_id,
        p_score_input_manifest_digest,
        v_positive_count,
        v_claim.expected_batch_count,
        v_attestation_chunk_plan
      );
    IF v_attestation_chunk_count IS DISTINCT FROM
         v_claim.expected_batch_count
       OR v_attestation_row_count IS DISTINCT FROM v_positive_count
       OR v_computed_attestation_sha256 IS DISTINCT FROM
            v_attestation.chunks_sha256
       OR EXISTS (
         SELECT 1
         FROM ONLY arena.leaderboard_rank_manifest_attestation_chunks AS chunk
         WHERE chunk.season_id = p_season_id
           AND chunk.generation_seq = p_generation_seq
           AND chunk.score_cohort_id = p_score_cohort_id
           AND chunk.score_input_manifest_id = p_score_input_manifest_id
           AND chunk.score_input_manifest_digest =
                p_score_input_manifest_digest
           AND NOT arena.leaderboard_rank_manifest_attestation_chunk_is_valid_v1(
             chunk.season_id,
             chunk.generation_seq,
             chunk.score_cohort_id,
             chunk.score_input_manifest_id,
             chunk.score_input_manifest_digest,
             chunk.chunk_index,
             chunk.first_position,
             chunk.row_count,
             chunk.identities,
             chunk.field_commitments,
             chunk.chunk_sha256
           )
       ) THEN
      RAISE EXCEPTION 'publication plan attestation chunk plan is incomplete'
        USING ERRCODE = '23514';
    END IF;
  v_attestation_sha256 := v_attestation.chunks_sha256;

  SELECT batch.*, batch.xmin AS tuple_xmin
    INTO v_batch_zero
    FROM ONLY arena.leaderboard_rank_generation_stage_batches AS batch
    WHERE batch.season_id = p_season_id
      AND batch.generation_seq = p_generation_seq
      AND batch.score_cohort_id = p_score_cohort_id
      AND batch.batch_index = 0;
  IF NOT FOUND
       OR v_batch_zero.tuple_xmin IS DISTINCT FROM v_current_xid
       OR v_batch_zero.stage_write_top_xid IS DISTINCT FROM v_current_top_xid
       OR v_head.phase <> 'writing' THEN
      RAISE EXCEPTION
        'positive publication plan must be sealed by its batch-zero top-level transaction'
        USING ERRCODE = '55000';
  END IF;

  SELECT receipt.*
    INTO v_receipt_zero
    FROM ONLY arena.leaderboard_rank_generation_batch_receipts AS receipt
    WHERE receipt.season_id = p_season_id
      AND receipt.generation_seq = p_generation_seq
      AND receipt.score_cohort_id = p_score_cohort_id
      AND receipt.batch_index = 0;
  IF NOT FOUND
       OR v_receipt_zero.score_input_manifest_id IS DISTINCT FROM
            p_score_input_manifest_id
       OR v_receipt_zero.score_input_manifest_digest IS DISTINCT FROM
            p_score_input_manifest_digest
       OR v_receipt_zero.batch_sha256 IS DISTINCT FROM
            v_batch_zero.batch_sha256
       OR v_receipt_zero.row_count IS DISTINCT FROM v_batch_zero.row_count THEN
      RAISE EXCEPTION 'publication plan batch-zero receipt conflicts'
        USING ERRCODE = '23514';
  END IF;

  v_source_evidence := v_manifest.manifest->'source'->'evidence';
  IF v_source_evidence IS NULL
     OR pg_catalog.jsonb_typeof(v_source_evidence) <> 'object'
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.jsonb_object_keys(v_source_evidence)
     ) <> 3
     OR NOT v_source_evidence ?& ARRAY[
       'freshAliases', 'retainedAliases', 'physicalBoards'
     ]
     OR pg_catalog.jsonb_typeof(v_source_evidence->'freshAliases') <>
          'array'
     OR pg_catalog.jsonb_typeof(v_source_evidence->'retainedAliases') <>
          'array'
     OR pg_catalog.jsonb_typeof(v_source_evidence->'physicalBoards') <>
          'array'
     OR pg_catalog.jsonb_array_length(
          v_source_evidence->'physicalBoards'
        ) < 1
     OR pg_catalog.jsonb_array_length(
          v_source_evidence->'physicalBoards'
        ) > 1024 THEN
    RAISE EXCEPTION 'publication source evidence has an invalid envelope'
      USING ERRCODE = '22023';
  END IF;

  v_physical_boards := v_source_evidence->'physicalBoards';
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(v_physical_boards) AS board(value)
    WHERE pg_catalog.jsonb_typeof(board.value) <> 'object'
       OR (
         SELECT pg_catalog.count(*)
         FROM pg_catalog.jsonb_object_keys(board.value)
       ) <> 14
       OR NOT board.value ?& ARRAY[
         'registry_slug',
         'filter_source',
         'window',
         'snapshot_id',
         'scraped_at',
         'actual_count',
         'entry_count',
         'rank_limit',
         'rank_limited_entry_count',
         'latest_passed_tie_count',
         'evidence_status',
         'latest_attempt_id',
         'latest_attempt_scraped_at',
         'latest_attempt_passed'
       ]
       OR pg_catalog.jsonb_typeof(board.value->'registry_slug') <> 'string'
       OR pg_catalog.jsonb_typeof(board.value->'filter_source') <> 'string'
       OR pg_catalog.jsonb_typeof(board.value->'window') <> 'string'
       OR pg_catalog.jsonb_typeof(board.value->'rank_limit') <> 'number'
       OR board.value->>'registry_slug' !~ '^[a-z0-9]+(_[a-z0-9]+)*$'
       OR board.value->>'filter_source' !~ '^[a-z0-9]+(_[a-z0-9]+)*$'
       OR pg_catalog.char_length(board.value->>'registry_slug') > 128
       OR pg_catalog.char_length(board.value->>'filter_source') > 128
       OR board.value->>'window' IS DISTINCT FROM p_season_id
       OR board.value->>'evidence_status' NOT IN (
         'passed',
         'missing',
         'failed',
         'future',
         'stale',
         'entry_count_mismatch',
         'ambiguous_latest',
         'latest_attempt_failed'
       )
  ) OR EXISTS (
    SELECT board.value->>'registry_slug'
    FROM pg_catalog.jsonb_array_elements(v_physical_boards) AS board(value)
    GROUP BY board.value->>'registry_slug'
    HAVING pg_catalog.count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'publication physical-board evidence is malformed'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    SELECT
      pg_catalog.min((board.value->>'rank_limit')::integer),
      pg_catalog.max((board.value->>'rank_limit')::integer)
    INTO STRICT v_rank_limit, v_inserted_count
    FROM pg_catalog.jsonb_array_elements(v_physical_boards) AS board(value);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'publication physical-board rank limit is malformed'
      USING ERRCODE = '22023';
  END;
  IF v_rank_limit IS DISTINCT FROM 1000
     OR v_inserted_count IS DISTINCT FROM v_rank_limit THEN
    RAISE EXCEPTION
      'publication physical boards require the canonical 1000-row source limit'
      USING ERRCODE = '22023';
  END IF;

  -- Freeze registry authority before rebuilding the current physical bundle.
  -- The bundle is one statement snapshot; exact JSON equality proves the
  -- manifest did not invent or omit board evidence, aliases, or watermarks.
  LOCK TABLE
    arena.sources,
    arena.exchanges,
    arena.traders,
    arena.leaderboard_snapshots,
    arena.leaderboard_entries
  IN SHARE MODE;

  v_current_bundle := public.arena_score_inputs_publish_bundle_json(
    p_season_id,
    v_rank_limit,
    48
  );
  IF pg_catalog.jsonb_typeof(v_current_bundle) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'current database publication bundle is not an object'
      USING ERRCODE = '55000';
  END IF;
  IF v_current_bundle->'physicalBoards' IS DISTINCT FROM v_physical_boards THEN
    RAISE EXCEPTION
      'publication manifest physical boards are not the current database bundle'
      USING
        ERRCODE = '55000',
        DETAIL = pg_catalog.format(
          'rank_limit=%s manifest_sha256=%s current_sha256=%s',
          v_rank_limit,
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            v_physical_boards::text,
            'UTF8'
          )), 'hex'),
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            (v_current_bundle->'physicalBoards')::text,
            'UTF8'
          )), 'hex')
        );
  END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(fresh.source ORDER BY fresh.source
      COLLATE pg_catalog."C"), '[]'::jsonb)
  INTO STRICT v_fresh_aliases
  FROM (
    SELECT board.value->>'filter_source' AS source
    FROM pg_catalog.jsonb_array_elements(v_physical_boards) AS board(value)
    GROUP BY board.value->>'filter_source'
    HAVING pg_catalog.bool_and(board.value->>'evidence_status' = 'passed')
  ) AS fresh;

  SELECT COALESCE(pg_catalog.jsonb_agg(retained.source
      ORDER BY retained.source COLLATE pg_catalog."C"), '[]'::jsonb)
  INTO STRICT v_retained_aliases
  FROM (
    SELECT board.value->>'filter_source' AS source
    FROM pg_catalog.jsonb_array_elements(v_physical_boards) AS board(value)
    GROUP BY board.value->>'filter_source'
    HAVING NOT pg_catalog.bool_and(
      board.value->>'evidence_status' = 'passed'
    )
  ) AS retained;

  IF v_source_evidence->'freshAliases' IS DISTINCT FROM v_fresh_aliases
     OR v_source_evidence->'retainedAliases' IS DISTINCT FROM
          v_retained_aliases THEN
    RAISE EXCEPTION 'publication alias disposition is not canonical'
      USING ERRCODE = '23514';
  END IF;

  -- A manifest must equal the complete DB-owned eligible projection, not a
  -- caller-selected subset. First prove that the current score-row query is
  -- identity-unique and exactly covers every rank-bounded row on each fresh
  -- physical board. Rows from a retained board remain bound into the raw
  -- bundle digest but never enter the current scorer projection. Partial
  -- observations stay available upstream but are absent from the cohort.
  IF pg_catalog.jsonb_typeof(v_current_bundle->'scoreRows') <> 'array'
     OR pg_catalog.jsonb_array_length(v_current_bundle->'scoreRows') > 256000
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_array_elements(v_current_bundle->'scoreRows')
         AS score_row(value)
       WHERE pg_catalog.jsonb_typeof(score_row.value) <> 'object'
          OR NOT score_row.value ?& ARRAY[
            'platform',
            'trader_key',
            'board_rank',
            'roi_pct',
            'pnl_usd',
            'win_rate',
            'max_drawdown',
            'sharpe_ratio',
            'trades_count'
          ]
          OR pg_catalog.jsonb_typeof(score_row.value->'platform') <> 'string'
          OR pg_catalog.jsonb_typeof(score_row.value->'trader_key') <> 'string'
          OR pg_catalog.jsonb_typeof(score_row.value->'board_rank')
               NOT IN ('number', 'null')
          OR (score_row.value->>'board_rank')::numeric < 1
          OR (score_row.value->>'board_rank')::numeric > v_rank_limit
          OR (score_row.value->>'board_rank')::numeric IS DISTINCT FROM
               pg_catalog.trunc((score_row.value->>'board_rank')::numeric)
          OR score_row.value->>'platform' !~
               '^[a-z0-9]+(_[a-z0-9]+)*$'
          OR pg_catalog.char_length(score_row.value->>'platform') > 128
          OR score_row.value->>'trader_key' IS DISTINCT FROM
               pg_catalog.btrim(score_row.value->>'trader_key')
          OR pg_catalog.char_length(score_row.value->>'trader_key') NOT BETWEEN 1 AND 512
          OR (
            score_row.value->>'trader_key' LIKE '0x%'
            AND score_row.value->>'trader_key' IS DISTINCT FROM
                pg_catalog.lower(score_row.value->>'trader_key')
          )
          OR pg_catalog.jsonb_typeof(score_row.value->'roi_pct')
               NOT IN ('number', 'null')
          OR pg_catalog.jsonb_typeof(score_row.value->'pnl_usd')
               NOT IN ('number', 'null')
          OR pg_catalog.jsonb_typeof(score_row.value->'win_rate')
               NOT IN ('number', 'null')
          OR pg_catalog.jsonb_typeof(score_row.value->'max_drawdown')
               NOT IN ('number', 'null')
          OR pg_catalog.jsonb_typeof(score_row.value->'sharpe_ratio')
               NOT IN ('number', 'null')
          OR pg_catalog.jsonb_typeof(score_row.value->'trades_count')
               NOT IN ('number', 'null')
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_array_elements(v_current_bundle->'scoreRows')
         AS score_row(value)
       GROUP BY
         score_row.value->>'platform',
         score_row.value->>'trader_key'
       HAVING pg_catalog.count(*) <> 1
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_array_elements(v_current_bundle->'scoreRows')
         AS score_row(value)
       WHERE NOT EXISTS (
         SELECT 1
         FROM pg_catalog.jsonb_array_elements(v_physical_boards)
           AS board(value)
         WHERE board.value->>'filter_source' =
               score_row.value->>'platform'
       )
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_array_elements_text(v_fresh_aliases)
         AS fresh(source)
       WHERE (
         SELECT pg_catalog.count(*)::bigint
         FROM pg_catalog.jsonb_array_elements(v_current_bundle->'scoreRows')
           AS score_row(value)
         WHERE score_row.value->>'platform' = fresh.source
           AND pg_catalog.jsonb_typeof(score_row.value->'board_rank') = 'number'
       ) IS DISTINCT FROM (
         SELECT COALESCE(
           pg_catalog.sum(
             (board.value->>'rank_limited_entry_count')::bigint
           ),
           0
         )::bigint
         FROM pg_catalog.jsonb_array_elements(v_physical_boards)
           AS board(value)
         WHERE board.value->>'filter_source' = fresh.source
           AND board.value->>'evidence_status' = 'passed'
       )
     ) THEN
    RAISE EXCEPTION
      'current database score rows are not one complete fresh-board population'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      score_row.value
      ORDER BY
        (score_row.value->>'platform') COLLATE pg_catalog."C",
        (score_row.value->>'trader_key') COLLATE pg_catalog."C"
    ),
    '[]'::jsonb
  )
  INTO STRICT v_canonical_score_rows
  FROM pg_catalog.jsonb_array_elements(v_current_bundle->'scoreRows')
    AS score_row(value);

  v_metric_trust_projection :=
    arena.build_leaderboard_metric_trust_projection_v1(
      p_season_id,
      v_canonical_score_rows,
      v_current_bundle->'physicalBoards'
    );
  IF pg_catalog.jsonb_typeof(v_metric_trust_projection) <> 'object'
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.jsonb_object_keys(v_metric_trust_projection)
     ) <> 8
     OR NOT v_metric_trust_projection ?& ARRAY[
       'contract', 'inputCount', 'inputs', 'validUntil',
       'enrichmentContract', 'enrichmentEvidence',
       'eligibilityContract', 'eligibilityEvidence'
     ]
     OR v_metric_trust_projection->>'contract' IS DISTINCT FROM
          'leaderboard-score-metric-trust-projection@1'
     OR pg_catalog.jsonb_typeof(v_metric_trust_projection->'inputs') <>
          'array'
     OR pg_catalog.jsonb_typeof(
          v_metric_trust_projection->'enrichmentEvidence'
        ) <> 'object'
     OR pg_catalog.jsonb_typeof(
          v_metric_trust_projection->'eligibilityEvidence'
        ) <> 'object' THEN
    RAISE EXCEPTION 'database metric-trust projection is malformed'
      USING ERRCODE = '55000';
  END IF;
  v_canonical_inputs := v_metric_trust_projection->'inputs';
  BEGIN
    v_metric_trust_valid_until :=
      (v_metric_trust_projection->>'validUntil')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'database metric-trust validity is malformed'
      USING ERRCODE = '55000';
  END;
  IF v_metric_trust_valid_until IS NULL
     OR NOT pg_catalog.isfinite(v_metric_trust_valid_until)
     OR v_metric_trust_valid_until <= v_now
     OR v_manifest.valid_until > v_metric_trust_valid_until THEN
    RAISE EXCEPTION
      'publication manifest outlives its consumed metric-trust evidence'
      USING ERRCODE = '23514';
  END IF;

  v_current_score_rows_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      v_canonical_score_rows::text,
      'UTF8'
    )),
    'hex'
  );
  v_current_physical_boards_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      (v_current_bundle->'physicalBoards')::text,
      'UTF8'
    )),
    'hex'
  );
  v_current_bundle_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        'leaderboard-score-publish-bundle@1',
        p_season_id,
        v_rank_limit,
        48,
        v_canonical_score_rows,
        v_current_bundle->'physicalBoards'
      )::text,
      'UTF8'
    )),
    'hex'
  );

  IF v_manifest.manifest->'inputs' IS DISTINCT FROM v_canonical_inputs
     OR (v_manifest.manifest->>'inputCount')::integer IS DISTINCT FROM
          (v_metric_trust_projection->>'inputCount')::integer
     OR v_manifest.manifest->'enrichment'->>'contract' IS DISTINCT FROM
          v_metric_trust_projection->>'enrichmentContract'
     OR v_manifest.manifest->'enrichment'->'evidence' IS DISTINCT FROM
          v_metric_trust_projection->'enrichmentEvidence'
     OR v_manifest.manifest->'eligibility'->>'contract' IS DISTINCT FROM
          v_metric_trust_projection->>'eligibilityContract'
     OR v_manifest.manifest->'eligibility'->'evidence' IS DISTINCT FROM
          v_metric_trust_projection->'eligibilityEvidence'
     OR v_manifest.manifest->'source'->>'scoreRowsDigest'
          IS DISTINCT FROM v_current_score_rows_sha256
     OR v_manifest.manifest->'source'->>'physicalBoardsDigest'
          IS DISTINCT FROM v_current_physical_boards_sha256
     OR v_manifest.manifest->'source'->>'sourceBundleDigest'
          IS DISTINCT FROM v_current_bundle_sha256 THEN
    RAISE EXCEPTION
      'publication manifest is not the exact current canonical scorer population'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_array(
      authority.source,
      authority.registry_slugs
    ) ORDER BY authority.source COLLATE pg_catalog."C"
  ), '[]'::jsonb)
  INTO STRICT v_authority
  FROM (
    SELECT
      expected.filter_source AS source,
      pg_catalog.jsonb_agg(
        expected.registry_slug
        ORDER BY expected.registry_slug COLLATE pg_catalog."C"
      ) AS registry_slugs
    FROM public.arena_freshness_expected_sources() AS expected
    WHERE expected.season_id = p_season_id
    GROUP BY expected.filter_source
  ) AS authority;

  IF pg_catalog.jsonb_array_length(v_authority) < 1
     OR pg_catalog.jsonb_array_length(v_authority) > 256
     OR EXISTS (
       WITH expected AS MATERIALIZED (
         SELECT
           authority_row.value->>0 AS source,
           authority_row.value->1 AS registry_slugs
         FROM pg_catalog.jsonb_array_elements(v_authority)
           AS authority_row(value)
       ), observed AS MATERIALIZED (
         SELECT
           board.value->>'filter_source' AS source,
           pg_catalog.jsonb_agg(
             board.value->>'registry_slug'
             ORDER BY (board.value->>'registry_slug') COLLATE pg_catalog."C"
           ) AS registry_slugs
         FROM pg_catalog.jsonb_array_elements(v_physical_boards)
           AS board(value)
         GROUP BY board.value->>'filter_source'
       ), differences AS (
         (SELECT expected.source, expected.registry_slugs FROM expected
          EXCEPT
          SELECT observed.source, observed.registry_slugs FROM observed)
         UNION ALL
         (SELECT observed.source, observed.registry_slugs FROM observed
          EXCEPT
          SELECT expected.source, expected.registry_slugs FROM expected)
       )
       SELECT 1 FROM differences
     ) THEN
    RAISE EXCEPTION
      'publication physical boards do not exactly cover season authority'
      USING ERRCODE = '23514';
  END IF;

  v_authority_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        'leaderboard-rank-generation-publication-authority@1',
        p_season_id,
        v_authority
      )::text,
      'UTF8'
    )),
    'hex'
  );

  IF EXISTS (
    WITH positive AS MATERIALIZED (
      SELECT identity.value->>0 AS source
      FROM ONLY arena.leaderboard_rank_manifest_attestation_chunks AS chunk
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(chunk.identities)
        AS identity(value)
      WHERE chunk.season_id = p_season_id
        AND chunk.generation_seq = p_generation_seq
        AND chunk.score_cohort_id = p_score_cohort_id
    ), fresh AS MATERIALIZED (
      SELECT alias.value AS source
      FROM pg_catalog.jsonb_array_elements_text(v_fresh_aliases)
        AS alias(value)
    )
    SELECT 1
    FROM positive
    LEFT JOIN fresh USING (source)
    WHERE fresh.source IS NULL
  ) THEN
    RAISE EXCEPTION 'positive scorer output belongs to a retained source'
      USING ERRCODE = '23514';
  END IF;

  -- One owner transaction may append batch zero for more than one season.
  -- Rebuild the session-local workspace on every new-path seal so a prior
  -- invocation cannot collide with or contaminate the next source plan.
  DROP TABLE IF EXISTS pg_temp.leaderboard_rank_publication_plan_work;
  CREATE TEMP TABLE leaderboard_rank_publication_plan_work (
    source text COLLATE pg_catalog."C" PRIMARY KEY,
    disposition text NOT NULL,
    source_as_of timestamptz,
    registry_slugs jsonb NOT NULL,
    snapshot_ids jsonb NOT NULL,
    source_evidence jsonb NOT NULL,
    source_evidence_sha256 text NOT NULL,
    target_rank_count integer NOT NULL,
    target_identity_sha256 text NOT NULL,
    target_payload_sha256 text,
    metric_input_count integer NOT NULL DEFAULT 0,
    metric_evidence_valid_until timestamptz,
    metric_evidence_sha256 text,
    prior_score_cohort_id uuid,
    prior_rank_mutation_seq bigint,
    prior_recorded_at timestamptz
  ) ON COMMIT DROP;

  -- Freeze the current serving preimage before classifying retained sources.
  -- Rank DML takes RowExclusiveLock before its AFTER trigger locks a fence, so
  -- the rank parent must be locked before any fence row here as well.
  LOCK TABLE public.leaderboard_ranks IN SHARE MODE;

  PERFORM fence.source
  FROM ONLY arena.leaderboard_rank_mutation_fences AS fence
  JOIN pg_catalog.jsonb_array_elements(v_authority) AS authority(value)
    ON authority.value->>0 = fence.source
  WHERE fence.season_id = p_season_id
  ORDER BY fence.source COLLATE pg_catalog."C"
  FOR UPDATE OF fence;

  PERFORM freshness.source
  FROM ONLY public.leaderboard_source_freshness AS freshness
  JOIN pg_catalog.jsonb_array_elements(v_authority) AS authority(value)
    ON authority.value->>0 = freshness.source
  WHERE freshness.season_id = p_season_id
  ORDER BY freshness.source COLLATE pg_catalog."C"
  FOR UPDATE OF freshness;

  FOR v_source IN
    SELECT
      authority_row.value->>0 AS source,
      authority_row.value->1 AS registry_slugs
    FROM pg_catalog.jsonb_array_elements(v_authority)
      AS authority_row(value)
    ORDER BY (authority_row.value->>0) COLLATE pg_catalog."C"
  LOOP
    SELECT
      pg_catalog.jsonb_agg(
        board.value
        ORDER BY (board.value->>'registry_slug') COLLATE pg_catalog."C"
      ),
      COALESCE(pg_catalog.jsonb_agg(
        (board.value->>'snapshot_id')::bigint
        ORDER BY (board.value->>'snapshot_id')::bigint
      ) FILTER (
        WHERE pg_catalog.jsonb_typeof(board.value->'snapshot_id') = 'number'
      ), '[]'::jsonb),
      pg_catalog.bool_and(board.value->>'evidence_status' = 'passed')
    INTO STRICT v_source_boards, v_snapshot_ids, v_is_fresh
    FROM pg_catalog.jsonb_array_elements(v_physical_boards) AS board(value)
    WHERE board.value->>'filter_source' = v_source.source;

    IF v_source_boards IS NULL OR v_is_fresh IS NULL THEN
      RAISE EXCEPTION 'authority source has no physical-board evidence: %',
        v_source.source
        USING ERRCODE = '23514';
    END IF;

    v_registry_slugs := v_source.registry_slugs;
    v_source_evidence_sha256 := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(v_source_boards::text, 'UTF8')),
      'hex'
    );

    IF v_is_fresh THEN
      BEGIN
        SELECT pg_catalog.min((board.value->>'scraped_at')::timestamptz)
        INTO STRICT v_source_as_of
        FROM pg_catalog.jsonb_array_elements(v_source_boards) AS board(value);
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'fresh source has an invalid source_as_of: %',
          v_source.source
          USING ERRCODE = '22023';
      END;

      IF v_source_as_of IS NULL
         OR NOT pg_catalog.isfinite(v_source_as_of)
         OR v_source_as_of > v_now + interval '5 minutes' THEN
        RAISE EXCEPTION 'fresh source has an unsafe source_as_of: %',
          v_source.source
          USING ERRCODE = '22023';
      END IF;

      WITH positive AS MATERIALIZED (
        SELECT identity.value->>1 AS source_trader_id
        FROM ONLY arena.leaderboard_rank_manifest_attestation_chunks AS chunk
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(chunk.identities)
          AS identity(value)
        WHERE chunk.season_id = p_season_id
          AND chunk.generation_seq = p_generation_seq
          AND chunk.score_cohort_id = p_score_cohort_id
          AND identity.value->>0 = v_source.source
      )
      SELECT
        pg_catalog.count(*)::integer,
        COALESCE(pg_catalog.jsonb_agg(
          positive.source_trader_id
          ORDER BY positive.source_trader_id COLLATE pg_catalog."C"
        ), '[]'::jsonb)
      INTO STRICT v_target_count, v_target_identities
      FROM positive;

      v_target_identity_sha256 := pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(
          v_target_identities::text,
          'UTF8'
        )),
        'hex'
      );

      v_metric_source_input_count := 0;
      v_metric_source_as_of := NULL;
      v_metric_source_valid_until := NULL;
      v_metric_source_evidence_sha256 := NULL;
      v_metric_source_evidence := NULL;
      BEGIN
        SELECT source_metric.value
        INTO STRICT v_metric_source_evidence
        FROM pg_catalog.jsonb_array_elements(
          v_metric_trust_projection->'eligibilityEvidence'->
            'sourceTrustEvidence'
        ) AS source_metric(value)
        WHERE source_metric.value->>0 = v_source.source;

        IF pg_catalog.jsonb_typeof(v_metric_source_evidence) <> 'array'
           OR pg_catalog.jsonb_array_length(v_metric_source_evidence) <> 5
           OR pg_catalog.jsonb_typeof(v_metric_source_evidence->0) <> 'string'
           OR pg_catalog.jsonb_typeof(v_metric_source_evidence->1) <> 'number'
           OR pg_catalog.jsonb_typeof(v_metric_source_evidence->2) <> 'string'
           OR pg_catalog.jsonb_typeof(v_metric_source_evidence->3) <> 'string'
           OR pg_catalog.jsonb_typeof(v_metric_source_evidence->4) <> 'string'
           OR v_metric_source_evidence->>0 IS DISTINCT FROM
                v_source.source THEN
          RAISE EXCEPTION 'source trust evidence shape is invalid';
        END IF;

        v_metric_source_input_count :=
          (v_metric_source_evidence->>1)::integer;
        v_metric_source_as_of :=
          (v_metric_source_evidence->>2)::timestamptz;
        v_metric_source_valid_until :=
          (v_metric_source_evidence->>3)::timestamptz;
        v_metric_source_evidence_sha256 :=
          v_metric_source_evidence->>4;
      EXCEPTION
        WHEN NO_DATA_FOUND THEN
          v_metric_source_input_count := 0;
          v_metric_source_as_of := NULL;
          v_metric_source_valid_until := NULL;
          v_metric_source_evidence_sha256 := NULL;
        WHEN OTHERS THEN
          RAISE EXCEPTION
            'fresh source metric trust evidence is malformed: %',
            v_source.source
            USING ERRCODE = '22023';
      END;
      IF v_metric_source_input_count < 0
         OR v_metric_source_input_count > 64000
         OR v_target_count > v_metric_source_input_count
         OR (
           v_metric_source_input_count = 0
           AND pg_catalog.num_nonnulls(
             v_metric_source_as_of,
             v_metric_source_valid_until,
             v_metric_source_evidence_sha256
           ) <> 0
         )
         OR (
           v_metric_source_input_count > 0
           AND (
             v_metric_source_as_of IS NULL
             OR NOT pg_catalog.isfinite(v_metric_source_as_of)
             OR v_metric_source_as_of > v_now + interval '5 minutes'
             OR v_metric_source_valid_until IS NULL
             OR NOT pg_catalog.isfinite(v_metric_source_valid_until)
             OR v_metric_source_valid_until < v_claim.lease_expires_at
             OR v_metric_source_evidence_sha256 !~ '^[0-9a-f]{64}$'
           )
         ) THEN
        RAISE EXCEPTION
          'fresh source metric trust evidence is incomplete: %',
          v_source.source
          USING ERRCODE = '23514';
      END IF;
      IF v_metric_source_as_of IS NOT NULL THEN
        v_source_as_of := LEAST(v_source_as_of, v_metric_source_as_of);
      END IF;

      -- Bind the exact attested scoring fields per source. This same bounded
      -- digest is rebuilt from live rows before any later generation may
      -- retain them; identities alone cannot prove metric integrity.
      WITH attested AS MATERIALIZED (
        SELECT
          identity.value->>1 AS source_trader_id,
          commitment.value#>>'{}' AS field_commitment
        FROM ONLY arena.leaderboard_rank_manifest_attestation_chunks AS chunk
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(chunk.identities)
          WITH ORDINALITY AS identity(value, ordinality)
        JOIN LATERAL pg_catalog.jsonb_array_elements(chunk.field_commitments)
          WITH ORDINALITY AS commitment(value, ordinality)
          ON commitment.ordinality = identity.ordinality
        WHERE chunk.season_id = p_season_id
          AND chunk.generation_seq = p_generation_seq
          AND chunk.score_cohort_id = p_score_cohort_id
          AND chunk.score_input_manifest_id = p_score_input_manifest_id
          AND chunk.score_input_manifest_digest =
                p_score_input_manifest_digest
          AND identity.value->>0 = v_source.source
      ), ordered AS MATERIALIZED (
        SELECT
          attested.source_trader_id,
          attested.field_commitment,
          pg_catalog.row_number() OVER (
            ORDER BY attested.source_trader_id COLLATE pg_catalog."C"
          ) AS position
        FROM attested
      ), field_chunks AS MATERIALIZED (
        SELECT
          ((ordered.position - 1) / 1000)::integer AS chunk_index,
          pg_catalog.count(*)::integer AS row_count,
          pg_catalog.encode(
            pg_catalog.sha256(pg_catalog.convert_to(
              pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_array(
                  ordered.source_trader_id,
                  ordered.field_commitment
                ) ORDER BY ordered.position
              )::text,
              'UTF8'
            )),
            'hex'
          ) AS chunk_sha256
        FROM ordered
        GROUP BY ((ordered.position - 1) / 1000)::integer
      ), field_plan AS MATERIALIZED (
        SELECT COALESCE(pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_array(
            field_chunks.chunk_index,
            field_chunks.row_count,
            field_chunks.chunk_sha256
          ) ORDER BY field_chunks.chunk_index
        ), '[]'::jsonb) AS chunks
        FROM field_chunks
      ), field_summary AS MATERIALIZED (
        SELECT pg_catalog.count(*)::integer AS row_count
        FROM ordered
      )
      SELECT
        field_summary.row_count,
        pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to(
            pg_catalog.jsonb_build_array(
              'leaderboard-rank-generation-source-score-payload@1',
              p_season_id,
              v_source.source,
              field_summary.row_count,
              field_plan.chunks
            )::text,
            'UTF8'
          )),
          'hex'
        )
      INTO STRICT v_inserted_count, v_target_payload_sha256
      FROM field_summary
      CROSS JOIN field_plan;
      IF v_inserted_count IS DISTINCT FROM v_target_count THEN
        RAISE EXCEPTION 'fresh source attested score payload is incomplete: %',
          v_source.source
          USING ERRCODE = '23514';
      END IF;

      INSERT INTO pg_temp.leaderboard_rank_publication_plan_work (
        source,
        disposition,
        source_as_of,
        registry_slugs,
        snapshot_ids,
        source_evidence,
        source_evidence_sha256,
        target_rank_count,
        target_identity_sha256,
        target_payload_sha256,
        metric_input_count,
        metric_evidence_valid_until,
        metric_evidence_sha256
      ) VALUES (
        v_source.source,
        'replace',
        v_source_as_of,
        v_registry_slugs,
        v_snapshot_ids,
        v_source_boards,
        v_source_evidence_sha256,
        v_target_count,
        v_target_identity_sha256,
        v_target_payload_sha256,
        v_metric_source_input_count,
        v_metric_source_valid_until,
        v_metric_source_evidence_sha256
      );
      CONTINUE;
    END IF;

    SELECT freshness.*
    INTO v_freshness
    FROM ONLY public.leaderboard_source_freshness AS freshness
    WHERE freshness.season_id = p_season_id
      AND freshness.source = v_source.source;

    IF NOT FOUND THEN
      IF EXISTS (
        SELECT 1
        FROM public.leaderboard_ranks AS ranks
        WHERE ranks.season_id = p_season_id
          AND ranks.source = v_source.source
      ) THEN
        RAISE EXCEPTION
          'retained source has live rows without a sealed freshness proof: %',
          v_source.source
          USING ERRCODE = '55000';
      END IF;

      INSERT INTO pg_temp.leaderboard_rank_publication_plan_work (
        source,
        disposition,
        registry_slugs,
        snapshot_ids,
        source_evidence,
        source_evidence_sha256,
        target_rank_count,
        target_identity_sha256
      ) VALUES (
        v_source.source,
        'unavailable',
        v_registry_slugs,
        v_snapshot_ids,
        v_source_boards,
        v_source_evidence_sha256,
        0,
        v_empty_sha256
      );
      CONTINUE;
    END IF;

    IF pg_catalog.num_nonnulls(
         v_freshness.score_cohort_id,
         v_freshness.rank_mutation_seq,
         v_freshness.published_rank_count,
         v_freshness.published_identity_sha256
       ) = 0 THEN
      IF EXISTS (
        SELECT 1
        FROM public.leaderboard_ranks AS ranks
        WHERE ranks.season_id = p_season_id
          AND ranks.source = v_source.source
      ) THEN
        RAISE EXCEPTION
          'unsealed retained-source freshness has live rows: %',
          v_source.source
          USING ERRCODE = '55000';
      END IF;

      INSERT INTO pg_temp.leaderboard_rank_publication_plan_work (
        source,
        disposition,
        registry_slugs,
        snapshot_ids,
        source_evidence,
        source_evidence_sha256,
        target_rank_count,
        target_identity_sha256
      ) VALUES (
        v_source.source,
        'unavailable',
        v_registry_slugs,
        v_snapshot_ids,
        v_source_boards,
        v_source_evidence_sha256,
        0,
        v_empty_sha256
      );
      CONTINUE;
    ELSIF pg_catalog.num_nonnulls(
            v_freshness.score_cohort_id,
            v_freshness.rank_mutation_seq,
            v_freshness.published_rank_count,
            v_freshness.published_identity_sha256
          ) <> 4 THEN
      RAISE EXCEPTION 'retained-source freshness proof is partial: %',
        v_source.source
        USING ERRCODE = '55000';
    END IF;

    v_now := pg_catalog.clock_timestamp();
    IF v_freshness.source_as_of IS NULL
       OR NOT pg_catalog.isfinite(v_freshness.source_as_of)
       OR v_freshness.source_as_of <= v_now - interval '48 hours'
       OR v_freshness.source_as_of > v_now + interval '5 minutes'
       OR v_freshness.recorded_at IS NULL
       OR NOT pg_catalog.isfinite(v_freshness.recorded_at)
       OR v_freshness.recorded_at > v_now + interval '5 minutes' THEN
      INSERT INTO pg_temp.leaderboard_rank_publication_plan_work (
        source,
        disposition,
        registry_slugs,
        snapshot_ids,
        source_evidence,
        source_evidence_sha256,
        target_rank_count,
        target_identity_sha256
      ) VALUES (
        v_source.source,
        'unavailable',
        v_registry_slugs,
        v_snapshot_ids,
        v_source_boards,
        v_source_evidence_sha256,
        0,
        v_empty_sha256
      );
      CONTINUE;
    END IF;

    SELECT fence.*
    INTO v_fence
    FROM ONLY arena.leaderboard_rank_mutation_fences AS fence
    WHERE fence.season_id = p_season_id
      AND fence.source = v_source.source;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'retained source freshness has no mutation fence: %',
        v_source.source
        USING ERRCODE = '55000';
    END IF;

    SELECT publication.*
    INTO v_publication
    FROM ONLY arena.leaderboard_rank_publications AS publication
    WHERE publication.id = v_freshness.score_cohort_id
      AND publication.season_id = p_season_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'retained source freshness has no publication receipt: %',
        v_source.source
        USING ERRCODE = '55000';
    END IF;

    -- The first trust-gated rollout must never inherit a legacy cohort. Only
    -- a public cohort already backed by this immutable plan contract may be
    -- retained. Missing ancestry is a safe unavailable target, not an
    -- assertion that historical values were trustworthy.
    SELECT prior.*
    INTO v_prior_plan
    FROM ONLY arena.leaderboard_rank_generation_publication_plans AS prior
    WHERE prior.season_id = p_season_id
      AND prior.score_cohort_id = v_freshness.score_cohort_id;
    IF NOT FOUND THEN
      INSERT INTO pg_temp.leaderboard_rank_publication_plan_work (
        source,
        disposition,
        registry_slugs,
        snapshot_ids,
        source_evidence,
        source_evidence_sha256,
        target_rank_count,
        target_identity_sha256
      ) VALUES (
        v_source.source,
        'unavailable',
        v_registry_slugs,
        v_snapshot_ids,
        v_source_boards,
        v_source_evidence_sha256,
        0,
        v_empty_sha256
      );
      CONTINUE;
    END IF;

    SELECT stored.*
    INTO v_prior_manifest
    FROM ONLY arena.leaderboard_score_input_manifests AS stored
    WHERE stored.manifest_id = v_prior_plan.score_input_manifest_id
      AND stored.manifest_digest =
            v_prior_plan.score_input_manifest_digest;
    IF NOT FOUND
       OR v_prior_manifest.manifest->'enrichment'->>'contract'
            IS DISTINCT FROM
              'leaderboard-score-metric-trust-core-projection@1'
       OR v_prior_manifest.manifest->'eligibility'->>'contract'
            IS DISTINCT FROM
              'leaderboard-score-trusted-roi-pnl-win-mdd-usdt@1'
       OR v_prior_manifest.manifest->'enrichment'->'evidence'
            ->'forcedUnknownInputs' IS DISTINCT FROM
              pg_catalog.jsonb_build_array(
                'sharpe_ratio', 'profit_factor', 'trades_count'
              ) THEN
      INSERT INTO pg_temp.leaderboard_rank_publication_plan_work (
        source,
        disposition,
        registry_slugs,
        snapshot_ids,
        source_evidence,
        source_evidence_sha256,
        target_rank_count,
        target_identity_sha256
      ) VALUES (
        v_source.source,
        'unavailable',
        v_registry_slugs,
        v_snapshot_ids,
        v_source_boards,
        v_source_evidence_sha256,
        0,
        v_empty_sha256
      );
      CONTINUE;
    END IF;

    SELECT prior_source.*
    INTO v_prior_source_plan
    FROM ONLY arena.leaderboard_rank_generation_publication_plan_sources
      AS prior_source
    WHERE prior_source.season_id = v_prior_plan.season_id
      AND prior_source.generation_seq = v_prior_plan.generation_seq
      AND prior_source.score_cohort_id = v_prior_plan.score_cohort_id
      AND prior_source.source = v_source.source;
    IF NOT FOUND
       OR v_prior_plan.contract IS DISTINCT FROM
            'leaderboard-rank-generation-publication-plan@1'
       OR v_prior_plan.generation_seq >= p_generation_seq
       OR v_prior_source_plan.contract IS DISTINCT FROM
            'leaderboard-rank-generation-publication-plan-source@1'
       OR v_prior_source_plan.disposition NOT IN ('replace', 'retain')
       OR v_prior_source_plan.metric_input_count <
            v_prior_source_plan.target_rank_count
       OR (
         v_prior_source_plan.metric_input_count = 0
         AND pg_catalog.num_nonnulls(
           v_prior_source_plan.metric_evidence_valid_until,
           v_prior_source_plan.metric_evidence_sha256
         ) <> 0
       )
       OR (
         v_prior_source_plan.metric_input_count > 0
         AND (
           v_prior_source_plan.metric_evidence_valid_until IS NULL
           OR NOT pg_catalog.isfinite(
             v_prior_source_plan.metric_evidence_valid_until
           )
           OR v_prior_source_plan.metric_evidence_valid_until <
                v_claim.lease_expires_at
           OR v_prior_source_plan.metric_evidence_sha256 !~
                '^[0-9a-f]{64}$'
         )
       ) THEN
      INSERT INTO pg_temp.leaderboard_rank_publication_plan_work (
        source,
        disposition,
        registry_slugs,
        snapshot_ids,
        source_evidence,
        source_evidence_sha256,
        target_rank_count,
        target_identity_sha256
      ) VALUES (
        v_source.source,
        'unavailable',
        v_registry_slugs,
        v_snapshot_ids,
        v_source_boards,
        v_source_evidence_sha256,
        0,
        v_empty_sha256
      );
      CONTINUE;
    END IF;

    -- Payloads are deliberately hashed in bounded 1,000-row chunks. A source
    -- may retain hundreds of thousands of rows; aggregating its complete
    -- encoded payload into one JSON value would turn a proof into an
    -- avoidable memory/TOAST denial of service. The compact chunk plan is the
    -- canonical retained-payload preimage for this contract version.
    WITH ordered AS MATERIALIZED (
      SELECT
        ranks.source_trader_id,
        arena.build_leaderboard_rank_manifest_field_commitment_v1(
          ranks.source,
          ranks.source_trader_id,
          ranks.roi,
          ranks.pnl,
          ranks.win_rate,
          ranks.max_drawdown,
          ranks.sharpe_ratio,
          ranks.profit_factor,
          ranks.trades_count,
          ranks.arena_score,
          ranks.score_factors,
          ranks.profitability_score,
          ranks.risk_control_score,
          ranks.execution_score
        ) AS field_commitment,
        pg_catalog.row_number() OVER (
          ORDER BY ranks.source_trader_id COLLATE pg_catalog."C"
        ) AS position
      FROM public.leaderboard_ranks AS ranks
      WHERE ranks.season_id = p_season_id
        AND ranks.source = v_source.source
    ), identity_summary AS MATERIALIZED (
      SELECT
        pg_catalog.count(*)::integer AS row_count,
        COALESCE(pg_catalog.jsonb_agg(
          ordered.source_trader_id
          ORDER BY ordered.position
        ), '[]'::jsonb) AS identities
      FROM ordered
    ), payload_chunks AS MATERIALIZED (
      SELECT
        ((ordered.position - 1) / 1000)::integer AS chunk_index,
        pg_catalog.count(*)::integer AS row_count,
        pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to(
            pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_array(
                ordered.source_trader_id,
                ordered.field_commitment
              )
              ORDER BY ordered.position
            )::text,
            'UTF8'
          )),
          'hex'
        ) AS chunk_sha256
      FROM ordered
      GROUP BY ((ordered.position - 1) / 1000)::integer
    ), payload_plan AS MATERIALIZED (
      SELECT COALESCE(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(
          payload_chunks.chunk_index,
          payload_chunks.row_count,
          payload_chunks.chunk_sha256
        ) ORDER BY payload_chunks.chunk_index
      ), '[]'::jsonb) AS chunks
      FROM payload_chunks
    )
    SELECT
      identity_summary.row_count,
      identity_summary.identities,
      pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(
          pg_catalog.jsonb_build_array(
            'leaderboard-rank-generation-source-score-payload@1',
            p_season_id,
            v_source.source,
            identity_summary.row_count,
            payload_plan.chunks
          )::text,
          'UTF8'
        )),
        'hex'
      )
    INTO STRICT
      v_target_count,
      v_target_identities,
      v_target_payload_sha256
    FROM identity_summary
    CROSS JOIN payload_plan;

    v_target_identity_sha256 := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(
        v_target_identities::text,
        'UTF8'
      )),
      'hex'
    );
    v_expected_proof := pg_catalog.jsonb_build_object(
      'source', v_freshness.source,
      'source_as_of', pg_catalog.to_char(
        v_freshness.source_as_of AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'recorded_at', pg_catalog.to_char(
        v_freshness.recorded_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'score_cohort_id', v_freshness.score_cohort_id,
      'rank_mutation_seq', v_freshness.rank_mutation_seq,
      'published_rank_count', v_freshness.published_rank_count,
      'published_identity_sha256',
        v_freshness.published_identity_sha256
    );

    IF v_freshness.source_as_of IS NULL
       OR NOT pg_catalog.isfinite(v_freshness.source_as_of)
       OR v_freshness.recorded_at IS NULL
       OR NOT pg_catalog.isfinite(v_freshness.recorded_at)
       OR v_freshness.score_cohort_id IS NULL
       OR v_freshness.rank_mutation_seq IS DISTINCT FROM
            v_fence.mutation_seq
       OR v_freshness.published_rank_count IS DISTINCT FROM v_target_count
       OR v_freshness.published_identity_sha256 IS DISTINCT FROM
            v_target_identity_sha256
       OR v_prior_source_plan.source_as_of IS DISTINCT FROM
            v_freshness.source_as_of
       OR v_prior_source_plan.target_rank_count IS DISTINCT FROM
            v_target_count
       OR v_prior_source_plan.target_identity_sha256 IS DISTINCT FROM
            v_target_identity_sha256
       OR v_prior_source_plan.target_payload_sha256 IS DISTINCT FROM
            v_target_payload_sha256
       OR v_publication.published_at IS DISTINCT FROM
            v_freshness.recorded_at
       OR v_publication.source_count IS DISTINCT FROM
            pg_catalog.jsonb_array_length(v_publication.proofs)
       OR 1 IS DISTINCT FROM (
         SELECT pg_catalog.count(*)::integer
         FROM pg_catalog.jsonb_array_elements(v_publication.proofs)
           AS proof(value)
         WHERE proof.value = v_expected_proof
       )
       OR EXISTS (
         SELECT 1
         FROM public.leaderboard_ranks AS ranks
         WHERE ranks.season_id = p_season_id
           AND ranks.source = v_source.source
           AND (
             ranks.rank_publication_id IS DISTINCT FROM
               v_freshness.score_cohort_id
             OR NOT arena.leaderboard_rank_row_is_public_eligible(
               ranks,
               v_now
             )
           )
       ) THEN
      RAISE EXCEPTION 'retained source is not one exact sealed preimage: %',
        v_source.source
        USING ERRCODE = '55000';
    END IF;

    INSERT INTO pg_temp.leaderboard_rank_publication_plan_work (
      source,
      disposition,
      source_as_of,
      registry_slugs,
      snapshot_ids,
      source_evidence,
      source_evidence_sha256,
      target_rank_count,
      target_identity_sha256,
      target_payload_sha256,
      metric_input_count,
      metric_evidence_valid_until,
      metric_evidence_sha256,
      prior_score_cohort_id,
      prior_rank_mutation_seq,
      prior_recorded_at
    ) VALUES (
      v_source.source,
      'retain',
      v_freshness.source_as_of,
      v_registry_slugs,
      v_snapshot_ids,
      v_source_boards,
      v_source_evidence_sha256,
      v_target_count,
      v_target_identity_sha256,
      v_target_payload_sha256,
      v_prior_source_plan.metric_input_count,
      v_prior_source_plan.metric_evidence_valid_until,
      v_prior_source_plan.metric_evidence_sha256,
      v_freshness.score_cohort_id,
      v_freshness.rank_mutation_seq,
      v_freshness.recorded_at
    );
  END LOOP;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) FILTER (
      WHERE work.disposition = 'replace'
    )::integer,
    pg_catalog.count(*) FILTER (
      WHERE work.disposition = 'retain'
    )::integer,
    pg_catalog.count(*) FILTER (
      WHERE work.disposition = 'unavailable'
    )::integer,
    COALESCE(pg_catalog.sum(work.target_rank_count) FILTER (
      WHERE work.disposition = 'replace'
    ), 0)::integer,
    COALESCE(pg_catalog.sum(work.target_rank_count) FILTER (
      WHERE work.disposition = 'retain'
    ), 0)::bigint,
    COALESCE(pg_catalog.sum(work.target_rank_count), 0)::bigint,
    COALESCE(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_array(
        work.source,
        work.disposition,
        CASE WHEN work.source_as_of IS NULL THEN NULL
          ELSE pg_catalog.to_char(
            work.source_as_of AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          )
        END,
        work.registry_slugs,
        work.snapshot_ids,
        work.source_evidence_sha256,
        work.target_rank_count,
        work.target_identity_sha256,
        work.target_payload_sha256,
        work.metric_input_count,
        CASE WHEN work.metric_evidence_valid_until IS NULL THEN NULL
          ELSE pg_catalog.to_char(
            work.metric_evidence_valid_until AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          )
        END,
        work.metric_evidence_sha256,
        work.prior_score_cohort_id,
        work.prior_rank_mutation_seq,
        CASE WHEN work.prior_recorded_at IS NULL THEN NULL
          ELSE pg_catalog.to_char(
            work.prior_recorded_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          )
        END
      ) ORDER BY work.source COLLATE pg_catalog."C"
    ), '[]'::jsonb)
  INTO STRICT
    v_source_count,
    v_replace_count,
    v_retain_count,
    v_unavailable_count,
    v_staged_count,
    v_retained_count,
    v_target_count_total,
    v_plan_sources
  FROM pg_temp.leaderboard_rank_publication_plan_work AS work;

  IF v_source_count IS DISTINCT FROM pg_catalog.jsonb_array_length(v_authority)
     OR v_staged_count IS DISTINCT FROM v_claim.expected_rank_count
     OR v_retained_count < 0
     OR v_target_count_total IS DISTINCT FROM
          v_staged_count::bigint + v_retained_count
     OR v_target_count_total > 250000 THEN
    RAISE EXCEPTION 'publication plan terminal population is inconsistent'
      USING ERRCODE = '23514';
  END IF;

  v_plan_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        'leaderboard-rank-generation-publication-plan@1',
        p_season_id,
        p_generation_seq,
        p_score_cohort_id::text,
        p_score_input_manifest_id::text,
        p_score_input_manifest_digest,
        v_attestation_sha256,
        v_authority_sha256,
        v_plan_sources
      )::text,
      'UTF8'
    )),
    'hex'
  );

  -- Recheck the authorization clock after every potentially blocking serving
  -- lock. No private receipt may be created under an expired lease or manifest.
  v_planned_at := pg_catalog.clock_timestamp();
  IF EXISTS (
    SELECT 1
    FROM pg_temp.leaderboard_rank_publication_plan_work AS work
    WHERE work.disposition = 'retain'
      AND (
        work.source_as_of <= v_planned_at - interval '48 hours'
        OR work.source_as_of > v_planned_at + interval '5 minutes'
        OR work.prior_recorded_at > v_planned_at + interval '5 minutes'
        OR EXISTS (
          SELECT 1
          FROM public.leaderboard_ranks AS ranks
          WHERE ranks.season_id = p_season_id
            AND ranks.source = work.source
            AND NOT arena.leaderboard_rank_row_is_public_eligible(
              ranks,
              v_planned_at
            )
        )
      )
  ) THEN
    RAISE EXCEPTION 'retained source expired before publication plan seal'
      USING ERRCODE = '55000';
  END IF;
  IF v_claim.lease_expires_at <= v_planned_at
     OR v_manifest.valid_until <= v_planned_at THEN
    RAISE EXCEPTION 'generation lease expired before publication plan seal'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO arena.leaderboard_rank_generation_publication_plans (
    contract,
    season_id,
    generation_seq,
    score_cohort_id,
    score_input_manifest_id,
    score_input_manifest_digest,
    plan_write_top_xid,
    manifest_attestation_sha256,
    authority_sha256,
    plan_sha256,
    source_count,
    replace_source_count,
    retain_source_count,
    unavailable_source_count,
    staged_rank_count,
    retained_rank_count,
    target_rank_count,
    planned_at,
    manifest_valid_until
  ) VALUES (
    'leaderboard-rank-generation-publication-plan@1',
    p_season_id,
    p_generation_seq,
    p_score_cohort_id,
    p_score_input_manifest_id,
    p_score_input_manifest_digest,
    v_current_top_xid,
    v_attestation_sha256,
    v_authority_sha256,
    v_plan_sha256,
    v_source_count,
    v_replace_count,
    v_retain_count,
    v_unavailable_count,
    v_staged_count,
    v_retained_count::integer,
    v_target_count_total::integer,
    v_planned_at,
    v_manifest.valid_until
  );

  INSERT INTO arena.leaderboard_rank_generation_publication_plan_sources (
    contract,
    season_id,
    generation_seq,
    score_cohort_id,
    source,
    disposition,
    source_as_of,
    registry_slugs,
    snapshot_ids,
    source_evidence,
    source_evidence_sha256,
    target_rank_count,
    target_identity_sha256,
    target_payload_sha256,
    metric_input_count,
    metric_evidence_valid_until,
    metric_evidence_sha256,
    prior_score_cohort_id,
    prior_rank_mutation_seq,
    prior_recorded_at
  )
  SELECT
    'leaderboard-rank-generation-publication-plan-source@1',
    p_season_id,
    p_generation_seq,
    p_score_cohort_id,
    work.source,
    work.disposition,
    work.source_as_of,
    work.registry_slugs,
    work.snapshot_ids,
    work.source_evidence,
    work.source_evidence_sha256,
    work.target_rank_count,
    work.target_identity_sha256,
    work.target_payload_sha256,
    work.metric_input_count,
    work.metric_evidence_valid_until,
    work.metric_evidence_sha256,
    work.prior_score_cohort_id,
    work.prior_rank_mutation_seq,
    work.prior_recorded_at
  FROM pg_temp.leaderboard_rank_publication_plan_work AS work
  ORDER BY work.source COLLATE pg_catalog."C";
  GET DIAGNOSTICS v_inserted_count = ROW_COUNT;
  IF v_inserted_count IS DISTINCT FROM v_source_count THEN
    RAISE EXCEPTION 'publication plan source insert was incomplete'
      USING ERRCODE = '55000';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-rank-generation-publication-plan-seal@1',
    'season_id', p_season_id,
    'generation_seq', p_generation_seq,
    'score_cohort_id', p_score_cohort_id,
    'score_input_manifest_id', p_score_input_manifest_id,
    'score_input_manifest_digest', p_score_input_manifest_digest,
    'manifest_attestation_sha256', v_attestation_sha256,
    'authority_sha256', v_authority_sha256,
    'plan_sha256', v_plan_sha256,
    'source_count', v_source_count,
    'replace_source_count', v_replace_count,
    'retain_source_count', v_retain_count,
    'unavailable_source_count', v_unavailable_count,
    'staged_rank_count', v_staged_count,
    'retained_rank_count', v_retained_count,
    'target_rank_count', v_target_count_total,
    'planned_at', pg_catalog.to_char(
      v_planned_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'is_sealed', true
  );
END;
$body$;

CREATE FUNCTION arena.defer_rank_generation_publication_plan_checks_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $body$
BEGIN
  IF NEW.batch_index <> 0 THEN
    RETURN NEW;
  END IF;

  -- The writer already restores its pre-existing batch/attestation checks.
  -- Restore the two checks introduced by this migration as well, even when a
  -- caller entered with SET CONSTRAINTS ALL IMMEDIATE. Both require rows that
  -- are created after the stage-batch header inside the same owner-only call.
  SET CONSTRAINTS
    arena.leaderboard_rank_generation_stage_batches_publication_plan,
    arena.leaderboard_rank_generation_publication_plans_complete
    DEFERRED;

  RETURN NEW;
END;
$body$;

CREATE FUNCTION arena.seal_rank_generation_publication_plan_from_batch_zero_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
SET "TimeZone" = 'UTC'
SET lock_timeout = '10s'
AS $body$
DECLARE
  v_result jsonb;
BEGIN
  IF NEW.batch_index <> 0 THEN
    RETURN NULL;
  END IF;

  v_result := arena.seal_leaderboard_rank_generation_publication_plan_v1(
    NEW.season_id,
    NEW.generation_seq,
    NEW.score_cohort_id,
    NEW.score_input_manifest_id,
    NEW.score_input_manifest_digest
  );
  IF v_result->>'contract' IS DISTINCT FROM
       'leaderboard-rank-generation-publication-plan-seal@1'
     OR (v_result->>'is_sealed')::boolean IS DISTINCT FROM true
     OR v_result->>'plan_sha256' !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'batch-zero publication plan seal returned invalid evidence'
      USING ERRCODE = '55000';
  END IF;

  RETURN NULL;
END;
$body$;

CREATE FUNCTION arena.validate_rank_generation_publication_plan_complete_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET "TimeZone" = 'UTC'
AS $body$
DECLARE
  v_source_count integer;
  v_replace_count integer;
  v_retain_count integer;
  v_unavailable_count integer;
  v_staged_count bigint;
  v_retained_count bigint;
  v_plan_sources jsonb;
  v_plan_sha256 text;
BEGIN
  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) FILTER (
      WHERE source_row.disposition = 'replace'
    )::integer,
    pg_catalog.count(*) FILTER (
      WHERE source_row.disposition = 'retain'
    )::integer,
    pg_catalog.count(*) FILTER (
      WHERE source_row.disposition = 'unavailable'
    )::integer,
    COALESCE(pg_catalog.sum(source_row.target_rank_count) FILTER (
      WHERE source_row.disposition = 'replace'
    ), 0)::bigint,
    COALESCE(pg_catalog.sum(source_row.target_rank_count) FILTER (
      WHERE source_row.disposition = 'retain'
    ), 0)::bigint,
    COALESCE(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_array(
        source_row.source,
        source_row.disposition,
        CASE WHEN source_row.source_as_of IS NULL THEN NULL
          ELSE pg_catalog.to_char(
            source_row.source_as_of AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          )
        END,
        source_row.registry_slugs,
        source_row.snapshot_ids,
        source_row.source_evidence_sha256,
        source_row.target_rank_count,
        source_row.target_identity_sha256,
        source_row.target_payload_sha256,
        source_row.metric_input_count,
        CASE WHEN source_row.metric_evidence_valid_until IS NULL THEN NULL
          ELSE pg_catalog.to_char(
            source_row.metric_evidence_valid_until AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          )
        END,
        source_row.metric_evidence_sha256,
        source_row.prior_score_cohort_id,
        source_row.prior_rank_mutation_seq,
        CASE WHEN source_row.prior_recorded_at IS NULL THEN NULL
          ELSE pg_catalog.to_char(
            source_row.prior_recorded_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          )
        END
      ) ORDER BY source_row.source COLLATE pg_catalog."C"
    ), '[]'::jsonb)
  INTO STRICT
    v_source_count,
    v_replace_count,
    v_retain_count,
    v_unavailable_count,
    v_staged_count,
    v_retained_count,
    v_plan_sources
  FROM ONLY arena.leaderboard_rank_generation_publication_plan_sources
    AS source_row
  WHERE source_row.season_id = NEW.season_id
    AND source_row.generation_seq = NEW.generation_seq
    AND source_row.score_cohort_id = NEW.score_cohort_id;

  v_plan_sha256 := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_array(
          'leaderboard-rank-generation-publication-plan@1',
          NEW.season_id,
          NEW.generation_seq,
          NEW.score_cohort_id::text,
          NEW.score_input_manifest_id::text,
          NEW.score_input_manifest_digest,
          NEW.manifest_attestation_sha256,
          NEW.authority_sha256,
          v_plan_sources
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );

  IF v_source_count IS DISTINCT FROM NEW.source_count
     OR v_replace_count IS DISTINCT FROM NEW.replace_source_count
     OR v_retain_count IS DISTINCT FROM NEW.retain_source_count
     OR v_unavailable_count IS DISTINCT FROM NEW.unavailable_source_count
     OR v_staged_count IS DISTINCT FROM NEW.staged_rank_count
     OR v_retained_count IS DISTINCT FROM NEW.retained_rank_count
     OR v_staged_count + v_retained_count IS DISTINCT FROM NEW.target_rank_count
     OR v_plan_sha256 IS DISTINCT FROM NEW.plan_sha256 THEN
    RAISE EXCEPTION 'generation publication plan is incomplete or has drifted'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$body$;
ALTER FUNCTION
  arena.guard_rank_generation_publication_plan_source_insert_v1()
  OWNER TO postgres;
ALTER FUNCTION arena.build_leaderboard_metric_trust_projection_v1(
  text, jsonb, jsonb
) OWNER TO postgres;
ALTER FUNCTION arena.seal_leaderboard_rank_generation_publication_plan_v1(
  text, bigint, uuid, uuid, text
) OWNER TO postgres;
ALTER FUNCTION arena.defer_rank_generation_publication_plan_checks_v1()
  OWNER TO postgres;
ALTER FUNCTION
  arena.seal_rank_generation_publication_plan_from_batch_zero_v1()
  OWNER TO postgres;
ALTER FUNCTION
  arena.validate_rank_generation_publication_plan_complete_v1()
  OWNER TO postgres;

DO $revoke_function_acl$
DECLARE
  v_function regprocedure;
  v_grantee oid;
  v_role_name text;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'arena.guard_rank_generation_publication_plan_source_insert_v1()'::regprocedure,
    'arena.build_leaderboard_metric_trust_projection_v1(text,jsonb,jsonb)'::regprocedure,
    'arena.seal_leaderboard_rank_generation_publication_plan_v1(text,bigint,uuid,uuid,text)'::regprocedure,
    'arena.defer_rank_generation_publication_plan_checks_v1()'::regprocedure,
    'arena.seal_rank_generation_publication_plan_from_batch_zero_v1()'::regprocedure,
    'arena.validate_rank_generation_publication_plan_complete_v1()'::regprocedure
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

CREATE TRIGGER rank_generation_publication_plan_sources_insert_guard
AFTER INSERT
ON arena.leaderboard_rank_generation_publication_plan_sources
FOR EACH ROW
EXECUTE FUNCTION
  arena.guard_rank_generation_publication_plan_source_insert_v1();

CREATE CONSTRAINT TRIGGER leaderboard_rank_generation_publication_plans_complete
AFTER INSERT
ON arena.leaderboard_rank_generation_publication_plans
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION
  arena.validate_rank_generation_publication_plan_complete_v1();

-- A caller may have made every deferrable constraint immediate. Re-defer only
-- the two publication-plan checks before the writer inserts its batch-zero
-- header; its existing body independently restores the older stage checks.
CREATE TRIGGER rank_generation_stage_batches_defer_publication_plan
BEFORE INSERT
ON arena.leaderboard_rank_generation_stage_batches
FOR EACH ROW
WHEN (NEW.batch_index = 0)
EXECUTE FUNCTION
  arena.defer_rank_generation_publication_plan_checks_v1();

-- `...stage_batches_complete` sorts before this trigger. Both are deferred,
-- so the exact typed batch and manifest attestation validate before batch zero
-- seals the registry-complete source plan in the same top-level transaction.
CREATE CONSTRAINT TRIGGER leaderboard_rank_generation_stage_batches_publication_plan
AFTER INSERT
ON arena.leaderboard_rank_generation_stage_batches
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.batch_index = 0)
EXECUTE FUNCTION
  arena.seal_rank_generation_publication_plan_from_batch_zero_v1();

CREATE TRIGGER leaderboard_rank_generation_publication_plans_immutable
BEFORE UPDATE OR DELETE
ON arena.leaderboard_rank_generation_publication_plans
FOR EACH ROW
EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation();

CREATE TRIGGER leaderboard_rank_generation_publication_plans_no_truncate
BEFORE TRUNCATE
ON arena.leaderboard_rank_generation_publication_plans
FOR EACH STATEMENT
EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation();

CREATE TRIGGER leaderboard_rank_generation_publication_plan_sources_immutable
BEFORE UPDATE OR DELETE
ON arena.leaderboard_rank_generation_publication_plan_sources
FOR EACH ROW
EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation();

CREATE TRIGGER rank_generation_publication_plan_sources_no_truncate
BEFORE TRUNCATE
ON arena.leaderboard_rank_generation_publication_plan_sources
FOR EACH STATEMENT
EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation();

REVOKE ALL ON TABLE arena.leaderboard_rank_generation_publication_plans
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE
  arena.leaderboard_rank_generation_publication_plan_sources
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION
  arena.guard_rank_generation_publication_plan_source_insert_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  arena.build_leaderboard_metric_trust_projection_v1(text, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  arena.seal_leaderboard_rank_generation_publication_plan_v1(
    text, bigint, uuid, uuid, text
  )
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  arena.defer_rank_generation_publication_plan_checks_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  arena.seal_rank_generation_publication_plan_from_batch_zero_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  arena.validate_rank_generation_publication_plan_complete_v1()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE arena.leaderboard_rank_generation_publication_plans IS
  'Owner-only immutable registry-complete publication plans. These receipts bind source disposition and target identity evidence but do not grant serving authority or mutate live ranks.';
COMMENT ON TABLE
  arena.leaderboard_rank_generation_publication_plan_sources IS
  'One immutable source plan per season generation: replace from fresh manifest evidence, retain from an exact sealed live preimage, or unavailable with an explicit empty target.';
COMMENT ON FUNCTION arena.seal_leaderboard_rank_generation_publication_plan_v1(
  text, bigint, uuid, uuid, text
) IS
  'Owner-only positive-generation plan sealer admitted only from the batch-zero top-level transaction.';
COMMENT ON FUNCTION arena.build_leaderboard_metric_trust_projection_v1(
  text, jsonb, jsonb
) IS
  'Owner-only canonical four-metric scorer projection. Untrusted, partial, ambiguous, non-USDT, or expired observations are excluded and display-only inputs are forced NULL.';
COMMENT ON FUNCTION arena.defer_rank_generation_publication_plan_checks_v1()
  IS 'Owner-only stage-header guard that restores the two cyclic publication-plan checks to deferred mode.';
COMMENT ON FUNCTION
  arena.seal_rank_generation_publication_plan_from_batch_zero_v1()
  IS 'Deferred batch-zero hook that seals the full manifest-derived source plan before the first private batch commits.';

DO $postflight$
DECLARE
  v_table regclass;
  v_function regprocedure;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'arena.leaderboard_rank_generation_publication_plans'::regclass,
    'arena.leaderboard_rank_generation_publication_plan_sources'::regclass
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation_row
      WHERE relation_row.oid = v_table
        AND relation_row.relkind = 'r'
        AND relation_row.relpersistence = 'p'
        AND relation_row.relowner = 'postgres'::regrole
        AND relation_row.relrowsecurity
        AND NOT relation_row.relforcerowsecurity
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy_row
      WHERE policy_row.polrelid = v_table
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation_row.relacl,
          pg_catalog.acldefault('r', relation_row.relowner)
        )
      ) AS privilege_row
      WHERE relation_row.oid = v_table
        AND privilege_row.grantee <> relation_row.relowner
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute_row.attacl)
        AS privilege_row
      WHERE attribute_row.attrelid = v_table
        AND attribute_row.attnum > 0
        AND NOT attribute_row.attisdropped
        AND privilege_row.grantee <> 'postgres'::regrole
    ) OR EXISTS (
      SELECT 1
      FROM (VALUES
        ('anon'),
        ('authenticated'),
        ('service_role')
      ) AS api(role_name)
      WHERE pg_catalog.has_table_privilege(
              api.role_name,
              v_table,
              'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
            )
         OR pg_catalog.has_any_column_privilege(
              api.role_name,
              v_table,
              'SELECT,INSERT,UPDATE,REFERENCES'
            )
    ) THEN
      RAISE EXCEPTION 'publication plan table boundary postflight failed: %',
        v_table;
    END IF;
  END LOOP;

  FOREACH v_function IN ARRAY ARRAY[
    'arena.guard_rank_generation_publication_plan_source_insert_v1()'::regprocedure,
    'arena.build_leaderboard_metric_trust_projection_v1(text,jsonb,jsonb)'::regprocedure,
    'arena.seal_leaderboard_rank_generation_publication_plan_v1(text,bigint,uuid,uuid,text)'::regprocedure,
    'arena.defer_rank_generation_publication_plan_checks_v1()'::regprocedure,
    'arena.seal_rank_generation_publication_plan_from_batch_zero_v1()'::regprocedure,
    'arena.validate_rank_generation_publication_plan_complete_v1()'::regprocedure
  ] LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS privilege_row
      WHERE function_row.oid = v_function
        AND (
          function_row.proowner <> 'postgres'::regrole
          OR privilege_row.grantee <> function_row.proowner
        )
    ) THEN
      RAISE EXCEPTION 'publication plan function boundary postflight failed: %',
        v_function;
    END IF;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
      'arena.leaderboard_rank_generation_publication_plans'::regclass
      AND NOT trigger_row.tgisinternal
  ) <> 3
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid =
         'arena.leaderboard_rank_generation_publication_plan_sources'::regclass
         AND NOT trigger_row.tgisinternal
     ) <> 3
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid =
         'arena.leaderboard_rank_generation_stage_batches'::regclass
         AND trigger_row.tgname =
           'leaderboard_rank_generation_stage_batches_publication_plan'
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgdeferrable
         AND trigger_row.tginitdeferred
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid =
         'arena.leaderboard_rank_generation_stage_batches'::regclass
         AND trigger_row.tgname =
           'rank_generation_stage_batches_defer_publication_plan'
         AND NOT trigger_row.tgisinternal
         AND NOT trigger_row.tgdeferrable
         AND pg_catalog.pg_get_triggerdef(trigger_row.oid) LIKE
           '%BEFORE INSERT%'
     ) THEN
    RAISE EXCEPTION 'publication plan trigger topology postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'arena'
      AND function_row.proname IN (
        'guard_rank_generation_publication_plan_source_insert_v1',
        'build_leaderboard_metric_trust_projection_v1',
        'seal_leaderboard_rank_generation_publication_plan_v1',
        'defer_rank_generation_publication_plan_checks_v1',
        'seal_rank_generation_publication_plan_from_batch_zero_v1',
        'validate_rank_generation_publication_plan_complete_v1'
      )
      AND function_row.oid <> ALL (ARRAY[
        'arena.guard_rank_generation_publication_plan_source_insert_v1()'::regprocedure::oid,
        'arena.build_leaderboard_metric_trust_projection_v1(text,jsonb,jsonb)'::regprocedure::oid,
        'arena.seal_leaderboard_rank_generation_publication_plan_v1(text,bigint,uuid,uuid,text)'::regprocedure::oid,
        'arena.defer_rank_generation_publication_plan_checks_v1()'::regprocedure::oid,
        'arena.seal_rank_generation_publication_plan_from_batch_zero_v1()'::regprocedure::oid,
        'arena.validate_rank_generation_publication_plan_complete_v1()'::regprocedure::oid
      ])
  ) THEN
    RAISE EXCEPTION 'publication plan helper has a noncanonical overload';
  END IF;
END
$postflight$;

COMMIT;
