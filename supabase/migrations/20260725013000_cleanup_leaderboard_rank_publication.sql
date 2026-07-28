-- Publication-scoped season-wide leaderboard cleanup.
--
-- The legacy per-platform cleanup can leave a partially mutated season when a
-- later source fails. This dormant RPC accepts the complete authority identity
-- set for one score cohort, validates it under the same registry/rank lock
-- order as terminal rerank and seal, and removes every other authority row in
-- one transaction. Non-authority/profile rows are deliberately out of scope.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('public.leaderboard_ranks') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.exchanges') IS NULL
     OR pg_catalog.to_regclass(
       'arena.leaderboard_rank_mutation_fences'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.arena_freshness_expected_sources()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.rerank_leaderboard_publication(text,uuid)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.seal_leaderboard_rank_publication(text,uuid,jsonb)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.bump_leaderboard_rank_delete_fences()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.reject_leaderboard_rank_publication_mutation()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'extensions.digest(bytea,text)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'leaderboard publication mutation fence must exist before cleanup RPC';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.leaderboard_ranks'::pg_catalog.regclass
      AND attribute.attname = 'rank_publication_id'
      AND attribute.atttypid = 'pg_catalog.uuid'::pg_catalog.regtype
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION
      'leaderboard_ranks.rank_publication_id uuid must exist before cleanup RPC';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid =
      'arena.reject_leaderboard_rank_publication_mutation()'
        ::pg_catalog.regprocedure
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prokind = 'f'
      AND function_row.prosecdef
      AND NOT function_row.proleakproof
      AND NOT function_row.proisstrict
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND function_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
      AND NOT function_row.proretset
      AND function_row.pronargs = 0
      AND function_row.pronargdefaults = 0
      AND language_row.lanname = 'plpgsql'
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
      AND pg_catalog.btrim(
        pg_catalog.regexp_replace(
          function_row.prosrc,
          '[[:space:]]+',
          ' ',
          'g'
        )
      ) =
        'BEGIN RAISE EXCEPTION ''leaderboard publication receipts are immutable'' USING ERRCODE = ''55000''; END;'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            function_row.proacl,
            pg_catalog.acldefault('f', function_row.proowner)
          )
        ) AS expanded
        WHERE expanded.grantee <> function_row.proowner
      )
  ) THEN
    RAISE EXCEPTION
      'leaderboard publication receipt immutability guard drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
      'public.leaderboard_ranks'::pg_catalog.regclass
      AND trigger_row.tgname = 'leaderboard_rank_delete_fence'
      AND trigger_row.tgfoid =
        'arena.bump_leaderboard_rank_delete_fences()'
          ::pg_catalog.regprocedure
      AND trigger_row.tgoldtable = 'old_rank_rows'
      AND trigger_row.tgnewtable IS NULL
      AND trigger_row.tgtype = 8
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = ANY (ARRAY['O', 'A']::"char"[])
  ) THEN
    RAISE EXCEPTION
      'leaderboard parent DELETE mutation fence must be enabled';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
      'arena.bump_leaderboard_rank_delete_fences()'
        ::pg_catalog.regprocedure
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prosecdef
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
  ) THEN
    RAISE EXCEPTION
      'leaderboard parent DELETE mutation fence function drifted';
  END IF;

  -- CREATE OR REPLACE preserves existing overloads. Refuse to install beside
  -- any same-name surface because PostgREST overload resolution must have one
  -- unambiguous cleanup contract.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND function_row.proname = 'cleanup_leaderboard_rank_publication'
      AND function_row.oid IS DISTINCT FROM pg_catalog.to_regprocedure(
        'public.cleanup_leaderboard_rank_publication(text,uuid,jsonb)'
      )
  ) THEN
    RAISE EXCEPTION
      'leaderboard publication cleanup has an unsupported overload';
  END IF;

  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'database owner and PostgREST API roles must exist';
  END IF;

  -- A same-name relation left by an interrupted or out-of-band deployment is
  -- more dangerous than a missing table: CREATE TABLE IF NOT EXISTS would
  -- silently accept its shape. On replay, require the complete closed table
  -- contract before any DDL or RPC replacement is attempted.
  IF pg_catalog.to_regclass(
       'arena.leaderboard_rank_cleanup_receipts'
     ) IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS table_row
      WHERE table_row.oid =
        'arena.leaderboard_rank_cleanup_receipts'::pg_catalog.regclass
        AND table_row.relkind = 'r'
        AND table_row.relpersistence = 'p'
        AND table_row.relowner = 'postgres'::pg_catalog.regrole
        AND table_row.relrowsecurity
        AND NOT table_row.relforcerowsecurity
    ) OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid =
        'arena.leaderboard_rank_cleanup_receipts'::pg_catalog.regclass
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ) <> 8 OR EXISTS (
      SELECT 1
      FROM (
        VALUES
          ('season_id', 'pg_catalog.text'::pg_catalog.regtype, true),
          ('score_cohort_id', 'pg_catalog.uuid'::pg_catalog.regtype, true),
          ('contract', 'pg_catalog.text'::pg_catalog.regtype, true),
          ('request_sha256', 'pg_catalog.text'::pg_catalog.regtype, true),
          ('source_count', 'pg_catalog.int4'::pg_catalog.regtype, true),
          ('kept_count', 'pg_catalog.int8'::pg_catalog.regtype, true),
          ('deleted_count', 'pg_catalog.int8'::pg_catalog.regtype, true),
          ('completed_at', 'pg_catalog.timestamptz'::pg_catalog.regtype, true)
      ) AS expected(attname, atttypid, attnotnull)
      LEFT JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid =
             'arena.leaderboard_rank_cleanup_receipts'::pg_catalog.regclass
       AND attribute.attname = expected.attname
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
      WHERE attribute.attname IS NULL
         OR attribute.atttypid IS DISTINCT FROM expected.atttypid
         OR attribute.attnotnull IS DISTINCT FROM expected.attnotnull
         OR attribute.atthasdef
         OR attribute.attgenerated <> ''
         OR attribute.attidentity <> ''
    ) OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid =
        'arena.leaderboard_rank_cleanup_receipts'::pg_catalog.regclass
    ) <> 9 OR EXISTS (
      SELECT 1
      FROM (
        VALUES
          ('leaderboard_rank_cleanup_receipts_pkey', 'p'::"char",
           'PRIMARY KEY (season_id, score_cohort_id)'),
          ('leaderboard_rank_cleanup_receipts_cohort_key', 'u'::"char",
           'UNIQUE (score_cohort_id)'),
          ('leaderboard_rank_cleanup_receipts_season_check', 'c'::"char",
           'CHECK (season_id = ANY (ARRAY[''7D''::text, ''30D''::text, ''90D''::text]))'),
          ('leaderboard_rank_cleanup_receipts_contract_check', 'c'::"char",
           'CHECK (contract = ''leaderboard-rank-publication-cleanup@1''::text)'),
          ('leaderboard_rank_cleanup_receipts_request_sha256_check', 'c'::"char",
           'CHECK (request_sha256 ~ ''^[0-9a-f]{64}$''::text)'),
          ('leaderboard_rank_cleanup_receipts_source_count_check', 'c'::"char",
           'CHECK (source_count > 0 AND source_count <= 256)'),
          ('leaderboard_rank_cleanup_receipts_kept_count_check', 'c'::"char",
           'CHECK (kept_count >= 0 AND kept_count <= 250000)'),
          ('leaderboard_rank_cleanup_receipts_deleted_count_check', 'c'::"char",
           'CHECK (deleted_count >= 0)'),
          ('leaderboard_rank_cleanup_receipts_completed_at_check', 'c'::"char",
           'CHECK (isfinite(completed_at))')
      ) AS expected(conname, contype, definition)
      LEFT JOIN pg_catalog.pg_constraint AS constraint_row
        ON constraint_row.conrelid =
             'arena.leaderboard_rank_cleanup_receipts'::pg_catalog.regclass
       AND constraint_row.conname = expected.conname
      WHERE constraint_row.oid IS NULL
         OR constraint_row.contype IS DISTINCT FROM expected.contype
         OR pg_catalog.pg_get_constraintdef(
              constraint_row.oid,
              true
            ) IS DISTINCT FROM expected.definition
         OR NOT constraint_row.convalidated
         OR constraint_row.condeferrable
    ) OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid =
        'arena.leaderboard_rank_cleanup_receipts'::pg_catalog.regclass
        AND NOT trigger_row.tgisinternal
    ) <> 1 OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid =
        'arena.leaderboard_rank_cleanup_receipts'::pg_catalog.regclass
        AND trigger_row.tgname =
          'leaderboard_rank_cleanup_receipt_immutable'
        AND trigger_row.tgfoid =
          'arena.reject_leaderboard_rank_publication_mutation()'
            ::pg_catalog.regprocedure
        AND trigger_row.tgtype = 27
        AND trigger_row.tgqual IS NULL
        AND trigger_row.tgoldtable IS NULL
        AND trigger_row.tgnewtable IS NULL
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgenabled = 'O'
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_rewrite AS rule_row
      WHERE rule_row.ev_class =
        'arena.leaderboard_rank_cleanup_receipts'::pg_catalog.regclass
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy_row
      WHERE policy_row.polrelid =
        'arena.leaderboard_rank_cleanup_receipts'::pg_catalog.regclass
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS table_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          table_row.relacl,
          pg_catalog.acldefault('r', table_row.relowner)
        )
      ) AS expanded
      WHERE table_row.oid =
        'arena.leaderboard_rank_cleanup_receipts'::pg_catalog.regclass
        AND expanded.grantee <> table_row.relowner
    ) THEN
      RAISE EXCEPTION
        'leaderboard rank cleanup receipt table drifted';
    END IF;
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS arena.leaderboard_rank_cleanup_receipts (
  season_id text NOT NULL,
  score_cohort_id uuid NOT NULL,
  contract text NOT NULL,
  request_sha256 text NOT NULL,
  source_count integer NOT NULL,
  kept_count bigint NOT NULL,
  deleted_count bigint NOT NULL,
  completed_at timestamptz NOT NULL,
  CONSTRAINT leaderboard_rank_cleanup_receipts_pkey
    PRIMARY KEY (season_id, score_cohort_id),
  CONSTRAINT leaderboard_rank_cleanup_receipts_cohort_key
    UNIQUE (score_cohort_id),
  CONSTRAINT leaderboard_rank_cleanup_receipts_season_check
    CHECK (season_id IN ('7D', '30D', '90D')),
  CONSTRAINT leaderboard_rank_cleanup_receipts_contract_check
    CHECK (contract = 'leaderboard-rank-publication-cleanup@1'),
  CONSTRAINT leaderboard_rank_cleanup_receipts_request_sha256_check
    CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT leaderboard_rank_cleanup_receipts_source_count_check
    CHECK (source_count > 0 AND source_count <= 256),
  CONSTRAINT leaderboard_rank_cleanup_receipts_kept_count_check
    CHECK (kept_count >= 0 AND kept_count <= 250000),
  CONSTRAINT leaderboard_rank_cleanup_receipts_deleted_count_check
    CHECK (deleted_count >= 0),
  CONSTRAINT leaderboard_rank_cleanup_receipts_completed_at_check
    CHECK (pg_catalog.isfinite(completed_at))
);

ALTER TABLE arena.leaderboard_rank_cleanup_receipts OWNER TO postgres;
ALTER TABLE arena.leaderboard_rank_cleanup_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON arena.leaderboard_rank_cleanup_receipts
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS leaderboard_rank_cleanup_receipt_immutable
  ON arena.leaderboard_rank_cleanup_receipts;
CREATE TRIGGER leaderboard_rank_cleanup_receipt_immutable
BEFORE UPDATE OR DELETE ON arena.leaderboard_rank_cleanup_receipts
FOR EACH ROW
EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation();

CREATE OR REPLACE FUNCTION public.cleanup_leaderboard_rank_publication(
  p_season_id text,
  p_score_cohort_id uuid,
  p_source_publications jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '10s'
AS $function$
DECLARE
  v_existing arena.leaderboard_rank_cleanup_receipts%ROWTYPE;
  v_source_count integer;
  v_authority_count integer;
  v_kept_count bigint;
  v_actual_kept_count bigint;
  v_deleted_count bigint;
  v_canonical_sources jsonb;
  v_authority_sources jsonb;
  v_request_sha256 text;
BEGIN
  IF p_season_id IS NULL OR p_season_id NOT IN ('7D', '30D', '90D') THEN
    RAISE EXCEPTION 'invalid leaderboard cleanup season: %', p_season_id
      USING ERRCODE = '22023';
  END IF;

  IF p_score_cohort_id IS NULL THEN
    RAISE EXCEPTION 'score cohort id is required'
      USING ERRCODE = '22023';
  END IF;

  IF p_source_publications IS NULL
     OR pg_catalog.jsonb_typeof(p_source_publications) <> 'array'
     OR pg_catalog.jsonb_array_length(p_source_publications) = 0
     OR pg_catalog.jsonb_array_length(p_source_publications) > 256 THEN
    RAISE EXCEPTION
      'cleanup source publications must be an array with 1..256 members'
      USING ERRCODE = '22023';
  END IF;

  IF pg_catalog.octet_length(
       pg_catalog.convert_to(p_source_publications::text, 'UTF8')
     ) > 67108864 THEN
    RAISE EXCEPTION 'cleanup source publication request exceeds 64 MiB'
      USING ERRCODE = '54000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_source_publications) AS item(value)
    WHERE pg_catalog.jsonb_typeof(item.value) <> 'object'
      OR NOT item.value ?& ARRAY['source', 'trader_ids']
      OR (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_object_keys(item.value)
      ) <> 2
      OR pg_catalog.jsonb_typeof(item.value->'source') <> 'string'
      OR pg_catalog.jsonb_typeof(item.value->'trader_ids') <> 'array'
  ) THEN
    RAISE EXCEPTION 'cleanup source publication members have an invalid shape'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_source_publications) AS item(value)
    WHERE item.value->>'source' !~ '^[a-z0-9]+(_[a-z0-9]+)*$'
       OR item.value->>'source' IS DISTINCT FROM
            pg_catalog.lower(pg_catalog.btrim(item.value->>'source'))
       OR pg_catalog.length(item.value->>'source') > 128
  ) OR EXISTS (
    SELECT item.value->>'source'
    FROM pg_catalog.jsonb_array_elements(p_source_publications) AS item(value)
    GROUP BY item.value->>'source'
    HAVING pg_catalog.count(*) <> 1
  ) THEN
    RAISE EXCEPTION
      'cleanup source publications contain invalid or duplicate sources'
      USING ERRCODE = '22023';
  END IF;

  SELECT
    pg_catalog.jsonb_array_length(p_source_publications),
    COALESCE(
      pg_catalog.sum(
        pg_catalog.jsonb_array_length(item.value->'trader_ids')
      ),
      0
    )::bigint
  INTO STRICT v_source_count, v_kept_count
  FROM pg_catalog.jsonb_array_elements(p_source_publications) AS item(value);

  IF v_kept_count > 250000 THEN
    RAISE EXCEPTION 'cleanup publication exceeds 250000 trader identities'
      USING ERRCODE = '54000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_source_publications) AS item(value)
    CROSS JOIN LATERAL
      pg_catalog.jsonb_array_elements(item.value->'trader_ids') AS trader(value)
    WHERE pg_catalog.jsonb_typeof(trader.value) <> 'string'
       OR pg_catalog.btrim(trader.value #>> '{}') = ''
       OR trader.value #>> '{}' IS DISTINCT FROM
            pg_catalog.btrim(trader.value #>> '{}')
       OR pg_catalog.length(trader.value #>> '{}') > 512
  ) OR EXISTS (
    SELECT item.value->>'source', trader.value #>> '{}'
    FROM pg_catalog.jsonb_array_elements(p_source_publications) AS item(value)
    CROSS JOIN LATERAL
      pg_catalog.jsonb_array_elements(item.value->'trader_ids') AS trader(value)
    GROUP BY item.value->>'source', trader.value #>> '{}'
    HAVING pg_catalog.count(*) <> 1
  ) THEN
    RAISE EXCEPTION
      'cleanup publication contains invalid or duplicate trader identities'
      USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'source', item.value->>'source',
      'trader_ids', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          identity.value ORDER BY identity.value COLLATE "C"
        )
        FROM pg_catalog.jsonb_array_elements_text(
          item.value->'trader_ids'
        ) AS identity(value)
      ), '[]'::pg_catalog.jsonb)
    )
    ORDER BY item.value->>'source' COLLATE "C"
  )
  INTO STRICT v_canonical_sources
  FROM pg_catalog.jsonb_array_elements(p_source_publications) AS item(value);

  v_request_sha256 := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'contract', 'leaderboard-rank-publication-cleanup@1',
          'season_id', p_season_id,
          'score_cohort_id', p_score_cohort_id,
          'sources', v_canonical_sources
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  -- Use seal's cohort lock key. The first successful transaction persists its
  -- result before releasing this lock, so concurrent duplicates and a
  -- response-loss retry observe one immutable outcome. Crucially, lookup is
  -- before current registry/rank validation: a delayed replay of an older
  -- cohort must never reinterpret its payload against or delete a newer one.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_score_cohort_id::text, 0)
  );

  SELECT receipt.*
  INTO v_existing
  FROM arena.leaderboard_rank_cleanup_receipts AS receipt
  WHERE receipt.score_cohort_id = p_score_cohort_id;

  IF FOUND THEN
    IF v_existing.season_id IS DISTINCT FROM p_season_id
       OR v_existing.contract IS DISTINCT FROM
            'leaderboard-rank-publication-cleanup@1'
       OR v_existing.request_sha256 IS DISTINCT FROM v_request_sha256
       OR v_existing.source_count IS DISTINCT FROM v_source_count
       OR v_existing.kept_count IS DISTINCT FROM v_kept_count THEN
      RAISE EXCEPTION
        'score cohort id was reused with different cleanup input'
        USING ERRCODE = '23505';
    END IF;

    IF v_existing.source_count <= 0
       OR v_existing.source_count > 256
       OR v_existing.kept_count < 0
       OR v_existing.kept_count > 250000
       OR v_existing.deleted_count < 0
       OR NOT pg_catalog.isfinite(v_existing.completed_at)
       OR v_existing.request_sha256 !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'leaderboard cleanup receipt is malformed'
        USING ERRCODE = '55000';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'contract', v_existing.contract,
      'season_id', v_existing.season_id,
      'score_cohort_id', v_existing.score_cohort_id,
      'source_count', v_existing.source_count,
      'kept_count', v_existing.kept_count,
      'deleted_count', v_existing.deleted_count
    );
  END IF;

  -- Freeze source authority before observing or mutating ranks. Registry
  -- quarantine uses this same registry -> rank order.
  LOCK TABLE arena.sources, arena.exchanges IN SHARE MODE;

  -- Materialize the exact distinct filter-source authority once. Every later
  -- validation, DELETE, and postcondition consumes these same bytes, so a
  -- concurrent function-definition change cannot split one cleanup across two
  -- authority evaluations.
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      authority_set.source
      ORDER BY authority_set.source COLLATE "C" NULLS FIRST
    ),
    '[]'::pg_catalog.jsonb
  )
  INTO STRICT v_authority_sources
  FROM (
    SELECT DISTINCT authority.filter_source AS source
    FROM public.arena_freshness_expected_sources() AS authority
    WHERE authority.season_id = p_season_id
  ) AS authority_set;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(v_authority_sources) AS authority(value)
    WHERE pg_catalog.jsonb_typeof(authority.value) <> 'string'
       OR authority.value #>> '{}' !~ '^[a-z0-9]+(_[a-z0-9]+)*$'
       OR authority.value #>> '{}' IS DISTINCT FROM pg_catalog.lower(
          pg_catalog.btrim(authority.value #>> '{}')
        )
       OR pg_catalog.length(authority.value #>> '{}') > 128
  ) THEN
    RAISE EXCEPTION 'season source authority contains a non-canonical source'
      USING ERRCODE = '55000';
  END IF;

  v_authority_count := pg_catalog.jsonb_array_length(v_authority_sources);

  IF v_authority_count = 0 THEN
    RAISE EXCEPTION 'season source authority is empty; cleanup refused'
      USING ERRCODE = '55000';
  END IF;

  IF v_authority_count > 256 THEN
    RAISE EXCEPTION 'season source authority exceeds 256 sources'
      USING ERRCODE = '54000';
  END IF;

  IF v_source_count IS DISTINCT FROM v_authority_count OR EXISTS (
    WITH requested AS MATERIALIZED (
      SELECT item.value->>'source' AS source
      FROM pg_catalog.jsonb_array_elements(v_canonical_sources) AS item(value)
    ),
    authority AS MATERIALIZED (
      SELECT authority_source.value AS source
      FROM pg_catalog.jsonb_array_elements_text(
        v_authority_sources
      ) AS authority_source(value)
    ),
    differences AS (
      (SELECT requested.source FROM requested
       EXCEPT
       SELECT authority.source FROM authority)
      UNION ALL
      (SELECT authority.source FROM authority
       EXCEPT
       SELECT requested.source FROM requested)
    )
    SELECT 1 FROM differences
  ) THEN
    RAISE EXCEPTION
      'cleanup source publications must exactly cover season authority'
      USING ERRCODE = '22023';
  END IF;

  -- Match terminal rerank's registry -> SHARE ROW EXCLUSIVE rank lock order.
  -- This serializes validation and deletion with all parent rank DML, rerank,
  -- cleanup retries, and the SHARE lock taken by seal.
  LOCK TABLE public.leaderboard_ranks IN SHARE ROW EXCLUSIVE MODE;

  IF EXISTS (
    WITH expected AS MATERIALIZED (
      SELECT
        item.value->>'source' AS source,
        identity.value AS source_trader_id
      FROM pg_catalog.jsonb_array_elements(v_canonical_sources) AS item(value)
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(
        item.value->'trader_ids'
      ) AS identity(value)
    )
    SELECT 1
    FROM expected
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.leaderboard_ranks AS ranks
      WHERE ranks.season_id = p_season_id
        AND ranks.source = expected.source
        AND ranks.source_trader_id = expected.source_trader_id
    )
  ) THEN
    RAISE EXCEPTION
      'cleanup expected publication identity is missing from leaderboard rows'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    WITH expected AS MATERIALIZED (
      SELECT
        item.value->>'source' AS source,
        identity.value AS source_trader_id
      FROM pg_catalog.jsonb_array_elements(v_canonical_sources) AS item(value)
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(
        item.value->'trader_ids'
      ) AS identity(value)
    )
    SELECT 1
    FROM public.leaderboard_ranks AS ranks
    JOIN expected
      ON expected.source = ranks.source
     AND expected.source_trader_id = ranks.source_trader_id
    WHERE ranks.season_id = p_season_id
      AND ranks.rank_publication_id IS DISTINCT FROM p_score_cohort_id
  ) THEN
    RAISE EXCEPTION
      'cleanup expected publication identity has the wrong score cohort'
      USING ERRCODE = '23514';
  END IF;

  WITH expected AS MATERIALIZED (
    SELECT
      item.value->>'source' AS source,
      identity.value AS source_trader_id
    FROM pg_catalog.jsonb_array_elements(v_canonical_sources) AS item(value)
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(
      item.value->'trader_ids'
    ) AS identity(value)
  )
  SELECT pg_catalog.count(*)::bigint
  INTO STRICT v_actual_kept_count
  FROM public.leaderboard_ranks AS ranks
  JOIN expected
    ON expected.source = ranks.source
   AND expected.source_trader_id = ranks.source_trader_id
  WHERE ranks.season_id = p_season_id
    AND ranks.rank_publication_id IS NOT DISTINCT FROM p_score_cohort_id;

  IF v_actual_kept_count IS DISTINCT FROM v_kept_count THEN
    RAISE EXCEPTION
      'cleanup expected publication identities are not one-to-one leaderboard rows'
      USING ERRCODE = '23514';
  END IF;

  WITH authority AS MATERIALIZED (
    SELECT authority_source.value AS source
    FROM pg_catalog.jsonb_array_elements_text(
      v_authority_sources
    ) AS authority_source(value)
  ),
  expected AS MATERIALIZED (
    SELECT
      item.value->>'source' AS source,
      identity.value AS source_trader_id
    FROM pg_catalog.jsonb_array_elements(v_canonical_sources) AS item(value)
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(
      item.value->'trader_ids'
    ) AS identity(value)
  )
  DELETE FROM public.leaderboard_ranks AS ranks
  USING authority
  WHERE ranks.season_id = p_season_id
    AND ranks.source = authority.source
    AND NOT EXISTS (
      SELECT 1
      FROM expected
      WHERE expected.source = ranks.source
        AND expected.source_trader_id = ranks.source_trader_id
        AND ranks.rank_publication_id IS NOT DISTINCT FROM p_score_cohort_id
    );

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  WITH authority AS MATERIALIZED (
    SELECT authority_source.value AS source
    FROM pg_catalog.jsonb_array_elements_text(
      v_authority_sources
    ) AS authority_source(value)
  )
  SELECT pg_catalog.count(*)::bigint
  INTO STRICT v_actual_kept_count
  FROM public.leaderboard_ranks AS ranks
  JOIN authority ON authority.source = ranks.source
  WHERE ranks.season_id = p_season_id;

  IF v_actual_kept_count IS DISTINCT FROM v_kept_count OR EXISTS (
    SELECT 1
    FROM public.leaderboard_ranks AS ranks
    JOIN (
      SELECT authority_source.value AS source
      FROM pg_catalog.jsonb_array_elements_text(
        v_authority_sources
      ) AS authority_source(value)
    ) AS authority ON authority.source = ranks.source
    WHERE ranks.season_id = p_season_id
      AND ranks.rank_publication_id IS DISTINCT FROM p_score_cohort_id
  ) OR EXISTS (
    WITH expected AS MATERIALIZED (
      SELECT
        item.value->>'source' AS source,
        identity.value AS source_trader_id
      FROM pg_catalog.jsonb_array_elements(v_canonical_sources) AS item(value)
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(
        item.value->'trader_ids'
      ) AS identity(value)
    ),
    authority AS MATERIALIZED (
      SELECT authority_source.value AS source
      FROM pg_catalog.jsonb_array_elements_text(
        v_authority_sources
      ) AS authority_source(value)
    ),
    actual AS MATERIALIZED (
      SELECT ranks.source, ranks.source_trader_id
      FROM public.leaderboard_ranks AS ranks
      JOIN authority ON authority.source = ranks.source
      WHERE ranks.season_id = p_season_id
        AND ranks.rank_publication_id IS NOT DISTINCT FROM p_score_cohort_id
    ),
    differences AS (
      (SELECT expected.source, expected.source_trader_id FROM expected
       EXCEPT
       SELECT actual.source, actual.source_trader_id FROM actual)
      UNION ALL
      (SELECT actual.source, actual.source_trader_id FROM actual
       EXCEPT
       SELECT expected.source, expected.source_trader_id FROM expected)
    )
    SELECT 1 FROM differences
  ) THEN
    RAISE EXCEPTION 'leaderboard cleanup postcondition failed'
      USING ERRCODE = '55000';
  END IF;

  -- Commit the replay receipt in the same transaction as the DELETE. Any
  -- validation error or uniqueness failure rolls both changes back; once this
  -- row exists, its UPDATE/DELETE trigger makes the original result immutable.
  INSERT INTO arena.leaderboard_rank_cleanup_receipts (
    season_id,
    score_cohort_id,
    contract,
    request_sha256,
    source_count,
    kept_count,
    deleted_count,
    completed_at
  ) VALUES (
    p_season_id,
    p_score_cohort_id,
    'leaderboard-rank-publication-cleanup@1',
    v_request_sha256,
    v_source_count,
    v_kept_count,
    v_deleted_count,
    pg_catalog.clock_timestamp()
  );

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-rank-publication-cleanup@1',
    'season_id', p_season_id,
    'score_cohort_id', p_score_cohort_id,
    'source_count', v_source_count,
    'kept_count', v_kept_count,
    'deleted_count', v_deleted_count
  );
END;
$function$;

ALTER FUNCTION public.cleanup_leaderboard_rank_publication(text, uuid, jsonb)
  OWNER TO postgres;

-- CREATE OR REPLACE also preserves arbitrary historical ACL entries. Converge
-- the EXECUTE boundary dynamically, including PUBLIC's synthetic grantee OID
-- 0 and quoted role names. CASCADE removes grants delegated by a rogue role.
DO $revoke_rogue_execute$
DECLARE
  v_grantee oid;
  v_role_name text;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT expanded.grantee
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS expanded
    WHERE function_row.oid =
      'public.cleanup_leaderboard_rank_publication(text,uuid,jsonb)'
        ::pg_catalog.regprocedure
      AND expanded.privilege_type = 'EXECUTE'
      AND expanded.grantee <> function_row.proowner
      AND expanded.grantee <> 'service_role'::pg_catalog.regrole
    ORDER BY expanded.grantee
  LOOP
    IF v_grantee = 0 THEN
      EXECUTE
        'REVOKE EXECUTE ON FUNCTION public.cleanup_leaderboard_rank_publication(text, uuid, jsonb) FROM PUBLIC CASCADE';
    ELSE
      SELECT role_row.rolname
      INTO STRICT v_role_name
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.oid = v_grantee;

      EXECUTE pg_catalog.format(
        'REVOKE EXECUTE ON FUNCTION public.cleanup_leaderboard_rank_publication(text, uuid, jsonb) FROM %I CASCADE',
        v_role_name
      );
    END IF;
  END LOOP;
END
$revoke_rogue_execute$;

REVOKE EXECUTE
  ON FUNCTION public.cleanup_leaderboard_rank_publication(text, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE GRANT OPTION FOR EXECUTE
  ON FUNCTION public.cleanup_leaderboard_rank_publication(text, uuid, jsonb)
  FROM service_role CASCADE;
GRANT EXECUTE
  ON FUNCTION public.cleanup_leaderboard_rank_publication(text, uuid, jsonb)
  TO service_role;

COMMENT ON FUNCTION public.cleanup_leaderboard_rank_publication(
  text,
  uuid,
  jsonb
) IS
  'Dormant publication-scoped cleanup: validate the exact authority identity/cohort set, atomically delete every other authority row, and persist an immutable replay receipt. Callers must enforce the RPC request deadline.';

COMMENT ON TABLE arena.leaderboard_rank_cleanup_receipts IS
  'Immutable exact-input receipts for atomic leaderboard cleanup. Historical replay returns the original result and never mutates a newer score cohort.';

DO $postflight$
BEGIN
  IF pg_catalog.to_regclass(
       'arena.leaderboard_rank_cleanup_receipts'
     ) IS NULL THEN
    RAISE EXCEPTION
      'leaderboard rank cleanup receipt table postflight failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS table_row
    WHERE table_row.oid =
      'arena.leaderboard_rank_cleanup_receipts'::pg_catalog.regclass
      AND table_row.relkind = 'r'
      AND table_row.relpersistence = 'p'
      AND table_row.relowner = 'postgres'::pg_catalog.regrole
      AND table_row.relrowsecurity
      AND NOT table_row.relforcerowsecurity
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
      'arena.leaderboard_rank_cleanup_receipts'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 8 OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('season_id', 'pg_catalog.text'::pg_catalog.regtype, true),
        ('score_cohort_id', 'pg_catalog.uuid'::pg_catalog.regtype, true),
        ('contract', 'pg_catalog.text'::pg_catalog.regtype, true),
        ('request_sha256', 'pg_catalog.text'::pg_catalog.regtype, true),
        ('source_count', 'pg_catalog.int4'::pg_catalog.regtype, true),
        ('kept_count', 'pg_catalog.int8'::pg_catalog.regtype, true),
        ('deleted_count', 'pg_catalog.int8'::pg_catalog.regtype, true),
        ('completed_at', 'pg_catalog.timestamptz'::pg_catalog.regtype, true)
    ) AS expected(attname, atttypid, attnotnull)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid =
           'arena.leaderboard_rank_cleanup_receipts'::pg_catalog.regclass
     AND attribute.attname = expected.attname
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attname IS NULL
       OR attribute.atttypid IS DISTINCT FROM expected.atttypid
       OR attribute.attnotnull IS DISTINCT FROM expected.attnotnull
       OR attribute.atthasdef
       OR attribute.attgenerated <> ''
       OR attribute.attidentity <> ''
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'arena.leaderboard_rank_cleanup_receipts'::pg_catalog.regclass
  ) <> 9 OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('leaderboard_rank_cleanup_receipts_pkey', 'p'::"char",
         'PRIMARY KEY (season_id, score_cohort_id)'),
        ('leaderboard_rank_cleanup_receipts_cohort_key', 'u'::"char",
         'UNIQUE (score_cohort_id)'),
        ('leaderboard_rank_cleanup_receipts_season_check', 'c'::"char",
         'CHECK (season_id = ANY (ARRAY[''7D''::text, ''30D''::text, ''90D''::text]))'),
        ('leaderboard_rank_cleanup_receipts_contract_check', 'c'::"char",
         'CHECK (contract = ''leaderboard-rank-publication-cleanup@1''::text)'),
        ('leaderboard_rank_cleanup_receipts_request_sha256_check', 'c'::"char",
         'CHECK (request_sha256 ~ ''^[0-9a-f]{64}$''::text)'),
        ('leaderboard_rank_cleanup_receipts_source_count_check', 'c'::"char",
         'CHECK (source_count > 0 AND source_count <= 256)'),
        ('leaderboard_rank_cleanup_receipts_kept_count_check', 'c'::"char",
         'CHECK (kept_count >= 0 AND kept_count <= 250000)'),
        ('leaderboard_rank_cleanup_receipts_deleted_count_check', 'c'::"char",
         'CHECK (deleted_count >= 0)'),
        ('leaderboard_rank_cleanup_receipts_completed_at_check', 'c'::"char",
         'CHECK (isfinite(completed_at))')
    ) AS expected(conname, contype, definition)
    LEFT JOIN pg_catalog.pg_constraint AS constraint_row
      ON constraint_row.conrelid =
           'arena.leaderboard_rank_cleanup_receipts'::pg_catalog.regclass
     AND constraint_row.conname = expected.conname
    WHERE constraint_row.oid IS NULL
       OR constraint_row.contype IS DISTINCT FROM expected.contype
       OR pg_catalog.pg_get_constraintdef(
            constraint_row.oid,
            true
          ) IS DISTINCT FROM expected.definition
       OR NOT constraint_row.convalidated
       OR constraint_row.condeferrable
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
      'arena.leaderboard_rank_cleanup_receipts'::pg_catalog.regclass
      AND NOT trigger_row.tgisinternal
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
      'arena.leaderboard_rank_cleanup_receipts'::pg_catalog.regclass
      AND trigger_row.tgname =
        'leaderboard_rank_cleanup_receipt_immutable'
      AND trigger_row.tgfoid =
        'arena.reject_leaderboard_rank_publication_mutation()'
          ::pg_catalog.regprocedure
      AND trigger_row.tgtype = 27
      AND trigger_row.tgqual IS NULL
      AND trigger_row.tgoldtable IS NULL
      AND trigger_row.tgnewtable IS NULL
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rule_row
    WHERE rule_row.ev_class =
      'arena.leaderboard_rank_cleanup_receipts'::pg_catalog.regclass
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid =
      'arena.leaderboard_rank_cleanup_receipts'::pg_catalog.regclass
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS table_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        table_row.relacl,
        pg_catalog.acldefault('r', table_row.relowner)
      )
    ) AS expanded
    WHERE table_row.oid =
      'arena.leaderboard_rank_cleanup_receipts'::pg_catalog.regclass
      AND expanded.grantee <> table_row.relowner
  ) THEN
    RAISE EXCEPTION
      'leaderboard rank cleanup receipt table postflight failed';
  END IF;

  IF pg_catalog.to_regprocedure(
       'public.cleanup_leaderboard_rank_publication(text,uuid,jsonb)'
     ) IS NULL OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND function_row.proname = 'cleanup_leaderboard_rank_publication'
      AND function_row.oid IS DISTINCT FROM
        'public.cleanup_leaderboard_rank_publication(text,uuid,jsonb)'
          ::pg_catalog.regprocedure
  ) THEN
    RAISE EXCEPTION
      'leaderboard publication cleanup overload postflight failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid =
      'arena.reject_leaderboard_rank_publication_mutation()'
        ::pg_catalog.regprocedure
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prokind = 'f'
      AND function_row.prosecdef
      AND NOT function_row.proleakproof
      AND NOT function_row.proisstrict
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND function_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
      AND NOT function_row.proretset
      AND function_row.pronargs = 0
      AND function_row.pronargdefaults = 0
      AND language_row.lanname = 'plpgsql'
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
      AND pg_catalog.btrim(
        pg_catalog.regexp_replace(
          function_row.prosrc,
          '[[:space:]]+',
          ' ',
          'g'
        )
      ) =
        'BEGIN RAISE EXCEPTION ''leaderboard publication receipts are immutable'' USING ERRCODE = ''55000''; END;'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            function_row.proacl,
            pg_catalog.acldefault('f', function_row.proowner)
          )
        ) AS expanded
        WHERE expanded.grantee <> function_row.proowner
      )
  ) THEN
    RAISE EXCEPTION
      'leaderboard publication receipt immutability guard postflight failed';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.cleanup_leaderboard_rank_publication(text,uuid,jsonb)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon',
       'public.cleanup_leaderboard_rank_publication(text,uuid,jsonb)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'public.cleanup_leaderboard_rank_publication(text,uuid,jsonb)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'leaderboard publication cleanup ACL postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS expanded
    WHERE function_row.oid =
      'public.cleanup_leaderboard_rank_publication(text,uuid,jsonb)'
        ::pg_catalog.regprocedure
      AND expanded.privilege_type = 'EXECUTE'
      AND expanded.grantee <> function_row.proowner
      AND expanded.grantee <> 'service_role'::pg_catalog.regrole
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS expanded
    WHERE function_row.oid =
      'public.cleanup_leaderboard_rank_publication(text,uuid,jsonb)'
        ::pg_catalog.regprocedure
      AND expanded.grantee = 'service_role'::pg_catalog.regrole
      AND expanded.privilege_type = 'EXECUTE'
      AND expanded.is_grantable
  ) THEN
    RAISE EXCEPTION
      'leaderboard publication cleanup EXECUTE ACL is not a closed set';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
      'public.cleanup_leaderboard_rank_publication(text,uuid,jsonb)'
        ::pg_catalog.regprocedure
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=10s'
      ]::pg_catalog.text[]
      AND function_row.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
      AND NOT function_row.proretset
  ) THEN
    RAISE EXCEPTION
      'leaderboard publication cleanup owner/security contract drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
