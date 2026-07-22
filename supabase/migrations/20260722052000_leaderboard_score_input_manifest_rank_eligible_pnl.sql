-- Migration: 20260722052000_leaderboard_score_input_manifest_rank_eligible_pnl.sql
-- Description: Forward-only hardening for the already-applied 51000 score-input
-- manifest contract. Require every rank-eligible input to carry observed finite
-- PnL while preserving zero and losses. The immutable 51000 body must never be
-- rewritten after its exact production ledger row exists.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL quote_all_identifiers = 'off';

DO $preflight$
DECLARE
  v_encoder_oid oid := pg_catalog.to_regprocedure(
    'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'
  );
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION 'rank-eligible score-input PnL requires PostgreSQL 17';
  END IF;

  -- Selective predeploy is safe only when the exact immutable 51000 body is
  -- already committed in the production ledger. Lock that evidence for this
  -- transaction; never repair drift by changing the ledger.
  PERFORM 1
  FROM supabase_migrations.schema_migrations AS ledger
  WHERE ledger.version = '20260722051000'
    AND ledger.name = 'leaderboard_score_input_manifest_contract'
    AND ledger.created_by = 'codex'
    AND ledger.idempotency_key =
        'codex:20260722051000:fdf578522865afc7b81d7f1fedd99e4bf6e007d0460d3ba678babf4414a4829c'
    AND pg_catalog.array_length(ledger.statements, 1) = 1
    AND pg_catalog.encode(
          extensions.digest(ledger.statements[1], 'sha256'),
          'hex'
        ) = 'fdf578522865afc7b81d7f1fedd99e4bf6e007d0460d3ba678babf4414a4829c'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rank-eligible PnL requires exact immutable 20260722051000 ledger';
  END IF;

  IF pg_catalog.to_regclass('arena.leaderboard_score_input_manifests') IS NULL
     OR v_encoder_oid IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.seal_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.verify_leaderboard_score_input_manifest_v1(uuid)'
        ) IS NULL THEN
    RAISE EXCEPTION 'immutable 51000 score-input manifest objects are unavailable';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
          'arena.leaderboard_score_input_manifests'::pg_catalog.regclass
      AND constraint_row.conname =
          'leaderboard_score_input_manifest_rank_eligible_pnl'
  ) THEN
    RAISE EXCEPTION 'rank-eligible score-input PnL constraint already exists without ledger';
  END IF;

  IF pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(v_encoder_oid),
       'leaderboard score-input PnL must be a finite JSON number'
     ) > 0 THEN
    RAISE EXCEPTION 'immutable 51000 encoder was rewritten instead of forward-migrated';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM arena.leaderboard_score_input_manifests AS stored
    WHERE pg_catalog.jsonb_typeof(stored.manifest->'inputs') IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_array_length(stored.manifest->'inputs') <>
          pg_catalog.jsonb_array_length(
            pg_catalog.jsonb_path_query_array(
              stored.manifest->'inputs',
              '$[*] ? (@.pnl.type() == "number")'::pg_catalog.jsonpath
            )
          )
  ) THEN
    RAISE EXCEPTION 'existing score-input manifest has non-numeric rank-eligible PnL';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION arena.encode_leaderboard_score_input_manifest_v1(
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

ALTER TABLE arena.leaderboard_score_input_manifests
  ADD CONSTRAINT leaderboard_score_input_manifest_rank_eligible_pnl
  CHECK (
    (
      pg_catalog.jsonb_typeof(manifest->'inputs') = 'array'
      AND pg_catalog.jsonb_array_length(manifest->'inputs') =
          pg_catalog.jsonb_array_length(
            pg_catalog.jsonb_path_query_array(
              manifest->'inputs',
              '$[*] ? (@.pnl.type() == "number")'::pg_catalog.jsonpath
            )
          )
    ) IS TRUE
  ) NOT VALID;

ALTER TABLE arena.leaderboard_score_input_manifests
  VALIDATE CONSTRAINT leaderboard_score_input_manifest_rank_eligible_pnl;

REVOKE ALL ON FUNCTION arena.encode_leaderboard_score_input_manifest_v1(
  text, text, text, text, jsonb, text, jsonb, text, jsonb, jsonb,
  timestamp with time zone
) FROM PUBLIC, anon, authenticated, service_role;

-- Hostile default privileges may have granted EXECUTE to arbitrary roles.
DO $owner_only_acl$
DECLARE
  v_role record;
  v_signature text :=
    'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)';
BEGIN
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
END
$owner_only_acl$;

COMMENT ON FUNCTION arena.encode_leaderboard_score_input_manifest_v1(
  text, text, text, text, jsonb, text, jsonb, text, jsonb, jsonb,
  timestamp with time zone
) IS
  'Private parsed-jsonb codec binding canonical PG17 ranking inputs and requiring observed finite PnL for every rank-eligible row. Owner-only.';

DO $postflight$
DECLARE
  v_table_oid oid := 'arena.leaderboard_score_input_manifests'::regclass::oid;
  v_encoder_oid oid := pg_catalog.to_regprocedure(
    'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'
  );
  v_constraint_name text;
  v_probe_digest text;
  v_probe_valid_until timestamp with time zone;
  v_rows integer;
BEGIN
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

  -- pg_get_expr canonicalizes JSONPath text across server builds, so prove the
  -- constraint semantically instead of trusting a formatting-sensitive match.
  v_probe_valid_until := pg_catalog.statement_timestamp() + interval '1 hour';
  v_probe_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        'rank-eligible-pnl-invalid:' || extensions.gen_random_uuid()::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  BEGIN
    INSERT INTO arena.leaderboard_score_input_manifests (
      manifest_digest, period, manifest, valid_until
    ) VALUES (
      v_probe_digest,
      '30D',
      pg_catalog.jsonb_build_object(
        'contract', 'leaderboard-score-input-manifest@1',
        'manifestDigest', v_probe_digest,
        'period', '30D',
        'validUntil', v_probe_valid_until,
        'inputs', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('pnl', NULL)
        )
      ),
      v_probe_valid_until
    );
    RAISE EXCEPTION 'rank-eligible PnL CHECK accepted JSON null';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
      IF v_constraint_name IS DISTINCT FROM
           'leaderboard_score_input_manifest_rank_eligible_pnl' THEN
        RAISE EXCEPTION 'unexpected postflight constraint failure: %',
          v_constraint_name;
      END IF;
  END;

  v_probe_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        'rank-eligible-pnl-missing:' || extensions.gen_random_uuid()::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  BEGIN
    INSERT INTO arena.leaderboard_score_input_manifests (
      manifest_digest, period, manifest, valid_until
    ) VALUES (
      v_probe_digest,
      '30D',
      pg_catalog.jsonb_build_object(
        'contract', 'leaderboard-score-input-manifest@1',
        'manifestDigest', v_probe_digest,
        'period', '30D',
        'validUntil', v_probe_valid_until
      ),
      v_probe_valid_until
    );
    RAISE EXCEPTION 'rank-eligible PnL CHECK accepted missing inputs';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
      IF v_constraint_name IS DISTINCT FROM
           'leaderboard_score_input_manifest_rank_eligible_pnl' THEN
        RAISE EXCEPTION 'unexpected missing-input constraint failure: %',
          v_constraint_name;
      END IF;
  END;

  v_probe_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        'rank-eligible-pnl-zero:' || extensions.gen_random_uuid()::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  INSERT INTO arena.leaderboard_score_input_manifests (
    manifest_digest, period, manifest, valid_until
  ) VALUES (
    v_probe_digest,
    '30D',
    pg_catalog.jsonb_build_object(
      'contract', 'leaderboard-score-input-manifest@1',
      'manifestDigest', v_probe_digest,
      'period', '30D',
      'validUntil', v_probe_valid_until,
      'inputs', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('pnl', 0)
      )
    ),
    v_probe_valid_until
  );
  DELETE FROM arena.leaderboard_score_input_manifests
  WHERE manifest_digest = v_probe_digest;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'rank-eligible PnL zero probe was not removed';
  END IF;

  IF v_encoder_oid IS NULL OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_encoder_oid
      AND (
        function_row.provolatile <> 's'
        OR function_row.prosecdef
        OR function_row.proconfig IS NULL
        OR NOT ('search_path=pg_catalog, pg_temp' = ANY(function_row.proconfig))
        OR NOT ('extra_float_digits=3' = ANY(function_row.proconfig))
        OR NOT ('quote_all_identifiers=off' = ANY(function_row.proconfig))
      )
  ) THEN
    RAISE EXCEPTION 'rank-eligible score-input encoder catalog contract drifted';
  END IF;

  IF pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(v_encoder_oid),
       'leaderboard score-input PnL must be a finite JSON number'
     ) = 0
     OR pg_catalog.strpos(
          pg_catalog.pg_get_functiondef(v_encoder_oid),
          'pg_catalog.jsonb_typeof(input_row.value->''pnl'')'
        ) = 0 THEN
    RAISE EXCEPTION 'rank-eligible score-input encoder body drifted';
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
    WHERE function_row.oid = v_encoder_oid
      AND privilege_row.privilege_type = 'EXECUTE'
      AND privilege_row.grantee NOT IN (0, function_row.proowner)
  ) THEN
    RAISE EXCEPTION 'rank-eligible score-input encoder leaked EXECUTE';
  END IF;
END
$postflight$;

COMMIT;
