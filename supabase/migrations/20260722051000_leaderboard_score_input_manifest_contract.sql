-- Migration: 20260722051000_leaderboard_score_input_manifest_contract.sql
-- Description: Install an inert, owner-only content-addressed manifest store
-- for canonical leaderboard scoring inputs and PG17 Arena Score v4 outputs.
-- This migration deliberately exposes no public RPC, grants no API role, and
-- changes no leaderboard row. A later deterministic database builder is the
-- only component allowed to call the private seal function.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL quote_all_identifiers = 'off';

DO $preflight$
DECLARE
  v_scorer_oid oid := pg_catalog.to_regprocedure(
    'arena.compute_arena_scores_v4_json(text,jsonb)'
  );
  v_round_oid oid := pg_catalog.to_regprocedure(
    'arena.arena_score_v4_round2(double precision)'
  );
  v_definition_digest text;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION 'leaderboard score-input manifests require PostgreSQL 17';
  END IF;
  IF pg_catalog.to_regnamespace('arena') IS NULL THEN
    RAISE EXCEPTION 'arena schema must exist before installing score-input manifests';
  END IF;
  IF pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'PostgREST API roles must exist before installing score-input manifests';
  END IF;
  IF v_scorer_oid IS NULL OR v_round_oid IS NULL THEN
    RAISE EXCEPTION 'private PG17 Arena Score v4 scorer must exist before score-input manifests';
  END IF;
  IF pg_catalog.to_regprocedure('extensions.digest(bytea,text)') IS NULL
     OR pg_catalog.to_regprocedure('extensions.gen_random_uuid()') IS NULL THEN
    RAISE EXCEPTION 'extensions digest and gen_random_uuid must exist';
  END IF;
  IF pg_catalog.to_regclass('arena.leaderboard_score_input_manifests') IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.seal_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.verify_leaderboard_score_input_manifest_v1(uuid)'
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'leaderboard score-input manifest contract already exists; audit before install';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid IN (v_scorer_oid, v_round_oid)
      AND (
        function_row.provolatile <> 'i'
        OR function_row.prosecdef
        OR function_row.proparallel <> 's'
        OR function_row.proconfig IS NULL
        OR NOT ('search_path=pg_catalog, pg_temp' = ANY(function_row.proconfig))
      )
  ) THEN
    RAISE EXCEPTION 'private PG17 scorer catalog contract drifted';
  END IF;
  v_definition_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'contract', 'arena-score-v4-pg17-definition@1',
          'postgresMajor', 17,
          'round2Definition', pg_catalog.pg_get_functiondef(v_round_oid),
          'scorerDefinition', pg_catalog.pg_get_functiondef(v_scorer_oid)
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  IF v_definition_digest IS DISTINCT FROM
       '845039eaafed171ea040409281e0a49aa127c69d48005d07b6228bd0b1bf56d9' THEN
    RAISE EXCEPTION 'private PG17 scorer definition digest drifted: %',
      v_definition_digest;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS privilege_row
    WHERE function_row.oid IN (v_scorer_oid, v_round_oid)
      AND privilege_row.privilege_type = 'EXECUTE'
      AND privilege_row.grantee <> function_row.proowner
  ) OR pg_catalog.has_function_privilege(
    'anon', 'arena.compute_arena_scores_v4_json(text,jsonb)', 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', 'arena.compute_arena_scores_v4_json(text,jsonb)', 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'service_role', 'arena.compute_arena_scores_v4_json(text,jsonb)', 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'private PG17 scorer is not owner-only';
  END IF;
END
$preflight$;

CREATE TABLE arena.leaderboard_score_input_manifests (
  manifest_id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  manifest_digest text NOT NULL UNIQUE,
  period text NOT NULL,
  manifest jsonb NOT NULL,
  valid_until timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT leaderboard_score_input_manifest_digest_shape
    CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT leaderboard_score_input_manifest_period
    CHECK (period IN ('7D', '30D', '90D')),
  CONSTRAINT leaderboard_score_input_manifest_object
    CHECK (pg_catalog.jsonb_typeof(manifest) = 'object'),
  CONSTRAINT leaderboard_score_input_manifest_scalar_binding
    CHECK (
      (
        manifest->>'contract' = 'leaderboard-score-input-manifest@1'
        AND manifest->>'manifestDigest' = manifest_digest
        AND manifest->>'period' = period
        AND (manifest->>'validUntil')::timestamp with time zone = valid_until
      ) IS TRUE
    ),
  CONSTRAINT leaderboard_score_input_manifest_rank_eligible_pnl
    CHECK (
      pg_catalog.jsonb_typeof(manifest->'inputs') = 'array'
      AND pg_catalog.jsonb_array_length(manifest->'inputs') =
          pg_catalog.jsonb_array_length(
            pg_catalog.jsonb_path_query_array(
              manifest->'inputs',
              '$[*] ? (@.pnl.type() == "number")'::pg_catalog.jsonpath
            )
          )
    )
);

ALTER TABLE arena.leaderboard_score_input_manifests ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION arena.encode_leaderboard_score_input_manifest_v1(
  p_period text,
  p_source_bundle_digest text,
  p_score_rows_sha256 text,
  p_physical_boards_sha256 text,
  p_source_evidence jsonb,
  p_enrichment_contract text,
  p_enrichment_evidence jsonb,
  p_eligibility_contract text,
  p_eligibility_evidence jsonb,
  p_inputs jsonb,
  p_valid_until timestamp with time zone
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
SET extra_float_digits = '3'
SET quote_all_identifiers = 'off'
AS $encoder$
DECLARE
  v_scorer_oid oid := pg_catalog.to_regprocedure(
    'arena.compute_arena_scores_v4_json(text,jsonb)'
  );
  v_round_oid oid := pg_catalog.to_regprocedure(
    'arena.arena_score_v4_round2(double precision)'
  );
  v_scorer_result jsonb;
  v_canonical_inputs jsonb;
  v_recomputed_input_digest text;
  v_definition_basis jsonb;
  v_definition_digest text;
  v_source_basis jsonb;
  v_source_evidence_digest text;
  v_enrichment_basis jsonb;
  v_enrichment_evidence_digest text;
  v_eligibility_basis jsonb;
  v_eligibility_evidence_digest text;
BEGIN
  IF v_scorer_oid IS NULL OR v_round_oid IS NULL THEN
    RAISE EXCEPTION 'private PG17 Arena Score v4 scorer is unavailable'
      USING ERRCODE = '55000';
  END IF;
  IF p_source_bundle_digest IS NULL
     OR p_source_bundle_digest !~ '^[0-9a-f]{64}$'
     OR p_score_rows_sha256 IS NULL
     OR p_score_rows_sha256 !~ '^[0-9a-f]{64}$'
     OR p_physical_boards_sha256 IS NULL
     OR p_physical_boards_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'source bundle, score-row, and physical-board digests must be lowercase sha256'
      USING ERRCODE = '22023';
  END IF;
  IF p_enrichment_contract IS NULL
     OR p_enrichment_contract IS DISTINCT FROM pg_catalog.btrim(p_enrichment_contract)
     OR p_enrichment_contract !~ '^[a-z0-9][a-z0-9._:@/-]{0,127}$'
     OR p_eligibility_contract IS NULL
     OR p_eligibility_contract IS DISTINCT FROM pg_catalog.btrim(p_eligibility_contract)
     OR p_eligibility_contract !~ '^[a-z0-9][a-z0-9._:@/-]{0,127}$' THEN
    RAISE EXCEPTION 'evidence contract identifiers are invalid'
      USING ERRCODE = '22023';
  END IF;
  IF p_source_evidence IS NULL
     OR pg_catalog.jsonb_typeof(p_source_evidence) <> 'object'
     OR p_enrichment_evidence IS NULL
     OR pg_catalog.jsonb_typeof(p_enrichment_evidence) <> 'object'
     OR p_eligibility_evidence IS NULL
     OR pg_catalog.jsonb_typeof(p_eligibility_evidence) <> 'object' THEN
    RAISE EXCEPTION 'source, enrichment, and eligibility evidence must be JSON objects'
      USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.octet_length(p_source_evidence::text) > 16777216
     OR pg_catalog.octet_length(p_enrichment_evidence::text) > 33554432
     OR pg_catalog.octet_length(p_eligibility_evidence::text) > 16777216
     OR pg_catalog.octet_length(p_source_evidence::text)
        + pg_catalog.octet_length(p_enrichment_evidence::text)
        + pg_catalog.octet_length(p_eligibility_evidence::text) > 67108864 THEN
    RAISE EXCEPTION 'score-input manifest evidence exceeds resource bounds'
      USING ERRCODE = '54000';
  END IF;
  IF p_valid_until IS NULL OR NOT pg_catalog.isfinite(p_valid_until) THEN
    RAISE EXCEPTION 'score-input manifest valid_until must be finite'
      USING ERRCODE = '22023';
  END IF;

  -- The scorer is the validation authority for the exact nine-field input
  -- shape, identity uniqueness, finite numeric domain, and 64k/64MiB bounds.
  v_scorer_result := arena.compute_arena_scores_v4_json(p_period, p_inputs);
  IF v_scorer_result->>'contract' IS DISTINCT FROM 'arena-score-v4-pg17@1'
     OR v_scorer_result->>'digestAlgorithm'
        IS DISTINCT FROM 'pg17-jsonb-utf8-sha256@1'
     OR v_scorer_result->>'inputDigest' !~ '^[0-9a-f]{64}$'
     OR v_scorer_result->>'outputDigest' !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'private PG17 scorer returned an invalid envelope'
      USING ERRCODE = '55000';
  END IF;

  -- Ranking requires an observed finite PnL. The private scorer intentionally
  -- accepts null for lower-level experiments, so the leaderboard manifest must
  -- narrow that domain explicitly. JSON number zero and losses remain valid;
  -- missing, null, string, object, array, and boolean PnL fail closed.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_inputs) AS input_row(value)
    WHERE pg_catalog.jsonb_typeof(input_row.value->'pnl')
          IS DISTINCT FROM 'number'
  ) THEN
    RAISE EXCEPTION 'leaderboard score-input PnL must be a finite JSON number'
      USING ERRCODE = '22023';
  END IF;

  -- Rebuild canonical inputs from the same parsed float8/integer domain as the
  -- scorer. This removes caller array order and numeric-spelling differences.
  WITH decoded AS MATERIALIZED (
    SELECT
      input_row.value->>'source' AS source,
      input_row.value->>'source_trader_id' AS source_trader_id,
      (input_row.value->>'roi')::double precision AS roi,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'pnl') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'pnl')::double precision
      END AS pnl,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'max_drawdown') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'max_drawdown')::double precision
      END AS max_drawdown,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'win_rate') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'win_rate')::double precision
      END AS win_rate,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'sharpe_ratio') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'sharpe_ratio')::double precision
      END AS sharpe_ratio,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'profit_factor') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'profit_factor')::double precision
      END AS profit_factor,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'trades_count') = 'null'
        THEN NULL::bigint
        ELSE (input_row.value->>'trades_count')::numeric::bigint
      END AS trades_count
    FROM pg_catalog.jsonb_array_elements(p_inputs) AS input_row(value)
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'source', decoded.source,
        'source_trader_id', decoded.source_trader_id,
        'roi', decoded.roi,
        'pnl', decoded.pnl,
        'max_drawdown', decoded.max_drawdown,
        'win_rate', decoded.win_rate,
        'sharpe_ratio', decoded.sharpe_ratio,
        'profit_factor', decoded.profit_factor,
        'trades_count', decoded.trades_count
      )
      ORDER BY
        decoded.source COLLATE "C",
        decoded.source_trader_id COLLATE "C"
    ),
    '[]'::jsonb
  )
  INTO STRICT v_canonical_inputs
  FROM decoded;

  IF (v_scorer_result->>'inputCount')::integer
       IS DISTINCT FROM pg_catalog.jsonb_array_length(v_canonical_inputs) THEN
    RAISE EXCEPTION 'canonical input count disagrees with private PG17 scorer'
      USING ERRCODE = '55000';
  END IF;
  v_recomputed_input_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'contract', 'arena-score-v4-pg17-input@1',
          'period', p_period,
          'inputs', v_canonical_inputs
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  IF v_scorer_result->>'inputDigest'
       IS DISTINCT FROM v_recomputed_input_digest THEN
    RAISE EXCEPTION 'canonical inputs disagree with private PG17 input digest'
      USING ERRCODE = '55000';
  END IF;

  v_definition_basis := pg_catalog.jsonb_build_object(
    'contract', 'arena-score-v4-pg17-definition@1',
    'postgresMajor', 17,
    'round2Definition', pg_catalog.pg_get_functiondef(v_round_oid),
    'scorerDefinition', pg_catalog.pg_get_functiondef(v_scorer_oid)
  );
  v_definition_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_definition_basis::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  IF v_definition_digest IS DISTINCT FROM
       '845039eaafed171ea040409281e0a49aa127c69d48005d07b6228bd0b1bf56d9' THEN
    RAISE EXCEPTION 'private PG17 scorer definition digest drifted'
      USING ERRCODE = '55000';
  END IF;

  v_source_basis := pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-score-source-evidence@1',
    'sourceBundleDigest', p_source_bundle_digest,
    'scoreRowsDigest', p_score_rows_sha256,
    'physicalBoardsDigest', p_physical_boards_sha256,
    'evidence', p_source_evidence
  );
  v_source_evidence_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_source_basis::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  v_enrichment_basis := pg_catalog.jsonb_build_object(
    'contract', p_enrichment_contract,
    'evidence', p_enrichment_evidence
  );
  v_enrichment_evidence_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_enrichment_basis::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  v_eligibility_basis := pg_catalog.jsonb_build_object(
    'contract', p_eligibility_contract,
    'evidence', p_eligibility_evidence
  );
  v_eligibility_evidence_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_eligibility_basis::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  -- The returned value is the complete digest basis. UUID and insertion time
  -- are intentionally absent so identical evidence content is idempotent.
  RETURN pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-score-input-manifest@1',
    'digestAlgorithm', 'pg17-jsonb-utf8-sha256@1',
    'period', p_period,
    'scorer', pg_catalog.jsonb_build_object(
      'contract', v_scorer_result->>'contract',
      'definitionContract', 'arena-score-v4-pg17-definition@1',
      'definitionDigest', v_definition_digest,
      'inputDigest', v_scorer_result->>'inputDigest',
      'outputDigest', v_scorer_result->>'outputDigest'
    ),
    'source', v_source_basis || pg_catalog.jsonb_build_object(
      'evidenceDigest', v_source_evidence_digest
    ),
    'enrichment', v_enrichment_basis || pg_catalog.jsonb_build_object(
      'evidenceDigest', v_enrichment_evidence_digest
    ),
    'eligibility', v_eligibility_basis || pg_catalog.jsonb_build_object(
      'evidenceDigest', v_eligibility_evidence_digest
    ),
    'inputCount', pg_catalog.jsonb_array_length(v_canonical_inputs),
    'inputs', v_canonical_inputs,
    'outputs', v_scorer_result->'outputs',
    'validUntil', pg_catalog.to_jsonb(
      pg_catalog.to_char(
        p_valid_until AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    )
  );
END;
$encoder$;

CREATE FUNCTION arena.seal_leaderboard_score_input_manifest_v1(
  p_period text,
  p_source_bundle_digest text,
  p_score_rows_sha256 text,
  p_physical_boards_sha256 text,
  p_source_evidence jsonb,
  p_enrichment_contract text,
  p_enrichment_evidence jsonb,
  p_eligibility_contract text,
  p_eligibility_evidence jsonb,
  p_inputs jsonb,
  p_valid_until timestamp with time zone
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $seal$
DECLARE
  v_manifest_basis jsonb;
  v_manifest_digest text;
  v_manifest jsonb;
  v_row arena.leaderboard_score_input_manifests%ROWTYPE;
BEGIN
  IF p_valid_until IS NULL
     OR NOT pg_catalog.isfinite(p_valid_until)
     OR p_valid_until <= pg_catalog.clock_timestamp() + interval '1 second'
     OR p_valid_until > pg_catalog.clock_timestamp() + interval '24 hours' THEN
    RAISE EXCEPTION 'score-input manifest validity must remain open for at least 1 second and end within 24 hours'
      USING ERRCODE = '22023';
  END IF;

  v_manifest_basis := arena.encode_leaderboard_score_input_manifest_v1(
    p_period,
    p_source_bundle_digest,
    p_score_rows_sha256,
    p_physical_boards_sha256,
    p_source_evidence,
    p_enrichment_contract,
    p_enrichment_evidence,
    p_eligibility_contract,
    p_eligibility_evidence,
    p_inputs,
    p_valid_until
  );
  v_manifest_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_manifest_basis::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  v_manifest := v_manifest_basis || pg_catalog.jsonb_build_object(
    'manifestDigest', v_manifest_digest
  );

  IF p_valid_until <= pg_catalog.clock_timestamp() + interval '1 second' THEN
    RAISE EXCEPTION 'score-input manifest validity fell below 1 second while its content was encoded'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO arena.leaderboard_score_input_manifests AS stored (
    manifest_digest,
    period,
    manifest,
    valid_until
  ) VALUES (
    v_manifest_digest,
    p_period,
    v_manifest,
    p_valid_until
  )
  ON CONFLICT (manifest_digest) DO UPDATE
    SET manifest_digest = stored.manifest_digest
  RETURNING * INTO STRICT v_row;

  IF p_valid_until <= pg_catalog.clock_timestamp() + interval '1 second' THEN
    RAISE EXCEPTION 'score-input manifest validity fell below 1 second while it was being sealed'
      USING ERRCODE = '22023';
  END IF;

  IF v_row.period IS DISTINCT FROM p_period
     OR v_row.valid_until IS DISTINCT FROM p_valid_until
     OR v_row.manifest IS DISTINCT FROM v_manifest THEN
    RAISE EXCEPTION 'manifest digest collision or stored content drift'
      USING ERRCODE = '55000';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-score-input-manifest-seal@1',
    'manifestId', v_row.manifest_id,
    'manifestDigest', v_row.manifest_digest,
    'inputCount', v_row.manifest->'inputCount',
    'inputDigest', v_row.manifest->'scorer'->>'inputDigest',
    'outputDigest', v_row.manifest->'scorer'->>'outputDigest',
    'outputs', v_row.manifest->'outputs',
    'validUntil', v_row.manifest->'validUntil'
  );
END;
$seal$;

CREATE FUNCTION arena.verify_leaderboard_score_input_manifest_v1(
  p_manifest_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $verify$
DECLARE
  v_row arena.leaderboard_score_input_manifests%ROWTYPE;
  v_expected_basis jsonb;
  v_expected_digest text;
  v_expected_manifest jsonb;
BEGIN
  IF p_manifest_id IS NULL THEN
    RAISE EXCEPTION 'manifest id is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT stored.*
  INTO STRICT v_row
  FROM arena.leaderboard_score_input_manifests AS stored
  WHERE stored.manifest_id = p_manifest_id;

  v_expected_basis := arena.encode_leaderboard_score_input_manifest_v1(
    v_row.manifest->>'period',
    v_row.manifest->'source'->>'sourceBundleDigest',
    v_row.manifest->'source'->>'scoreRowsDigest',
    v_row.manifest->'source'->>'physicalBoardsDigest',
    v_row.manifest->'source'->'evidence',
    v_row.manifest->'enrichment'->>'contract',
    v_row.manifest->'enrichment'->'evidence',
    v_row.manifest->'eligibility'->>'contract',
    v_row.manifest->'eligibility'->'evidence',
    v_row.manifest->'inputs',
    (v_row.manifest->>'validUntil')::timestamp with time zone
  );
  v_expected_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_expected_basis::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  v_expected_manifest := v_expected_basis || pg_catalog.jsonb_build_object(
    'manifestDigest', v_expected_digest
  );

  IF v_row.manifest_digest IS DISTINCT FROM v_expected_digest
     OR v_row.manifest IS DISTINCT FROM v_expected_manifest
     OR v_row.period IS DISTINCT FROM v_expected_manifest->>'period'
     OR v_row.valid_until IS DISTINCT FROM
        (v_expected_manifest->>'validUntil')::timestamp with time zone THEN
    RAISE EXCEPTION 'stored score-input manifest failed content verification'
      USING ERRCODE = '55000';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-score-input-manifest-verification@1',
    'contentValid', true,
    'valid', v_row.valid_until > pg_catalog.statement_timestamp(),
    'expired', v_row.valid_until <= pg_catalog.statement_timestamp(),
    'manifestId', v_row.manifest_id,
    'manifestDigest', v_row.manifest_digest,
    'inputCount', v_row.manifest->'inputCount',
    'inputDigest', v_row.manifest->'scorer'->>'inputDigest',
    'outputDigest', v_row.manifest->'scorer'->>'outputDigest',
    'validUntil', v_row.manifest->'validUntil'
  );
EXCEPTION
  WHEN no_data_found THEN
    RAISE EXCEPTION 'score-input manifest does not exist'
      USING ERRCODE = 'P0002';
END;
$verify$;

REVOKE ALL ON TABLE arena.leaderboard_score_input_manifests
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.encode_leaderboard_score_input_manifest_v1(
  text, text, text, text, jsonb, text, jsonb, text, jsonb, jsonb,
  timestamp with time zone
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.seal_leaderboard_score_input_manifest_v1(
  text, text, text, text, jsonb, text, jsonb, text, jsonb, jsonb,
  timestamp with time zone
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.verify_leaderboard_score_input_manifest_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Hostile default privileges can leak newly created tables/functions to roles
-- outside the normal API list. Remove every inherited non-owner privilege.
DO $owner_only_acl$
DECLARE
  v_role record;
  v_signature text;
BEGIN
  FOR v_role IN
    SELECT DISTINCT pg_catalog.pg_get_userbyid(privilege_row.grantee) AS role_name
    FROM pg_catalog.pg_class AS relation_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation_row.relacl,
        pg_catalog.acldefault('r', relation_row.relowner)
      )
    ) AS privilege_row
    WHERE relation_row.oid = 'arena.leaderboard_score_input_manifests'::regclass
      AND privilege_row.grantee NOT IN (0, relation_row.relowner)
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE arena.leaderboard_score_input_manifests FROM %I',
      v_role.role_name
    );
  END LOOP;

  FOR v_signature IN
    SELECT signature.value
    FROM pg_catalog.unnest(ARRAY[
      'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)',
      'arena.seal_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)',
      'arena.verify_leaderboard_score_input_manifest_v1(uuid)'
    ]::text[]) AS signature(value)
  LOOP
    FOR v_role IN
      SELECT DISTINCT pg_catalog.pg_get_userbyid(privilege_row.grantee) AS role_name
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS privilege_row
      WHERE function_row.oid = pg_catalog.to_regprocedure(v_signature)
        AND privilege_row.privilege_type = 'EXECUTE'
        AND privilege_row.grantee NOT IN (0, function_row.proowner)
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON FUNCTION %s FROM %I',
        v_signature,
        v_role.role_name
      );
    END LOOP;
  END LOOP;
END
$owner_only_acl$;

COMMENT ON TABLE arena.leaderboard_score_input_manifests IS
  'Private content-addressed PG17 score input/output manifests. Inert until a deterministic database evidence builder and atomic finalizer are deployed.';
COMMENT ON FUNCTION arena.encode_leaderboard_score_input_manifest_v1(
  text, text, text, text, jsonb, text, jsonb, text, jsonb, jsonb,
  timestamp with time zone
) IS
  'Private parsed-jsonb codec binding source, board, enrichment, eligibility, canonical nine-field scorer inputs, PG17 scorer definitions, and outputs. Owner-only; no authority claim is made for caller-supplied evidence.';
COMMENT ON FUNCTION arena.seal_leaderboard_score_input_manifest_v1(
  text, text, text, text, jsonb, text, jsonb, text, jsonb, jsonb,
  timestamp with time zone
) IS
  'Private idempotent manifest seal for a future deterministic database builder. Never grant to PostgREST API roles.';
COMMENT ON FUNCTION arena.verify_leaderboard_score_input_manifest_v1(uuid) IS
  'Private verifier that reruns the PG17 scorer and recomputes definition, evidence, input, output, and full manifest digests.';

DO $postflight$
DECLARE
  v_table_oid oid := 'arena.leaderboard_score_input_manifests'::regclass::oid;
  v_function_oid oid;
  v_expected_volatility "char";
  v_signature text;
BEGIN
  IF NOT (
    SELECT relation_row.relrowsecurity
    FROM pg_catalog.pg_class AS relation_row
    WHERE relation_row.oid = v_table_oid
  ) THEN
    RAISE EXCEPTION 'score-input manifest table RLS is not enabled';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_table_oid
      AND constraint_row.conname =
          'leaderboard_score_input_manifest_rank_eligible_pnl'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND pg_catalog.strpos(
            pg_catalog.pg_get_expr(
              constraint_row.conbin,
              constraint_row.conrelid,
              true
            ),
            'jsonb_path_query_array'
          ) > 0
  ) THEN
    RAISE EXCEPTION 'score-input manifest PnL table constraint drifted';
  END IF;

  FOR v_signature, v_expected_volatility IN
    SELECT * FROM (VALUES
      (
        'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)',
        's'::"char"
      ),
      (
        'arena.seal_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)',
        'v'::"char"
      ),
      ('arena.verify_leaderboard_score_input_manifest_v1(uuid)', 's'::"char")
    ) AS expected(signature, volatility)
  LOOP
    v_function_oid := pg_catalog.to_regprocedure(v_signature);
    IF v_function_oid IS NULL OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_function_oid
        AND (
          function_row.provolatile <> v_expected_volatility
          OR function_row.prosecdef
          OR function_row.proconfig IS NULL
          OR NOT ('search_path=pg_catalog, pg_temp' = ANY(function_row.proconfig))
        )
    ) THEN
      RAISE EXCEPTION 'score-input manifest function catalog contract drifted: %',
        v_signature;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = pg_catalog.to_regprocedure(
      'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'
    )
      AND (
        function_row.proconfig IS NULL
        OR NOT ('extra_float_digits=3' = ANY(function_row.proconfig))
        OR NOT ('quote_all_identifiers=off' = ANY(function_row.proconfig))
      )
  ) THEN
    RAISE EXCEPTION 'score-input manifest encoder canonical GUC contract drifted';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM pg_catalog.unnest(
         ARRAY['anon', 'authenticated', 'service_role']::text[]
       ) AS api_role(role_name)
       CROSS JOIN pg_catalog.unnest(
         ARRAY[
           'SELECT', 'INSERT', 'UPDATE', 'DELETE',
           'TRUNCATE', 'REFERENCES', 'TRIGGER'
         ]::text[]
       ) AS table_privilege(privilege_name)
       WHERE pg_catalog.has_table_privilege(
         api_role.role_name,
         'arena.leaderboard_score_input_manifests',
         table_privilege.privilege_name
       )
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS relation_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           relation_row.relacl,
           pg_catalog.acldefault('r', relation_row.relowner)
         )
       ) AS privilege_row
       WHERE relation_row.oid = v_table_oid
         AND privilege_row.grantee <> relation_row.relowner
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS privilege_row
       WHERE function_row.oid IN (
         pg_catalog.to_regprocedure(
           'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'
         ),
         pg_catalog.to_regprocedure(
           'arena.seal_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'
         ),
         pg_catalog.to_regprocedure(
           'arena.verify_leaderboard_score_input_manifest_v1(uuid)'
         )
       )
         AND privilege_row.privilege_type = 'EXECUTE'
         AND privilege_row.grantee <> function_row.proowner
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.unnest(
         ARRAY['anon', 'authenticated', 'service_role']::text[]
       ) AS api_role(role_name)
       CROSS JOIN pg_catalog.unnest(ARRAY[
         'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)',
         'arena.seal_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)',
         'arena.verify_leaderboard_score_input_manifest_v1(uuid)'
       ]::text[]) AS function_signature(signature)
       WHERE pg_catalog.has_function_privilege(
         api_role.role_name,
         function_signature.signature,
         'EXECUTE'
       )
     ) THEN
    RAISE EXCEPTION 'score-input manifest private ACL postflight failed';
  END IF;
END
$postflight$;

COMMIT;
