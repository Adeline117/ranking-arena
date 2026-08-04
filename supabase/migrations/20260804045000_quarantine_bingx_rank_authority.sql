-- Migration: 20260804045000_quarantine_bingx_rank_authority.sql
--
-- BingX remains useful for discovery, profiles, RAW evidence, and record
-- acquisition. It is not yet public rank authority: the current collection
-- path has not proved a snapshot-stable full population, native 7/30/90
-- boundaries, or receipt-bound completeness for the histories used to
-- interpret performance. Preserve every source observation, but archive and
-- remove the derived public ranks until a later reviewed promotion proves all
-- three contracts.

BEGIN;

SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '3min';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.exchanges') IS NULL
     OR pg_catalog.to_regclass('public.leaderboard_ranks') IS NULL
     OR pg_catalog.to_regclass('public.leaderboard_source_freshness') IS NULL
     OR pg_catalog.to_regclass('public.leaderboard_count_cache') IS NULL THEN
    RAISE EXCEPTION
      'BingX rank quarantine requires source, rank, freshness, and count foundations';
  END IF;

  IF pg_catalog.to_regprocedure(
       'public.arena_freshness_expected_sources()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.rerank_public_eligible_leaderboard(text)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.refresh_public_rank_count_cache_for_seasons(text[])'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks,timestamptz)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'BingX rank quarantine requires current eligibility-aware rank functions';
  END IF;

  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'BingX rank quarantine requires Supabase runtime roles';
  END IF;
END
$preflight$;

-- Serialize DDL, ACL convergence, cleanup, and guard replacement across
-- concurrent migration runners before creating any private archive object.
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    '20260804_bingx_rank_authority_quarantine',
    0
  )
);

CREATE TABLE IF NOT EXISTS arena.bingx_rank_quarantine_batches (
  batch_id text PRIMARY KEY,
  contract text NOT NULL,
  reason text NOT NULL,
  public_sources text[] NOT NULL,
  source_alias_map jsonb NOT NULL,
  source_rows_before jsonb NOT NULL
    CHECK (pg_catalog.jsonb_typeof(source_rows_before) = 'array'),
  source_rows_before_sha256 text NOT NULL
    CHECK (source_rows_before_sha256 ~ '^[0-9a-f]{64}$'),
  archived_rank_count bigint NOT NULL CHECK (archived_rank_count >= 0),
  archived_rank_sha256 text NOT NULL
    CHECK (archived_rank_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state = 'COMPLETE'),
  completed_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CHECK (contract = 'bingx-ranking-quarantine@1'),
  CHECK (
    source_alias_map = pg_catalog.jsonb_build_object(
      'bingx_futures', pg_catalog.to_jsonb(
        ARRAY['bingx', 'bingx_futures']::pg_catalog.text[]
      ),
      'bingx_spot', pg_catalog.to_jsonb(
        ARRAY['bingx_spot']::pg_catalog.text[]
      )
    )
  ),
  CHECK (
    public_sources = ARRAY[
      'bingx',
      'bingx_futures',
      'bingx_spot'
    ]::pg_catalog.text[]
  )
);

CREATE TABLE IF NOT EXISTS arena.bingx_rank_quarantine_rows (
  batch_id text NOT NULL,
  live_rank_id text NOT NULL,
  season_id text NOT NULL,
  source text NOT NULL,
  source_trader_id text NOT NULL,
  row_data jsonb NOT NULL,
  reason text NOT NULL,
  quarantined_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  PRIMARY KEY (batch_id, season_id, source, source_trader_id),
  FOREIGN KEY (batch_id)
    REFERENCES arena.bingx_rank_quarantine_batches(batch_id),
  CHECK (
    source = ANY (
      ARRAY['bingx', 'bingx_futures', 'bingx_spot']::pg_catalog.text[]
    )
  )
);

ALTER TABLE arena.bingx_rank_quarantine_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.bingx_rank_quarantine_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.bingx_rank_quarantine_batches OWNER TO postgres;
ALTER TABLE arena.bingx_rank_quarantine_rows OWNER TO postgres;

-- Table-level REVOKE does not clear an accidental column grant. Replay also
-- converges both private tables to a policy-free, table-grant-only boundary.
DO $close_archive_column_acl_and_policies$
DECLARE
  v_relation pg_catalog.regclass;
  v_relation_name text;
  v_columns text;
  v_policy record;
  v_role name;
BEGIN
  FOR v_relation, v_relation_name IN
    SELECT target.relation_oid, target.relation_name
    FROM (
      VALUES
        (
          'arena.bingx_rank_quarantine_batches'::pg_catalog.regclass,
          'arena.bingx_rank_quarantine_batches'::text
        ),
        (
          'arena.bingx_rank_quarantine_rows'::pg_catalog.regclass,
          'arena.bingx_rank_quarantine_rows'::text
        )
    ) AS target(relation_oid, relation_name)
  LOOP
    SELECT pg_catalog.string_agg(
      pg_catalog.quote_ident(attribute.attname),
      ', ' ORDER BY attribute.attnum
    )
    INTO STRICT v_columns
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    FOREACH v_role IN ARRAY ARRAY[
      'PUBLIC'::name,
      'anon'::name,
      'authenticated'::name,
      'service_role'::name
    ]
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) ON TABLE %2$s FROM %3$s',
        v_columns,
        v_relation_name,
        CASE
          WHEN v_role = 'PUBLIC' THEN 'PUBLIC'
          ELSE pg_catalog.quote_ident(v_role)
        END
      );
    END LOOP;

    FOR v_policy IN
      SELECT policy.polname
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_relation
      ORDER BY policy.polname
    LOOP
      EXECUTE pg_catalog.format(
        'DROP POLICY %I ON %s',
        v_policy.polname,
        v_relation_name
      );
    END LOOP;
  END LOOP;
END
$close_archive_column_acl_and_policies$;

REVOKE ALL ON TABLE
  arena.bingx_rank_quarantine_batches,
  arena.bingx_rank_quarantine_rows
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE
  arena.bingx_rank_quarantine_batches,
  arena.bingx_rank_quarantine_rows
TO service_role;

COMMENT ON TABLE arena.bingx_rank_quarantine_batches IS
  'Private replay ledger for the BingX public-rank authority quarantine.';
COMMENT ON TABLE arena.bingx_rank_quarantine_rows IS
  'Private full-row archive of derived BingX ranks; source observations and RAW evidence remain in their canonical tables.';

-- Freeze registry identities before resolving the source-scoped publication
-- locks. SHARE remains compatible with an in-flight publisher's source read,
-- allowing it to finish before this transaction acquires its advisory lock.
LOCK TABLE arena.sources IN SHARE MODE;
LOCK TABLE arena.exchanges IN SHARE MODE;

DO $publication_locks$
DECLARE
  v_source_id smallint;
BEGIN
  FOR v_source_id IN
    SELECT source.id
    FROM arena.sources AS source
    WHERE source.slug = ANY (
      ARRAY['bingx_futures', 'bingx_spot']::pg_catalog.text[]
    )
    ORDER BY source.id
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'arena.publish-board-series:' || v_source_id::text,
        0
      )
    );
  END LOOP;
END
$publication_locks$;

-- Match the eligibility-aware reranker lock order, then fence legacy and
-- delayed writers through the partitioned parent and every derived surface.
LOCK TABLE arena.sources IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.leaderboard_ranks IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.leaderboard_source_freshness IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.leaderboard_count_cache IN SHARE ROW EXCLUSIVE MODE;

-- READ COMMITTED deliberately takes this authoritative snapshot only after
-- all mutable surfaces are locked. A lock wait may admit an earlier writer,
-- but its committed rows are visible here and are archived/removed below.
DO $locked_preflight$
DECLARE
  v_source_count integer;
  v_exact_source_count integer;
BEGIN
  SELECT pg_catalog.count(*)::integer
  INTO v_source_count
  FROM arena.sources AS source
  WHERE source.slug = ANY (
    ARRAY['bingx_futures', 'bingx_spot']::pg_catalog.text[]
  );

  IF v_source_count <> 2 THEN
    RAISE EXCEPTION
      'expected exactly two BingX source rows, found %', v_source_count;
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_exact_source_count
  FROM arena.sources AS source
  JOIN arena.exchanges AS exchange
    ON exchange.id = source.exchange_id
  WHERE (
    (
      source.slug = 'bingx_futures'
      AND source.product_type = 'futures'
      AND source.meta->>'boardKey' = 'futures'
      AND COALESCE(
        NULLIF(pg_catalog.btrim(source.meta->>'legacy_platform'), ''),
        source.slug
      ) = ANY (
        ARRAY['bingx', 'bingx_futures']::pg_catalog.text[]
      )
    ) OR (
      source.slug = 'bingx_spot'
      AND source.product_type = 'spot'
      AND source.meta->>'boardKey' = 'spot'
      AND COALESCE(
        NULLIF(pg_catalog.btrim(source.meta->>'legacy_platform'), ''),
        source.slug
      ) = 'bingx_spot'
    )
  )
    AND exchange.slug = 'bingx'
    AND source.trader_kind_scope = 'human'
    AND source.adapter_slug = 'bingx'
    AND source.timeframes_native = ARRAY[7, 30, 90]::integer[]
    AND source.timeframes_derived = ARRAY[]::integer[]
    AND source.copier_table_depth = 'full'
    AND source.currency = 'USDT'
    AND source.page_size = 12
    AND source.pagination_kind = 'numeric'
    AND source.status = 'active'
    AND source.serving_mode IN ('serving', 'shadow');

  IF v_exact_source_count <> 2 THEN
    RAISE EXCEPTION
      'BingX source dimensions or public aliases drifted: %/2 exact rows',
      v_exact_source_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM arena.sources AS source
    WHERE source.slug <> ALL (
      ARRAY['bingx_futures', 'bingx_spot']::pg_catalog.text[]
    )
      AND source.status = 'active'
      AND source.serving_mode = 'serving'
      AND COALESCE(
        NULLIF(pg_catalog.btrim(source.meta->>'legacy_platform'), ''),
        source.slug
      ) = ANY (
        ARRAY['bingx', 'bingx_futures', 'bingx_spot']::pg_catalog.text[]
      )
  ) THEN
    RAISE EXCEPTION 'a non-BingX serving source owns a quarantined public alias';
  END IF;
END
$locked_preflight$;

CREATE TEMP TABLE bingx_rank_affected_seasons (
  season_id text PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO bingx_rank_affected_seasons (season_id)
SELECT DISTINCT rank_row.season_id
FROM public.leaderboard_ranks AS rank_row
WHERE rank_row.source = ANY (
  ARRAY['bingx', 'bingx_futures', 'bingx_spot']::pg_catalog.text[]
)
ORDER BY rank_row.season_id;

CREATE TEMP TABLE bingx_surface_affected_seasons (
  season_id text PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO bingx_surface_affected_seasons (season_id)
SELECT affected.season_id
FROM (
  SELECT rank_affected.season_id
  FROM bingx_rank_affected_seasons AS rank_affected
  UNION
  SELECT freshness.season_id
  FROM public.leaderboard_source_freshness AS freshness
  WHERE freshness.source = ANY (
    ARRAY['bingx', 'bingx_futures', 'bingx_spot']::pg_catalog.text[]
  )
  UNION
  SELECT cache.season_id
  FROM public.leaderboard_count_cache AS cache
  WHERE cache.source = ANY (
    ARRAY[
      'bingx',
      'bingx_futures',
      'bingx_spot',
      'bingx_gt0',
      'bingx_futures_gt0',
      'bingx_spot_gt0'
    ]::pg_catalog.text[]
  )
) AS affected
ORDER BY affected.season_id;

DO $season_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM bingx_surface_affected_seasons AS affected
    WHERE affected.season_id <> ALL (
      ARRAY['7D', '30D', '90D']::pg_catalog.text[]
    )
  ) THEN
    RAISE EXCEPTION
      'BingX public rank surfaces contain a non-canonical season';
  END IF;
END
$season_preflight$;

DO $quarantine$
DECLARE
  v_batch_id constant text := '20260804_bingx_rank_authority_quarantine';
  v_contract constant text := 'bingx-ranking-quarantine@1';
  v_reason constant text :=
    'population_window_and_history_authority_unverified';
  v_source_alias_map constant jsonb := pg_catalog.jsonb_build_object(
    'bingx_futures', pg_catalog.to_jsonb(
      ARRAY['bingx', 'bingx_futures']::pg_catalog.text[]
    ),
    'bingx_spot', pg_catalog.to_jsonb(
      ARRAY['bingx_spot']::pg_catalog.text[]
    )
  );
  v_public_sources constant text[] := ARRAY[
    'bingx',
    'bingx_futures',
    'bingx_spot'
  ]::pg_catalog.text[];
  v_batch arena.bingx_rank_quarantine_batches%ROWTYPE;
  v_source_rows_before jsonb;
  v_source_rows_before_sha256 text;
  v_live_count bigint;
  v_live_digest text;
  v_archive_count bigint;
  v_archive_digest text;
  v_deleted bigint;
  v_updated bigint;
  v_rank_affected_seasons text[];
  v_surface_affected_seasons text[];
  v_season_id text;
BEGIN
  SELECT batch.*
  INTO v_batch
  FROM arena.bingx_rank_quarantine_batches AS batch
  WHERE batch.batch_id = v_batch_id;

  IF FOUND THEN
    IF v_batch.contract <> v_contract
       OR v_batch.reason <> v_reason
       OR v_batch.public_sources IS DISTINCT FROM v_public_sources
       OR v_batch.source_alias_map IS DISTINCT FROM v_source_alias_map
       OR v_batch.state <> 'COMPLETE'
       OR pg_catalog.jsonb_array_length(v_batch.source_rows_before) <> 2
       OR v_batch.source_rows_before_sha256 IS DISTINCT FROM
          pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(v_batch.source_rows_before::text, 'UTF8')
            ),
            'hex'
          )
       OR (
         SELECT pg_catalog.count(DISTINCT preimage.value->>'slug')
         FROM pg_catalog.jsonb_array_elements(
           v_batch.source_rows_before
         ) AS preimage(value)
         WHERE pg_catalog.jsonb_typeof(preimage.value) = 'object'
           AND preimage.value->>'slug' = ANY (
             ARRAY['bingx_futures', 'bingx_spot']::pg_catalog.text[]
           )
           AND preimage.value->>'status' = 'active'
           AND preimage.value->>'serving_mode' = ANY (
             ARRAY['serving', 'shadow']::pg_catalog.text[]
           )
       ) <> 2 THEN
      RAISE EXCEPTION 'BingX rank quarantine batch ledger drifted';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM arena.sources AS source
      WHERE source.slug = ANY (
        ARRAY['bingx_futures', 'bingx_spot']::pg_catalog.text[]
      )
        AND (
          source.status <> 'active'
          OR source.serving_mode <> 'shadow'
          OR source.meta->>'rank_visibility_contract' <> v_contract
        )
    ) THEN
      RAISE EXCEPTION
        'completed BingX quarantine requires both active shadow sources';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.leaderboard_ranks AS rank_row
      WHERE rank_row.source = ANY (v_public_sources)
    ) OR EXISTS (
      SELECT 1
      FROM public.leaderboard_source_freshness AS freshness
      WHERE freshness.source = ANY (v_public_sources)
    ) OR EXISTS (
      SELECT 1
      FROM public.leaderboard_count_cache AS cache
      WHERE cache.source = ANY (
        ARRAY[
          'bingx',
          'bingx_futures',
          'bingx_spot',
          'bingx_gt0',
          'bingx_futures_gt0',
          'bingx_spot_gt0'
        ]::pg_catalog.text[]
      )
    ) THEN
      RAISE EXCEPTION
        'completed BingX quarantine replay found republished rank surfaces';
    END IF;
  ELSE
    SELECT pg_catalog.jsonb_agg(
      pg_catalog.to_jsonb(source)
      ORDER BY source.slug COLLATE pg_catalog."C"
    )
    INTO STRICT v_source_rows_before
    FROM arena.sources AS source
    WHERE source.slug = ANY (
      ARRAY['bingx_futures', 'bingx_spot']::pg_catalog.text[]
    );

    v_source_rows_before_sha256 := pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(v_source_rows_before::text, 'UTF8')
      ),
      'hex'
    );

    SELECT
      pg_catalog.count(*),
      pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            COALESCE(
              pg_catalog.string_agg(
                pg_catalog.to_jsonb(rank_row)::text,
                E'\n' ORDER BY
                  rank_row.season_id COLLATE pg_catalog."C",
                  rank_row.source COLLATE pg_catalog."C",
                  rank_row.source_trader_id COLLATE pg_catalog."C"
              ),
              ''
            ),
            'UTF8'
          )
        ),
        'hex'
      )
    INTO v_live_count, v_live_digest
    FROM public.leaderboard_ranks AS rank_row
    WHERE rank_row.source = ANY (v_public_sources);

    INSERT INTO arena.bingx_rank_quarantine_batches (
      batch_id,
      contract,
      reason,
      public_sources,
      source_alias_map,
      source_rows_before,
      source_rows_before_sha256,
      archived_rank_count,
      archived_rank_sha256,
      state
    ) VALUES (
      v_batch_id,
      v_contract,
      v_reason,
      v_public_sources,
      v_source_alias_map,
      v_source_rows_before,
      v_source_rows_before_sha256,
      v_live_count,
      v_live_digest,
      'COMPLETE'
    );

    INSERT INTO arena.bingx_rank_quarantine_rows (
      batch_id,
      live_rank_id,
      season_id,
      source,
      source_trader_id,
      row_data,
      reason
    )
    SELECT
      v_batch_id,
      rank_row.id::text,
      rank_row.season_id,
      rank_row.source,
      rank_row.source_trader_id,
      pg_catalog.to_jsonb(rank_row),
      v_reason
    FROM public.leaderboard_ranks AS rank_row
    WHERE rank_row.source = ANY (v_public_sources)
    ORDER BY
      rank_row.season_id COLLATE pg_catalog."C",
      rank_row.source COLLATE pg_catalog."C",
      rank_row.source_trader_id COLLATE pg_catalog."C";

    SELECT
      pg_catalog.count(*),
      pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            COALESCE(
              pg_catalog.string_agg(
                archive.row_data::text,
                E'\n' ORDER BY
                  archive.season_id COLLATE pg_catalog."C",
                  archive.source COLLATE pg_catalog."C",
                  archive.source_trader_id COLLATE pg_catalog."C"
              ),
              ''
            ),
            'UTF8'
          )
        ),
        'hex'
      )
    INTO v_archive_count, v_archive_digest
    FROM arena.bingx_rank_quarantine_rows AS archive
    WHERE archive.batch_id = v_batch_id;

    IF v_archive_count <> v_live_count
       OR v_archive_digest <> v_live_digest THEN
      RAISE EXCEPTION
        'BingX rank archive mismatch: live %/%, archive %/%',
        v_live_count,
        v_live_digest,
        v_archive_count,
        v_archive_digest;
    END IF;

    UPDATE arena.sources AS source
    SET
      serving_mode = 'shadow',
      meta = COALESCE(source.meta, '{}'::jsonb)
        || pg_catalog.jsonb_build_object(
          'rank_visibility', 'shadow',
          'rank_visibility_contract', v_contract,
          'rank_visibility_blocker', v_reason,
          'rank_visibility_blockers', pg_catalog.to_jsonb(ARRAY[
            'population_authority_unverified',
            'native_window_boundary_unverified',
            'record_history_completeness_unverified'
          ]::pg_catalog.text[]),
          'rank_visibility_reviewed_at', '2026-08-03',
          'rank_visibility_note',
            'Keep BingX collection, profiles, records, snapshots, stats, series, and RAW evidence; exclude Arena Score until population, window, and record-history authorities are receipt-bound and reviewed.'
        )
    WHERE source.slug = ANY (
      ARRAY['bingx_futures', 'bingx_spot']::pg_catalog.text[]
    )
      AND source.status = 'active'
      AND source.serving_mode IN ('serving', 'shadow');

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 2 THEN
      RAISE EXCEPTION 'expected to shadow two BingX sources, updated %', v_updated;
    END IF;

    DELETE FROM public.leaderboard_ranks AS rank_row
    WHERE rank_row.source = ANY (v_public_sources);

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    IF v_deleted <> v_live_count THEN
      RAISE EXCEPTION
        'BingX public-rank delete mismatch: expected %, deleted %',
        v_live_count,
        v_deleted;
    END IF;

    DELETE FROM public.leaderboard_source_freshness AS freshness
    WHERE freshness.source = ANY (v_public_sources);

    SELECT pg_catalog.array_agg(affected.season_id ORDER BY affected.season_id)
    INTO v_rank_affected_seasons
    FROM bingx_rank_affected_seasons AS affected;

    IF pg_catalog.cardinality(v_rank_affected_seasons) > 0 THEN
      FOREACH v_season_id IN ARRAY v_rank_affected_seasons
      LOOP
        PERFORM public.rerank_public_eligible_leaderboard(v_season_id);
      END LOOP;
    END IF;

    SELECT pg_catalog.array_agg(affected.season_id ORDER BY affected.season_id)
    INTO v_surface_affected_seasons
    FROM bingx_surface_affected_seasons AS affected;

    IF pg_catalog.cardinality(v_surface_affected_seasons) > 0 THEN
      PERFORM public.refresh_public_rank_count_cache_for_seasons(
        v_surface_affected_seasons
      );
    END IF;
  END IF;
END
$quarantine$;

-- Run full data/archive checks before guard DDL upgrades the public relations
-- to ACCESS EXCLUSIVE. The final blocking window below contains only four
-- constraint replacements and a small catalog verification.
DO $data_postflight$
DECLARE
  v_batch_id constant text := '20260804_bingx_rank_authority_quarantine';
  v_contract constant text := 'bingx-ranking-quarantine@1';
  v_batch arena.bingx_rank_quarantine_batches%ROWTYPE;
  v_archive_count bigint;
  v_archive_digest text;
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM arena.sources AS source
    WHERE source.slug = ANY (
      ARRAY['bingx_futures', 'bingx_spot']::pg_catalog.text[]
    )
      AND source.status = 'active'
      AND source.serving_mode = 'shadow'
      AND source.meta->>'rank_visibility' = 'shadow'
      AND source.meta->>'rank_visibility_contract' = v_contract
      AND source.meta->>'rank_visibility_blocker' =
          'population_window_and_history_authority_unverified'
      AND source.meta->'rank_visibility_blockers'
          ? 'population_authority_unverified'
      AND source.meta->'rank_visibility_blockers'
          ? 'native_window_boundary_unverified'
      AND source.meta->'rank_visibility_blockers'
          ? 'record_history_completeness_unverified'
  ) <> 2 THEN
    RAISE EXCEPTION 'BingX source shadow postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.leaderboard_ranks AS rank_row
    WHERE rank_row.source = ANY (
      ARRAY['bingx', 'bingx_futures', 'bingx_spot']::pg_catalog.text[]
    )
  ) THEN
    RAISE EXCEPTION 'BingX public ranks remain after quarantine';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.leaderboard_source_freshness AS freshness
    WHERE freshness.source = ANY (
      ARRAY['bingx', 'bingx_futures', 'bingx_spot']::pg_catalog.text[]
    )
  ) THEN
    RAISE EXCEPTION 'BingX public freshness remains after quarantine';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.leaderboard_count_cache AS cache
    WHERE cache.source = ANY (
      ARRAY[
        'bingx',
        'bingx_futures',
        'bingx_spot',
        'bingx_gt0',
        'bingx_futures_gt0',
        'bingx_spot_gt0'
      ]::pg_catalog.text[]
    )
  ) THEN
    RAISE EXCEPTION 'BingX public count cache remains after quarantine';
  END IF;

  IF EXISTS (
    WITH expected AS (
      SELECT
        rank_row.season_id,
        '_all'::text AS source,
        pg_catalog.count(*)::integer AS total_count
      FROM public.leaderboard_ranks AS rank_row
      JOIN bingx_surface_affected_seasons AS affected
        ON affected.season_id = rank_row.season_id
      WHERE rank_row.arena_score > 10
        AND rank_row.is_outlier IS NOT TRUE
      GROUP BY rank_row.season_id
      UNION ALL
      SELECT
        rank_row.season_id,
        rank_row.source,
        pg_catalog.count(*)::integer
      FROM public.leaderboard_ranks AS rank_row
      JOIN bingx_surface_affected_seasons AS affected
        ON affected.season_id = rank_row.season_id
      WHERE rank_row.arena_score > 10
        AND rank_row.is_outlier IS NOT TRUE
      GROUP BY rank_row.season_id, rank_row.source
      UNION ALL
      SELECT
        rank_row.season_id,
        '_all_gt0'::text,
        pg_catalog.count(*)::integer
      FROM public.leaderboard_ranks AS rank_row
      JOIN bingx_surface_affected_seasons AS affected
        ON affected.season_id = rank_row.season_id
      WHERE rank_row.rank IS NOT NULL
        AND rank_row.arena_score > 0
        AND rank_row.is_outlier IS NOT TRUE
      GROUP BY rank_row.season_id
      UNION ALL
      SELECT
        rank_row.season_id,
        rank_row.source || '_gt0',
        pg_catalog.count(*)::integer
      FROM public.leaderboard_ranks AS rank_row
      JOIN bingx_surface_affected_seasons AS affected
        ON affected.season_id = rank_row.season_id
      WHERE rank_row.rank IS NOT NULL
        AND rank_row.arena_score > 0
        AND rank_row.is_outlier IS NOT TRUE
      GROUP BY rank_row.season_id, rank_row.source
    ), actual AS (
      SELECT cache.season_id, cache.source, cache.total_count
      FROM public.leaderboard_count_cache AS cache
      JOIN bingx_surface_affected_seasons AS affected
        ON affected.season_id = cache.season_id
    )
    SELECT 1
    FROM expected
    FULL JOIN actual USING (season_id, source, total_count)
    WHERE expected.source IS NULL OR actual.source IS NULL
  ) THEN
    RAISE EXCEPTION 'BingX affected count-cache generation postflight failed';
  END IF;

  IF EXISTS (
    WITH rank_authority AS MATERIALIZED (
      SELECT DISTINCT
        authority.season_id,
        authority.filter_source AS source
      FROM public.arena_freshness_expected_sources() AS authority
      JOIN bingx_rank_affected_seasons AS affected
        ON affected.season_id = authority.season_id
    ),
    classified AS MATERIALIZED (
      SELECT
        rank_row.id,
        rank_row.season_id,
        rank_row.arena_score,
        rank_authority.source IS NOT NULL
          AND arena.leaderboard_rank_row_is_public_eligible(
            rank_row,
            pg_catalog.transaction_timestamp()
          ) AS is_eligible
      FROM public.leaderboard_ranks AS rank_row
      JOIN bingx_rank_affected_seasons AS affected
        ON affected.season_id = rank_row.season_id
      LEFT JOIN rank_authority
        ON rank_authority.season_id = rank_row.season_id
       AND rank_authority.source = rank_row.source
    ),
    ordered AS MATERIALIZED (
      SELECT
        classified.id,
        classified.season_id,
        pg_catalog.row_number() OVER (
          PARTITION BY classified.season_id
          ORDER BY classified.arena_score DESC NULLS LAST, classified.id
        )::integer AS expected_rank
      FROM classified
      WHERE classified.is_eligible
    )
    SELECT 1
    FROM classified
    LEFT JOIN ordered
      ON ordered.id = classified.id
     AND ordered.season_id = classified.season_id
    JOIN public.leaderboard_ranks AS rank_row
      ON rank_row.id = classified.id
     AND rank_row.season_id = classified.season_id
    WHERE rank_row.rank IS DISTINCT FROM ordered.expected_rank
       OR rank_row.rank_change IS NOT NULL
       OR rank_row.is_new IS DISTINCT FROM false
  ) THEN
    RAISE EXCEPTION 'BingX administrative rerank postflight failed';
  END IF;

  SELECT batch.*
  INTO STRICT v_batch
  FROM arena.bingx_rank_quarantine_batches AS batch
  WHERE batch.batch_id = v_batch_id
    AND batch.contract = v_contract
    AND batch.state = 'COMPLETE';

  SELECT
    pg_catalog.count(*),
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          COALESCE(
            pg_catalog.string_agg(
              archive.row_data::text,
              E'\n' ORDER BY
                archive.season_id COLLATE pg_catalog."C",
                archive.source COLLATE pg_catalog."C",
                archive.source_trader_id COLLATE pg_catalog."C"
            ),
            ''
          ),
          'UTF8'
        )
      ),
      'hex'
    )
  INTO v_archive_count, v_archive_digest
  FROM arena.bingx_rank_quarantine_rows AS archive
  WHERE archive.batch_id = v_batch_id;

  IF v_archive_count <> v_batch.archived_rank_count
     OR v_archive_digest <> v_batch.archived_rank_sha256
     OR v_batch.source_rows_before_sha256 IS DISTINCT FROM
        pg_catalog.encode(
          pg_catalog.sha256(
            pg_catalog.convert_to(v_batch.source_rows_before::text, 'UTF8')
          ),
          'hex'
        )
     OR (
       SELECT pg_catalog.count(DISTINCT preimage.value->>'slug')
       FROM pg_catalog.jsonb_array_elements(
         v_batch.source_rows_before
       ) AS preimage(value)
       WHERE pg_catalog.jsonb_typeof(preimage.value) = 'object'
         AND preimage.value->>'slug' = ANY (
           ARRAY['bingx_futures', 'bingx_spot']::pg_catalog.text[]
         )
     ) <> 2
     OR EXISTS (
       SELECT 1
       FROM arena.bingx_rank_quarantine_rows AS archive
       WHERE archive.batch_id = v_batch_id
         AND (
           archive.row_data->>'id' IS DISTINCT FROM archive.live_rank_id
           OR archive.row_data->>'season_id' IS DISTINCT FROM archive.season_id
           OR archive.row_data->>'source' IS DISTINCT FROM archive.source
           OR archive.row_data->>'source_trader_id'
              IS DISTINCT FROM archive.source_trader_id
           OR archive.reason IS DISTINCT FROM
              'population_window_and_history_authority_unverified'
         )
     ) THEN
    RAISE EXCEPTION 'BingX rank archive postflight failed';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = ANY (ARRAY[
      'arena.bingx_rank_quarantine_batches'::pg_catalog.regclass,
      'arena.bingx_rank_quarantine_rows'::pg_catalog.regclass
    ]::pg_catalog.oid[])
      AND relation.relowner = 'postgres'::pg_catalog.regrole
      AND relation.relrowsecurity
  ) <> 2
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_policy AS policy
       WHERE policy.polrelid = ANY (ARRAY[
         'arena.bingx_rank_quarantine_batches'::pg_catalog.regclass,
         'arena.bingx_rank_quarantine_rows'::pg_catalog.regclass
       ]::pg_catalog.oid[])
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid = ANY (ARRAY[
         'arena.bingx_rank_quarantine_batches'::pg_catalog.regclass,
         'arena.bingx_rank_quarantine_rows'::pg_catalog.regclass
       ]::pg_catalog.oid[])
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
         AND attribute.attacl IS NOT NULL
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS relation
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           relation.relacl,
           pg_catalog.acldefault('r', relation.relowner)
         )
       ) AS privilege
       WHERE relation.oid = ANY (ARRAY[
         'arena.bingx_rank_quarantine_batches'::pg_catalog.regclass,
         'arena.bingx_rank_quarantine_rows'::pg_catalog.regclass
       ]::pg_catalog.oid[])
         AND privilege.grantee <> relation.relowner
         AND (
           privilege.grantee <> 'service_role'::pg_catalog.regrole
           OR privilege.privilege_type <> 'SELECT'
           OR privilege.is_grantable
         )
     )
     OR (
       SELECT pg_catalog.count(*)
       FROM (
         VALUES
           ('arena.bingx_rank_quarantine_batches'::pg_catalog.regclass),
           ('arena.bingx_rank_quarantine_rows'::pg_catalog.regclass)
       ) AS archive(relation_oid)
       WHERE pg_catalog.has_table_privilege(
         'service_role', archive.relation_oid, 'SELECT'
       )
     ) <> 2 THEN
    RAISE EXCEPTION 'BingX private archive ACL postflight failed';
  END IF;
END
$data_postflight$;

-- Rebuild all four guards on replay. A same-named weakened constraint is not
-- accepted as proof; validation fails atomically if stale rows reappeared.
ALTER TABLE arena.sources
  DROP CONSTRAINT IF EXISTS sources_block_unverified_bingx_serving;
ALTER TABLE arena.sources
  ADD CONSTRAINT sources_block_unverified_bingx_serving
  CHECK (
    slug <> ALL (
      ARRAY['bingx_futures', 'bingx_spot']::pg_catalog.text[]
    )
    OR serving_mode <> 'serving'
  ) NOT VALID;
ALTER TABLE arena.sources
  VALIDATE CONSTRAINT sources_block_unverified_bingx_serving;

ALTER TABLE public.leaderboard_ranks
  DROP CONSTRAINT IF EXISTS leaderboard_ranks_block_unverified_bingx;
ALTER TABLE public.leaderboard_ranks
  ADD CONSTRAINT leaderboard_ranks_block_unverified_bingx
  CHECK (
    source <> ALL (
      ARRAY['bingx', 'bingx_futures', 'bingx_spot']::pg_catalog.text[]
    )
  ) NOT VALID;
ALTER TABLE public.leaderboard_ranks
  VALIDATE CONSTRAINT leaderboard_ranks_block_unverified_bingx;

ALTER TABLE public.leaderboard_source_freshness
  DROP CONSTRAINT IF EXISTS leaderboard_freshness_block_unverified_bingx;
ALTER TABLE public.leaderboard_source_freshness
  ADD CONSTRAINT leaderboard_freshness_block_unverified_bingx
  CHECK (
    source <> ALL (
      ARRAY['bingx', 'bingx_futures', 'bingx_spot']::pg_catalog.text[]
    )
  ) NOT VALID;
ALTER TABLE public.leaderboard_source_freshness
  VALIDATE CONSTRAINT leaderboard_freshness_block_unverified_bingx;

ALTER TABLE public.leaderboard_count_cache
  DROP CONSTRAINT IF EXISTS leaderboard_count_cache_block_unverified_bingx;
ALTER TABLE public.leaderboard_count_cache
  ADD CONSTRAINT leaderboard_count_cache_block_unverified_bingx
  CHECK (
    source <> ALL (
      ARRAY[
        'bingx',
        'bingx_futures',
        'bingx_spot',
        'bingx_gt0',
        'bingx_futures_gt0',
        'bingx_spot_gt0'
      ]::pg_catalog.text[]
    )
  ) NOT VALID;
ALTER TABLE public.leaderboard_count_cache
  VALIDATE CONSTRAINT leaderboard_count_cache_block_unverified_bingx;

DO $guard_postflight$
DECLARE
  v_guard_count integer;
BEGIN
  SELECT pg_catalog.count(*)::integer
  INTO v_guard_count
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE (
    (
      constraint_row.conrelid = 'arena.sources'::pg_catalog.regclass
      AND constraint_row.conname =
          'sources_block_unverified_bingx_serving'
    ) OR (
      constraint_row.conrelid =
          'public.leaderboard_ranks'::pg_catalog.regclass
      AND constraint_row.conname =
          'leaderboard_ranks_block_unverified_bingx'
    ) OR (
      constraint_row.conrelid =
          'public.leaderboard_source_freshness'::pg_catalog.regclass
      AND constraint_row.conname =
          'leaderboard_freshness_block_unverified_bingx'
    ) OR (
      constraint_row.conrelid =
          'public.leaderboard_count_cache'::pg_catalog.regclass
      AND constraint_row.conname =
          'leaderboard_count_cache_block_unverified_bingx'
    )
  )
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated;

  IF v_guard_count <> 4 THEN
    RAISE EXCEPTION 'BingX quarantine guard postflight failed: %/4', v_guard_count;
  END IF;
END
$guard_postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
