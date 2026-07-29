-- Dormant owner-only typed contract for one canonical rank-generation batch.
--
-- Callers supply only 33 scorer/enrichment fields. Season, computed_at, and
-- rank_publication_id are injected from immutable generation authority by the
-- database-facing caller. This migration performs no rank DML, exposes no API
-- RPC, and grants no API role access. The later atomic writer will consume
-- these primitives together with generation claims and immutable receipts.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL quote_all_identifiers = 'off';

-- Freeze the positional parent composite before any target-table attestation.
LOCK TABLE ONLY public.leaderboard_ranks IN SHARE MODE;

DO $dependency_preflight$
DECLARE
  v_encoder oid := pg_catalog.to_regprocedure(
    'arena.encode_leaderboard_rank_row_v1(public.leaderboard_ranks)'
  );
  v_persisted_builder oid := pg_catalog.to_regprocedure(
    'arena.build_leaderboard_rank_batch_evidence_v1(text,uuid,jsonb)'
  );
  v_column_count integer;
  v_column_contract_sha256 text;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR pg_catalog.to_regnamespace('arena') IS NULL
     OR pg_catalog.to_regclass('public.leaderboard_ranks') IS NULL
     OR pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR v_encoder IS NULL
     OR v_persisted_builder IS NULL THEN
    RAISE EXCEPTION
      'typed rank batch contract requires PG17, the persisted codec, the rank table, and exact API roles';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS table_row
    WHERE table_row.oid = 'public.leaderboard_ranks'::pg_catalog.regclass
      AND table_row.relkind = 'p'
      AND table_row.relpersistence = 'p'
      AND table_row.relowner = 'postgres'::pg_catalog.regrole
      AND pg_catalog.pg_get_partkeydef(table_row.oid) = 'LIST (season_id)'
  ) THEN
    RAISE EXCEPTION 'typed rank batch target parent contract drifted';
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.string_agg(
            attribute.attname || '|' ||
            pg_catalog.format_type(
              attribute.atttypid,
              attribute.atttypmod
            ) || '|' || attribute.attnotnull::text || '|' ||
            attribute.attidentity::text || '|' ||
            attribute.attgenerated::text || '|' ||
            COALESCE(
              collation_namespace.nspname || '.' || collation_row.collname,
              '-'
            ),
            E'\n' ORDER BY attribute.attnum
          ),
          'UTF8'
        )
      ),
      'hex'
    )
  INTO STRICT v_column_count, v_column_contract_sha256
  FROM pg_catalog.pg_attribute AS attribute
  LEFT JOIN pg_catalog.pg_collation AS collation_row
    ON collation_row.oid = attribute.attcollation
  LEFT JOIN pg_catalog.pg_namespace AS collation_namespace
    ON collation_namespace.oid = collation_row.collnamespace
  WHERE attribute.attrelid =
        'public.leaderboard_ranks'::pg_catalog.regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF v_column_count <> 37
     OR v_column_contract_sha256 IS DISTINCT FROM
          '153127c5850e4f841b32bb3809b78bb815bed23643caf8394fb92997d6535514' THEN
    RAISE EXCEPTION
      'typed rank batch 37-column target drifted: columns %, digest %',
      v_column_count,
      v_column_contract_sha256;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'arena'
      AND function_row.proname IN (
        'encode_leaderboard_rank_row_v1',
        'build_leaderboard_rank_batch_evidence_v1'
      )
      AND function_row.oid NOT IN (v_encoder, v_persisted_builder)
  ) THEN
    RAISE EXCEPTION 'persisted rank codec dependency has a noncanonical overload';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_encoder
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prokind = 'f'
      AND language_row.lanname = 'plpgsql'
      AND NOT function_row.prosecdef
      AND NOT function_row.proleakproof
      AND function_row.proisstrict
      AND function_row.provolatile = 's'
      AND function_row.proparallel = 's'
      AND NOT function_row.proretset
      AND function_row.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
      AND function_row.pronargs = 1
      AND function_row.pronargdefaults = 0
      AND function_row.proargtypes = ARRAY[
        'public.leaderboard_ranks'::pg_catalog.regtype
      ]::pg_catalog.oidvector
      AND function_row.proargnames = ARRAY['p_rank']::pg_catalog.text[]
      AND function_row.proargmodes IS NULL
      AND function_row.proallargtypes IS NULL
      AND function_row.prosupport = 0
      AND function_row.prosqlbody IS NULL
      AND function_row.probin IS NULL
      AND function_row.procost = 100
      AND function_row.prorows = 0
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'TimeZone=UTC'
      ]::pg_catalog.text[]
      AND pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(function_row.prosrc, 'UTF8')
        ),
        'hex'
      ) = 'e667a6cadd6c0c21ecfa2bb920e6583f511a8e6f1c77e5e92f1a1bec36d6122e'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_persisted_builder
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prokind = 'f'
      AND language_row.lanname = 'plpgsql'
      AND NOT function_row.prosecdef
      AND NOT function_row.proleakproof
      AND NOT function_row.proisstrict
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND NOT function_row.proretset
      AND function_row.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
      AND function_row.pronargs = 3
      AND function_row.pronargdefaults = 0
      AND function_row.proargtypes = ARRAY[
        'pg_catalog.text'::pg_catalog.regtype,
        'pg_catalog.uuid'::pg_catalog.regtype,
        'pg_catalog.jsonb'::pg_catalog.regtype
      ]::pg_catalog.oidvector
      AND function_row.proargnames = ARRAY[
        'p_season_id',
        'p_score_cohort_id',
        'p_identities'
      ]::pg_catalog.text[]
      AND function_row.proargmodes IS NULL
      AND function_row.proallargtypes IS NULL
      AND function_row.prosupport = 0
      AND function_row.prosqlbody IS NULL
      AND function_row.probin IS NULL
      AND function_row.procost = 100
      AND function_row.prorows = 0
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'TimeZone=UTC',
        'lock_timeout=10s'
      ]::pg_catalog.text[]
      AND pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(function_row.prosrc, 'UTF8')
        ),
        'hex'
      ) = 'bdecbbc94ffbfd966122651552c09e3509f7bb1e87a36f5eb31a31315ea0770b'
  ) THEN
    RAISE EXCEPTION 'persisted rank codec dependency drifted';
  END IF;

  IF pg_catalog.has_function_privilege('anon', v_encoder, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
          'authenticated', v_encoder, 'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          'service_role', v_encoder, 'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          'anon', v_persisted_builder, 'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          'authenticated', v_persisted_builder, 'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          'service_role', v_persisted_builder, 'EXECUTE'
        )
     OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS expanded
    WHERE function_row.oid IN (v_encoder, v_persisted_builder)
      AND expanded.grantee <> function_row.proowner
      AND expanded.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'persisted rank codec dependency ACL drifted';
  END IF;
END
$dependency_preflight$;

DO $install_preflight$
DECLARE
  v_row_type oid := pg_catalog.to_regtype(
    'arena.leaderboard_rank_batch_row_v1'
  );
  v_evidence oid := pg_catalog.to_regprocedure(
    'arena.build_leaderboard_rank_typed_batch_evidence_v1(text,uuid,timestamptz,arena.leaderboard_rank_batch_row_v1[])'
  );
  v_write_set oid := pg_catalog.to_regprocedure(
    'arena.build_leaderboard_rank_generation_write_set_sha256_v1(text,uuid,text,timestamptz,integer,text[])'
  );
  v_present_count integer;
BEGIN
  v_present_count := (v_row_type IS NOT NULL)::integer
    + (v_evidence IS NOT NULL)::integer
    + (v_write_set IS NOT NULL)::integer;
  IF v_present_count NOT IN (0, 3) THEN
    RAISE EXCEPTION 'typed rank batch contract is only partially installed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'arena'
      AND function_row.proname IN (
        'build_leaderboard_rank_typed_batch_evidence_v1',
        'build_leaderboard_rank_generation_write_set_sha256_v1'
      )
      AND function_row.oid NOT IN (
        SELECT installed.oid
        FROM pg_catalog.unnest(
          ARRAY_REMOVE(ARRAY[v_evidence, v_write_set], NULL)::oid[]
        ) AS installed(oid)
      )
  ) THEN
    RAISE EXCEPTION 'typed rank batch contract has a noncanonical overload';
  END IF;
END
$install_preflight$;

DO $install$
BEGIN
  IF pg_catalog.to_regtype(
       'arena.leaderboard_rank_batch_row_v1'
     ) IS NULL THEN
    CREATE TYPE arena.leaderboard_rank_batch_row_v1 AS (
      source text,
      source_type text,
      source_trader_id text,
      rank integer,
      arena_score numeric(10, 2),
      roi numeric(12, 4),
      pnl numeric(18, 2),
      win_rate numeric(5, 2),
      max_drawdown numeric(5, 2),
      followers integer,
      trades_count integer,
      handle text,
      avatar_url text,
      profitability_score numeric(6, 2),
      risk_control_score numeric(6, 2),
      execution_score numeric(6, 2),
      score_completeness text,
      trading_style text,
      avg_holding_hours numeric(10, 2),
      style_confidence numeric(6, 4),
      sharpe_ratio numeric(10, 4),
      sortino_ratio numeric(10, 4),
      profit_factor numeric(10, 4),
      calmar_ratio numeric(10, 4),
      trader_type text,
      is_outlier boolean,
      metrics_estimated boolean,
      rank_change integer,
      is_new boolean,
      copiers integer,
      arena_score_v4 numeric,
      arena_score_v3 numeric,
      score_factors jsonb
    );

    CREATE FUNCTION arena.build_leaderboard_rank_typed_batch_evidence_v1(
      p_season_id text,
      p_score_cohort_id uuid,
      p_computed_at timestamptz,
      p_rows arena.leaderboard_rank_batch_row_v1[]
    )
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    CALLED ON NULL INPUT
    PARALLEL SAFE
    SECURITY INVOKER
    SET search_path = pg_catalog, pg_temp
    SET "TimeZone" = 'UTC'
    AS $body$
    DECLARE
      v_rows public.leaderboard_ranks[];
      v_row_count integer;
      v_default_distinct_count integer;
      v_byte_distinct_count integer;
      v_encoded_rows jsonb;
      v_source_proofs jsonb;
      v_source_count integer;
      v_batch_preimage jsonb;
      v_canonical_octet_length integer;
      v_first_source text;
      v_first_source_trader_id text;
      v_last_source text;
      v_last_source_trader_id text;
    BEGIN
      IF p_season_id IS NULL
         OR p_season_id NOT IN ('7D', '30D', '90D')
         OR p_score_cohort_id IS NULL
         OR p_computed_at IS NULL
         OR NOT pg_catalog.isfinite(p_computed_at)
         OR p_computed_at < '2020-01-01 00:00:00+00'::timestamptz
         OR p_computed_at >= '2100-01-01 00:00:00+00'::timestamptz
         OR p_rows IS NULL THEN
        RAISE EXCEPTION 'typed rank batch header is invalid'
          USING ERRCODE = '22023';
      END IF;

      v_row_count := pg_catalog.cardinality(p_rows);
      IF pg_catalog.array_ndims(p_rows) IS DISTINCT FROM 1
         OR pg_catalog.array_lower(p_rows, 1) IS DISTINCT FROM 1
         OR v_row_count < 1
         OR v_row_count > 1000 THEN
        RAISE EXCEPTION 'typed rank batch is outside resource bounds'
          USING ERRCODE = '54000';
      END IF;
      IF pg_catalog.pg_column_size(p_rows) > 67108864 THEN
        RAISE EXCEPTION 'typed rank batch is outside resource bounds'
          USING ERRCODE = '54000';
      END IF;
      IF pg_catalog.octet_length(p_rows::text) > 134217728 THEN
        RAISE EXCEPTION 'typed rank batch is outside resource bounds'
          USING ERRCODE = '54000';
      END IF;

      SELECT
        pg_catalog.count(DISTINCT ROW(
          input.source,
          input.source_trader_id
        ))::integer,
        pg_catalog.count(DISTINCT ROW(
          input.source COLLATE pg_catalog."C",
          input.source_trader_id COLLATE pg_catalog."C"
        ))::integer,
        pg_catalog.array_agg(
          ROW(
            NULL::bigint,
            p_season_id,
            input.source,
            input.source_type,
            input.source_trader_id,
            input.rank,
            input.arena_score,
            input.roi,
            input.pnl,
            input.win_rate,
            input.max_drawdown,
            input.followers,
            input.trades_count,
            input.handle,
            input.avatar_url,
            p_computed_at,
            input.profitability_score,
            input.risk_control_score,
            input.execution_score,
            input.score_completeness,
            input.trading_style,
            input.avg_holding_hours,
            input.style_confidence,
            input.sharpe_ratio,
            input.sortino_ratio,
            input.profit_factor,
            input.calmar_ratio,
            input.trader_type,
            input.is_outlier,
            input.metrics_estimated,
            input.rank_change,
            input.is_new,
            input.copiers,
            input.arena_score_v4,
            input.arena_score_v3,
            input.score_factors,
            p_score_cohort_id
          )::public.leaderboard_ranks
          ORDER BY input.source COLLATE pg_catalog."C",
                   input.source_trader_id COLLATE pg_catalog."C"
        )
      INTO STRICT
        v_default_distinct_count,
        v_byte_distinct_count,
        v_rows
      FROM pg_catalog.unnest(p_rows) AS input;

      IF v_default_distinct_count <> v_row_count
         OR v_byte_distinct_count <> v_row_count THEN
        RAISE EXCEPTION 'typed rank batch contains a duplicate identity'
          USING ERRCODE = '22023';
      END IF;

      SELECT pg_catalog.jsonb_agg(
        arena.encode_leaderboard_rank_row_v1(rank_row)
        ORDER BY rank_row.source COLLATE pg_catalog."C",
                 rank_row.source_trader_id COLLATE pg_catalog."C"
      )
      INTO STRICT v_encoded_rows
      FROM pg_catalog.unnest(v_rows) AS rank_row;

      v_first_source := (v_encoded_rows->0)->>2;
      v_first_source_trader_id := (v_encoded_rows->0)->>3;
      v_last_source := (v_encoded_rows->(v_row_count - 1))->>2;
      v_last_source_trader_id :=
        (v_encoded_rows->(v_row_count - 1))->>3;

      WITH encoded_identity AS MATERIALIZED (
        SELECT
          ((encoded.value->>2) COLLATE pg_catalog."C") AS source,
          ((encoded.value->>3) COLLATE pg_catalog."C") AS source_trader_id
        FROM pg_catalog.jsonb_array_elements(v_encoded_rows) AS encoded(value)
      ),
      source_group AS (
        SELECT
          encoded_identity.source,
          pg_catalog.count(*)::integer AS source_row_count,
          pg_catalog.jsonb_agg(
            encoded_identity.source_trader_id
            ORDER BY encoded_identity.source_trader_id
          ) AS source_ids
        FROM encoded_identity
        GROUP BY encoded_identity.source
      ),
      source_proof AS (
        SELECT
          source_group.source,
          pg_catalog.jsonb_build_object(
            'source', source_group.source,
            'source_row_count', source_group.source_row_count,
            'source_identity_sha256', pg_catalog.encode(
              pg_catalog.sha256(
                pg_catalog.convert_to(
                  pg_catalog.jsonb_build_array(
                    'leaderboard-rank-source-identities@1',
                    p_season_id,
                    source_group.source,
                    source_group.source_ids
                  )::text,
                  'UTF8'
                )
              ),
              'hex'
            )
          ) AS proof
        FROM source_group
      )
      SELECT
        pg_catalog.jsonb_agg(
          source_proof.proof ORDER BY source_proof.source
        ),
        pg_catalog.count(*)::integer
      INTO STRICT v_source_proofs, v_source_count
      FROM source_proof;

      v_batch_preimage := pg_catalog.jsonb_build_array(
        'leaderboard-rank-persisted-batch@1',
        v_encoded_rows
      );
      v_canonical_octet_length := pg_catalog.octet_length(
        pg_catalog.convert_to(v_batch_preimage::text, 'UTF8')
      );
      IF v_canonical_octet_length > 67108864 THEN
        RAISE EXCEPTION
          'typed rank batch canonical encoding exceeds 67108864 bytes'
          USING ERRCODE = '54000';
      END IF;

      RETURN pg_catalog.jsonb_build_object(
        'contract', 'leaderboard-rank-persisted-batch-evidence@1',
        'season_id', p_season_id,
        'score_cohort_id', p_score_cohort_id::text,
        'row_count', v_row_count,
        'source_count', v_source_count,
        'first_source', v_first_source,
        'first_source_trader_id', v_first_source_trader_id,
        'last_source', v_last_source,
        'last_source_trader_id', v_last_source_trader_id,
        'batch_sha256', pg_catalog.encode(
          pg_catalog.sha256(
            pg_catalog.convert_to(v_batch_preimage::text, 'UTF8')
          ),
          'hex'
        ),
        'canonical_octet_length', v_canonical_octet_length,
        'source_proofs', v_source_proofs
      );
    END;
    $body$;

    CREATE FUNCTION
      arena.build_leaderboard_rank_generation_write_set_sha256_v1(
        p_season_id text,
        p_score_cohort_id uuid,
        p_score_input_manifest_digest text,
        p_computed_at timestamptz,
        p_expected_rank_count integer,
        p_batch_sha256_plan text[]
      )
    RETURNS text
    LANGUAGE plpgsql
    STABLE
    CALLED ON NULL INPUT
    PARALLEL SAFE
    SECURITY INVOKER
    SET search_path = pg_catalog, pg_temp
    SET "TimeZone" = 'UTC'
    AS $body$
    DECLARE
      v_batch_count integer;
      v_distinct_batch_count integer;
      v_has_invalid_digest boolean;
      v_preimage jsonb;
    BEGIN
      IF p_season_id IS NULL
         OR p_season_id NOT IN ('7D', '30D', '90D')
         OR p_score_cohort_id IS NULL
         OR p_score_input_manifest_digest IS NULL
         OR p_computed_at IS NULL
         OR NOT pg_catalog.isfinite(p_computed_at)
         OR p_computed_at < '2020-01-01 00:00:00+00'::timestamptz
         OR p_computed_at >= '2100-01-01 00:00:00+00'::timestamptz
         OR p_expected_rank_count IS NULL
         OR p_batch_sha256_plan IS NULL THEN
        RAISE EXCEPTION 'rank generation write-set header is invalid'
          USING ERRCODE = '22023';
      END IF;
      IF pg_catalog.octet_length(p_score_input_manifest_digest) <> 64 THEN
        RAISE EXCEPTION 'rank generation write-set header is invalid'
          USING ERRCODE = '22023';
      END IF;
      IF p_score_input_manifest_digest !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'rank generation write-set header is invalid'
          USING ERRCODE = '22023';
      END IF;

      v_batch_count := pg_catalog.cardinality(p_batch_sha256_plan);
      IF v_batch_count > 0 AND (
           pg_catalog.array_ndims(p_batch_sha256_plan) IS DISTINCT FROM 1
           OR pg_catalog.array_lower(p_batch_sha256_plan, 1)
                IS DISTINCT FROM 1
         ) THEN
        RAISE EXCEPTION 'rank generation batch digest plan must be one-based'
          USING ERRCODE = '22023';
      END IF;
      IF v_batch_count > 4096
         OR pg_catalog.pg_column_size(p_batch_sha256_plan) > 1048576 THEN
        RAISE EXCEPTION 'rank generation batch digest plan is outside resource bounds'
          USING ERRCODE = '54000';
      END IF;

      SELECT
        pg_catalog.count(
          DISTINCT digest.value COLLATE pg_catalog."C"
        )::integer,
        pg_catalog.bool_or(
          CASE
            WHEN digest.value IS NULL
              OR pg_catalog.octet_length(digest.value) <> 64 THEN true
            ELSE digest.value !~ '^[0-9a-f]{64}$'
          END
        )
      INTO STRICT v_distinct_batch_count, v_has_invalid_digest
      FROM pg_catalog.unnest(p_batch_sha256_plan) AS digest(value);

      IF v_distinct_batch_count <> v_batch_count
         OR v_has_invalid_digest IS TRUE
         OR p_expected_rank_count < 0
         OR p_expected_rank_count > 64000
         OR NOT (
           (p_expected_rank_count = 0 AND v_batch_count = 0)
           OR (
             p_expected_rank_count > 0
             AND v_batch_count > 0
             AND v_batch_count <= p_expected_rank_count
             AND p_expected_rank_count::bigint <=
                   v_batch_count::bigint * 1000
           )
         ) THEN
        RAISE EXCEPTION 'rank generation batch digest plan is invalid'
          USING ERRCODE = '22023';
      END IF;

      v_preimage := pg_catalog.jsonb_build_array(
        'leaderboard-rank-generation-write-set@1',
        p_season_id,
        p_score_cohort_id::text,
        p_score_input_manifest_digest,
        pg_catalog.to_char(
          p_computed_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ),
        p_expected_rank_count,
        v_batch_count,
        pg_catalog.to_jsonb(p_batch_sha256_plan)
      );

      RETURN pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(v_preimage::text, 'UTF8')
        ),
        'hex'
      );
    END;
    $body$;

    ALTER TYPE arena.leaderboard_rank_batch_row_v1 OWNER TO postgres;
    ALTER FUNCTION arena.build_leaderboard_rank_typed_batch_evidence_v1(
      text,
      uuid,
      timestamptz,
      arena.leaderboard_rank_batch_row_v1[]
    ) OWNER TO postgres;
    ALTER FUNCTION
      arena.build_leaderboard_rank_generation_write_set_sha256_v1(
        text,
        uuid,
        text,
        timestamptz,
        integer,
        text[]
      ) OWNER TO postgres;

    REVOKE ALL ON TYPE arena.leaderboard_rank_batch_row_v1
      FROM PUBLIC, anon, authenticated, service_role;
    REVOKE ALL ON FUNCTION
      arena.build_leaderboard_rank_typed_batch_evidence_v1(
        text,
        uuid,
        timestamptz,
        arena.leaderboard_rank_batch_row_v1[]
      ) FROM PUBLIC, anon, authenticated, service_role;
    REVOKE ALL ON FUNCTION
      arena.build_leaderboard_rank_generation_write_set_sha256_v1(
        text,
        uuid,
        text,
        timestamptz,
        integer,
        text[]
      ) FROM PUBLIC, anon, authenticated, service_role;
  END IF;
END
$install$;

COMMENT ON TYPE arena.leaderboard_rank_batch_row_v1 IS
  'Private 33-field typed input. Season, generation computed_at, publication cohort, and surrogate id are database authority and intentionally absent.';
COMMENT ON FUNCTION arena.build_leaderboard_rank_typed_batch_evidence_v1(
  text,
  uuid,
  timestamptz,
  arena.leaderboard_rank_batch_row_v1[]
) IS
  'Builds persisted-codec-identical evidence from typed rows after injecting database-authoritative season, timestamp, and cohort. No DML.';
COMMENT ON FUNCTION
  arena.build_leaderboard_rank_generation_write_set_sha256_v1(
    text,
    uuid,
    text,
    timestamptz,
    integer,
    text[]
  ) IS
  'Content-addresses one complete ordered generation batch plan. Generation sequence is excluded because it is allocated only after claim.';

DO $postflight$
DECLARE
  v_row_type oid := pg_catalog.to_regtype(
    'arena.leaderboard_rank_batch_row_v1'
  );
  v_evidence oid := pg_catalog.to_regprocedure(
    'arena.build_leaderboard_rank_typed_batch_evidence_v1(text,uuid,timestamptz,arena.leaderboard_rank_batch_row_v1[])'
  );
  v_write_set oid := pg_catalog.to_regprocedure(
    'arena.build_leaderboard_rank_generation_write_set_sha256_v1(text,uuid,text,timestamptz,integer,text[])'
  );
  v_type_relation oid;
BEGIN
  IF v_row_type IS NULL OR v_evidence IS NULL OR v_write_set IS NULL THEN
    RAISE EXCEPTION 'typed rank batch contract object identity failed';
  END IF;

  SELECT type_row.typrelid
  INTO STRICT v_type_relation
  FROM pg_catalog.pg_type AS type_row
  WHERE type_row.oid = v_row_type
    AND type_row.typtype = 'c'
    AND type_row.typowner = 'postgres'::pg_catalog.regrole
    AND type_row.typnamespace = 'arena'::pg_catalog.regnamespace;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation_row
    WHERE relation_row.oid = v_type_relation
      AND relation_row.relkind = 'c'
      AND relation_row.relowner = 'postgres'::pg_catalog.regrole
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_type_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 33 OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        (1, 'source', 'text'),
        (2, 'source_type', 'text'),
        (3, 'source_trader_id', 'text'),
        (4, 'rank', 'integer'),
        (5, 'arena_score', 'numeric(10,2)'),
        (6, 'roi', 'numeric(12,4)'),
        (7, 'pnl', 'numeric(18,2)'),
        (8, 'win_rate', 'numeric(5,2)'),
        (9, 'max_drawdown', 'numeric(5,2)'),
        (10, 'followers', 'integer'),
        (11, 'trades_count', 'integer'),
        (12, 'handle', 'text'),
        (13, 'avatar_url', 'text'),
        (14, 'profitability_score', 'numeric(6,2)'),
        (15, 'risk_control_score', 'numeric(6,2)'),
        (16, 'execution_score', 'numeric(6,2)'),
        (17, 'score_completeness', 'text'),
        (18, 'trading_style', 'text'),
        (19, 'avg_holding_hours', 'numeric(10,2)'),
        (20, 'style_confidence', 'numeric(6,4)'),
        (21, 'sharpe_ratio', 'numeric(10,4)'),
        (22, 'sortino_ratio', 'numeric(10,4)'),
        (23, 'profit_factor', 'numeric(10,4)'),
        (24, 'calmar_ratio', 'numeric(10,4)'),
        (25, 'trader_type', 'text'),
        (26, 'is_outlier', 'boolean'),
        (27, 'metrics_estimated', 'boolean'),
        (28, 'rank_change', 'integer'),
        (29, 'is_new', 'boolean'),
        (30, 'copiers', 'integer'),
        (31, 'arena_score_v4', 'numeric'),
        (32, 'arena_score_v3', 'numeric'),
        (33, 'score_factors', 'jsonb')
    ) AS expected(attnum, attname, formatted_type)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = v_type_relation
     AND attribute.attnum = expected.attnum
     AND NOT attribute.attisdropped
    WHERE attribute.attname IS DISTINCT FROM expected.attname
       OR pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
            IS DISTINCT FROM expected.formatted_type
       OR attribute.attnotnull
       OR attribute.attidentity <> ''
       OR attribute.attgenerated <> ''
       OR (
         expected.formatted_type IN ('text')
         AND attribute.attcollation IS DISTINCT FROM
               'pg_catalog.default'::pg_catalog.regcollation
       )
  ) THEN
    RAISE EXCEPTION 'typed rank batch 33-field composite contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'arena'
      AND function_row.proname IN (
        'build_leaderboard_rank_typed_batch_evidence_v1',
        'build_leaderboard_rank_generation_write_set_sha256_v1'
      )
      AND function_row.oid NOT IN (v_evidence, v_write_set)
  ) THEN
    RAISE EXCEPTION 'typed rank batch function overload postflight failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_evidence
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prokind = 'f'
      AND language_row.lanname = 'plpgsql'
      AND NOT function_row.prosecdef
      AND NOT function_row.proleakproof
      AND NOT function_row.proisstrict
      AND function_row.provolatile = 's'
      AND function_row.proparallel = 's'
      AND NOT function_row.proretset
      AND function_row.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
      AND function_row.pronargs = 4
      AND function_row.pronargdefaults = 0
      AND function_row.proargtypes = ARRAY[
        'pg_catalog.text'::pg_catalog.regtype,
        'pg_catalog.uuid'::pg_catalog.regtype,
        'pg_catalog.timestamptz'::pg_catalog.regtype,
        'arena.leaderboard_rank_batch_row_v1[]'::pg_catalog.regtype
      ]::pg_catalog.oidvector
      AND function_row.proargnames = ARRAY[
        'p_season_id',
        'p_score_cohort_id',
        'p_computed_at',
        'p_rows'
      ]::pg_catalog.text[]
      AND function_row.proargmodes IS NULL
      AND function_row.proallargtypes IS NULL
      AND function_row.prosupport = 0
      AND function_row.prosqlbody IS NULL
      AND function_row.probin IS NULL
      AND function_row.procost = 100
      AND function_row.prorows = 0
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'TimeZone=UTC'
      ]::pg_catalog.text[]
      AND pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(function_row.prosrc, 'UTF8')
        ),
        'hex'
      ) = '7fa1e9f60a7b6cb4072dce842ddd10c367046fcb431a2ae655a9a806172df67e'
  ) THEN
    RAISE EXCEPTION 'typed rank batch evidence function drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_write_set
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prokind = 'f'
      AND language_row.lanname = 'plpgsql'
      AND NOT function_row.prosecdef
      AND NOT function_row.proleakproof
      AND NOT function_row.proisstrict
      AND function_row.provolatile = 's'
      AND function_row.proparallel = 's'
      AND NOT function_row.proretset
      AND function_row.prorettype = 'pg_catalog.text'::pg_catalog.regtype
      AND function_row.pronargs = 6
      AND function_row.pronargdefaults = 0
      AND function_row.proargtypes = ARRAY[
        'pg_catalog.text'::pg_catalog.regtype,
        'pg_catalog.uuid'::pg_catalog.regtype,
        'pg_catalog.text'::pg_catalog.regtype,
        'pg_catalog.timestamptz'::pg_catalog.regtype,
        'pg_catalog.int4'::pg_catalog.regtype,
        'pg_catalog.text[]'::pg_catalog.regtype
      ]::pg_catalog.oidvector
      AND function_row.proargnames = ARRAY[
        'p_season_id',
        'p_score_cohort_id',
        'p_score_input_manifest_digest',
        'p_computed_at',
        'p_expected_rank_count',
        'p_batch_sha256_plan'
      ]::pg_catalog.text[]
      AND function_row.proargmodes IS NULL
      AND function_row.proallargtypes IS NULL
      AND function_row.prosupport = 0
      AND function_row.prosqlbody IS NULL
      AND function_row.probin IS NULL
      AND function_row.procost = 100
      AND function_row.prorows = 0
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'TimeZone=UTC'
      ]::pg_catalog.text[]
      AND pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(function_row.prosrc, 'UTF8')
        ),
        'hex'
      ) = 'f82b8b26dee4b1b5a92d4750ad42ed65d91bd7972bac0ef0f14f0b94e24f197d'
  ) THEN
    RAISE EXCEPTION 'rank generation write-set function drifted';
  END IF;

  IF pg_catalog.has_type_privilege('anon', v_row_type, 'USAGE')
     OR pg_catalog.has_type_privilege(
          'authenticated', v_row_type, 'USAGE'
        )
     OR pg_catalog.has_type_privilege('service_role', v_row_type, 'USAGE')
     OR pg_catalog.has_function_privilege('anon', v_evidence, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
          'authenticated', v_evidence, 'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          'service_role', v_evidence, 'EXECUTE'
        )
     OR pg_catalog.has_function_privilege('anon', v_write_set, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
          'authenticated', v_write_set, 'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          'service_role', v_write_set, 'EXECUTE'
        )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_type AS type_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           type_row.typacl,
           pg_catalog.acldefault('T', type_row.typowner)
         )
       ) AS expanded
       WHERE type_row.oid = v_row_type
         AND expanded.grantee <> type_row.typowner
         AND expanded.privilege_type = 'USAGE'
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS expanded
       WHERE function_row.oid IN (v_evidence, v_write_set)
         AND expanded.grantee <> function_row.proowner
         AND expanded.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'typed rank batch type or function ACL drifted';
  END IF;
END
$postflight$;

COMMIT;
