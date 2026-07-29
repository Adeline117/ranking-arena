#!/usr/bin/env bash

# Sourced only by leaderboard-rank-generation-atomic-writer.pg17.sh after the
# real publication-plan fixture and the v5/manifest-v2 prerequisites exist.

run_metric_trust_projection_v2_proof() {
  local output
  local status
  local rollback_state

  psql_cmd -q <<'SQL'
CREATE TABLE arena.fixture_projection_v1_catalog AS
SELECT function_row.oid, pg_catalog.to_jsonb(function_row) AS catalog
FROM pg_catalog.pg_proc AS function_row
WHERE function_row.oid =
  'arena.build_leaderboard_metric_trust_projection_v1(text,jsonb,jsonb)'::regprocedure;

GRANT EXECUTE ON FUNCTION
  arena.build_leaderboard_metric_trust_projection_v1(text, jsonb, jsonb)
  TO PUBLIC;
SQL
  set +e
  output="$(psql_cmd -q -f "$PROJECTION_V2_MIGRATION" 2>&1)"
  status=$?
  set -e
  if ((status == 0)); then
    echo 'projection v2 accepted a leaked v1 prerequisite grant' >&2
    return 1
  fi
  if [[ "$output" != *'projection v2 prerequisite authority boundary drifted'* ]]; then
    echo 'projection v2 rejected leaked v1 authority for the wrong reason' >&2
    echo "$output" >&2
    return 1
  fi
  rollback_state="$(psql_cmd -Atqc "
    SELECT pg_catalog.concat_ws(
      '|',
      pg_catalog.to_regprocedure(
        'arena.build_leaderboard_metric_trust_projection_v2(text,jsonb,jsonb)'
      ) IS NULL,
      (SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.pronamespace = 'arena'::regnamespace
         AND function_row.proname =
           'build_leaderboard_metric_trust_projection_v2')
    );
  ")"
  if [[ "$rollback_state" != 't|0' ]]; then
    echo "failed projection v2 preflight left partial state: $rollback_state" >&2
    return 1
  fi

  psql_cmd -q <<'SQL'
REVOKE ALL ON FUNCTION
  arena.build_leaderboard_metric_trust_projection_v1(text, jsonb, jsonb)
  FROM PUBLIC;
CREATE FUNCTION arena.build_leaderboard_metric_trust_projection_v2(text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS 'SELECT pg_catalog.jsonb_build_object(''accepted'', true)';
SQL
  set +e
  output="$(psql_cmd -q -f "$PROJECTION_V2_MIGRATION" 2>&1)"
  status=$?
  set -e
  if ((status == 0)); then
    echo 'projection v2 accepted a noncanonical same-name overload' >&2
    return 1
  fi
  if [[ "$output" != *'noncanonical metric-trust projection v2 overload detected'* ]]; then
    echo 'projection v2 rejected its overload for the wrong reason' >&2
    echo "$output" >&2
    return 1
  fi
  psql_cmd -q <<'SQL'
DROP FUNCTION arena.build_leaderboard_metric_trust_projection_v2(text);
SQL

  psql_cmd -q -f "$PROJECTION_V2_MIGRATION"

  psql_cmd -q <<'SQL'
BEGIN;
DO $projection_v2_semantics$
DECLARE
  v_bundle jsonb := public.arena_score_inputs_publish_bundle_json(
    '90D', 1000, 48
  );
  v_base_v1 jsonb;
  v_base_v2 jsonb;
  v_score_rows jsonb;
  v_zero_v1 jsonb;
  v_zero_v2 jsonb;
  v_probe jsonb;
  v_sealed jsonb;
  v_verified jsonb;
BEGIN
  v_base_v1 := arena.build_leaderboard_metric_trust_projection_v1(
    '90D', v_bundle->'scoreRows', v_bundle->'physicalBoards'
  );
  v_base_v2 := arena.build_leaderboard_metric_trust_projection_v2(
    '90D', v_bundle->'scoreRows', v_bundle->'physicalBoards'
  );
  IF (v_base_v1->>'inputCount')::integer IS DISTINCT FROM 1001
     OR (v_base_v2->>'inputCount')::integer IS DISTINCT FROM 1001
     OR v_base_v1->>'contract' IS DISTINCT FROM
       'leaderboard-score-metric-trust-projection@1'
     OR v_base_v2->>'contract' IS DISTINCT FROM
       'leaderboard-score-metric-trust-projection@2'
     OR v_base_v2->>'enrichmentContract' IS DISTINCT FROM
       'leaderboard-score-metric-trust-core-projection@1'
     OR v_base_v2->>'eligibilityContract' IS DISTINCT FROM
       'leaderboard-score-trusted-roi-pnl-win-mdd-usdt@2'
     OR v_base_v2->'eligibilityEvidence'->>'rankingMethodId'
       IS DISTINCT FROM 'arena-v5-roi-pnl-win-mdd-90d-usdt@1' THEN
    RAISE EXCEPTION 'projection v2 base envelope drifted: %, %',
      v_base_v1, v_base_v2;
  END IF;

  SELECT pg_catalog.jsonb_agg(
    CASE
      WHEN score_row.value->>'platform' = 'alpha'
       AND score_row.value->>'trader_key' = 'trader-000001' THEN
        pg_catalog.jsonb_set(
          pg_catalog.jsonb_set(
            score_row.value,
            '{win_rate}',
            '0'::jsonb
          ),
          '{max_drawdown}',
          '0'::jsonb
        )
      ELSE score_row.value
    END
    ORDER BY score_row.ordinality
  )
  INTO STRICT v_score_rows
  FROM pg_catalog.jsonb_array_elements(v_bundle->'scoreRows')
    WITH ORDINALITY AS score_row(value, ordinality);
  UPDATE arena.metric_rankable_observations
  SET value = 0
  WHERE trader_id = 1
    AND metric IN ('win_rate', 'mdd');

  v_zero_v1 := arena.build_leaderboard_metric_trust_projection_v1(
    '90D', v_score_rows, v_bundle->'physicalBoards'
  );
  v_zero_v2 := arena.build_leaderboard_metric_trust_projection_v2(
    '90D', v_score_rows, v_bundle->'physicalBoards'
  );
  IF (v_zero_v1->>'inputCount')::integer IS DISTINCT FROM 1000
     OR (v_zero_v2->>'inputCount')::integer IS DISTINCT FROM 1001
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_array_elements(v_zero_v2->'inputs') AS input(value)
       WHERE input.value->>'source' = 'alpha'
         AND input.value->>'source_trader_id' = 'trader-000001'
         AND input.value->'win_rate' = '0'::jsonb
         AND input.value->'max_drawdown' = '0'::jsonb
     ) THEN
    RAISE EXCEPTION 'trusted zero did not separate projection v1/v2: %, %',
      v_zero_v1, v_zero_v2;
  END IF;

  -- A raw bundle zero cannot manufacture trust when the database-owned
  -- observations still contain different values.
  UPDATE arena.metric_rankable_observations
  SET value = CASE metric WHEN 'win_rate' THEN 66 ELSE 8 END
  WHERE trader_id = 1
    AND metric IN ('win_rate', 'mdd');
  v_probe := arena.build_leaderboard_metric_trust_projection_v2(
    '90D', v_score_rows, v_bundle->'physicalBoards'
  );
  IF (v_probe->>'inputCount')::integer IS DISTINCT FROM 1000 THEN
    RAISE EXCEPTION 'untrusted raw zero entered projection v2';
  END IF;

  SELECT pg_catalog.jsonb_agg(
    CASE
      WHEN score_row.value->>'platform' = 'alpha'
       AND score_row.value->>'trader_key' = 'trader-000001' THEN
        pg_catalog.jsonb_set(
          score_row.value,
          '{win_rate}',
          'null'::jsonb
        )
      ELSE score_row.value
    END
    ORDER BY score_row.ordinality
  )
  INTO STRICT v_score_rows
  FROM pg_catalog.jsonb_array_elements(v_bundle->'scoreRows')
    WITH ORDINALITY AS score_row(value, ordinality);
  v_probe := arena.build_leaderboard_metric_trust_projection_v2(
    '90D', v_score_rows, v_bundle->'physicalBoards'
  );
  IF (v_probe->>'inputCount')::integer IS DISTINCT FROM 1000 THEN
    RAISE EXCEPTION 'null raw win rate entered projection v2';
  END IF;

  -- The source cap remains policy-excluded even when the raw row and trusted
  -- observation agree exactly.
  UPDATE arena.metric_rankable_score_inputs_shadow
  SET roi_pct = 0,
      pnl_usd = 0
  WHERE trader_id = 1;
  UPDATE arena.metric_rankable_observations
  SET value = CASE metric WHEN 'win_rate' THEN 50 ELSE 100 END
  WHERE trader_id = 1
    AND metric IN ('win_rate', 'mdd');
  SELECT pg_catalog.jsonb_agg(
    CASE
      WHEN score_row.value->>'platform' = 'alpha'
       AND score_row.value->>'trader_key' = 'trader-000001' THEN
        pg_catalog.jsonb_set(
          pg_catalog.jsonb_set(
            pg_catalog.jsonb_set(
              pg_catalog.jsonb_set(
                score_row.value,
                '{roi_pct}',
                '0'::jsonb
              ),
              '{pnl_usd}',
              '0'::jsonb
            ),
            '{win_rate}',
            '50'::jsonb
          ),
          '{max_drawdown}',
          '100'::jsonb
        )
      ELSE score_row.value
    END
    ORDER BY score_row.ordinality
  )
  INTO STRICT v_score_rows
  FROM pg_catalog.jsonb_array_elements(v_bundle->'scoreRows')
    WITH ORDINALITY AS score_row(value, ordinality);
  v_probe := arena.build_leaderboard_metric_trust_projection_v2(
    '90D', v_score_rows, v_bundle->'physicalBoards'
  );
  IF (v_probe->>'inputCount')::integer IS DISTINCT FROM 1000 THEN
    RAISE EXCEPTION '100 percent MDD cap entered projection v2';
  END IF;

  -- Zero is not subject to the tiny-positive sentinel heuristic. The same
  -- high-ROI row with a suspicious 0.5% MDD remains excluded.
  UPDATE arena.metric_rankable_score_inputs_shadow
  SET roi_pct = 600,
      pnl_usd = 12000
  WHERE trader_id = 1;
  UPDATE arena.metric_rankable_observations
  SET value = CASE metric WHEN 'win_rate' THEN 50 ELSE 0.5 END
  WHERE trader_id = 1
    AND metric IN ('win_rate', 'mdd');
  SELECT pg_catalog.jsonb_agg(
    CASE
      WHEN score_row.value->>'platform' = 'alpha'
       AND score_row.value->>'trader_key' = 'trader-000001' THEN
        pg_catalog.jsonb_set(
          pg_catalog.jsonb_set(
            pg_catalog.jsonb_set(
              score_row.value,
              '{roi_pct}',
              '600'::jsonb
            ),
            '{win_rate}',
            '50'::jsonb
          ),
          '{max_drawdown}',
          '0.5'::jsonb
        )
      ELSE score_row.value
    END
    ORDER BY score_row.ordinality
  )
  INTO STRICT v_score_rows
  FROM pg_catalog.jsonb_array_elements(v_bundle->'scoreRows')
    WITH ORDINALITY AS score_row(value, ordinality);
  v_probe := arena.build_leaderboard_metric_trust_projection_v2(
    '90D', v_score_rows, v_bundle->'physicalBoards'
  );
  IF (v_probe->>'inputCount')::integer IS DISTINCT FROM 1000 THEN
    RAISE EXCEPTION 'tiny positive MDD sentinel entered projection v2';
  END IF;

  UPDATE arena.metric_rankable_observations
  SET value = 0
  WHERE trader_id = 1
    AND metric IN ('win_rate', 'mdd');
  SELECT pg_catalog.jsonb_agg(
    CASE
      WHEN score_row.value->>'platform' = 'alpha'
       AND score_row.value->>'trader_key' = 'trader-000001' THEN
        pg_catalog.jsonb_set(
          pg_catalog.jsonb_set(
            pg_catalog.jsonb_set(
              score_row.value,
              '{roi_pct}',
              '600'::jsonb
            ),
            '{win_rate}',
            '0'::jsonb
          ),
          '{max_drawdown}',
          '0'::jsonb
        )
      ELSE score_row.value
    END
    ORDER BY score_row.ordinality
  )
  INTO STRICT v_score_rows
  FROM pg_catalog.jsonb_array_elements(v_bundle->'scoreRows')
    WITH ORDINALITY AS score_row(value, ordinality);
  v_zero_v2 := arena.build_leaderboard_metric_trust_projection_v2(
    '90D', v_score_rows, v_bundle->'physicalBoards'
  );
  IF (v_zero_v2->>'inputCount')::integer IS DISTINCT FROM 1001 THEN
    RAISE EXCEPTION 'trusted zero was confused with tiny positive MDD';
  END IF;

  v_sealed := arena.seal_leaderboard_score_input_manifest_v2(
    '90D',
    pg_catalog.repeat('1', 64),
    pg_catalog.repeat('2', 64),
    pg_catalog.repeat('3', 64),
    pg_catalog.jsonb_build_object(
      'contract', 'fixture-projection-v2-source@1'
    ),
    v_zero_v2->>'enrichmentContract',
    v_zero_v2->'enrichmentEvidence',
    v_zero_v2->>'eligibilityContract',
    v_zero_v2->'eligibilityEvidence',
    v_zero_v2->'inputs',
    (v_zero_v2->>'validUntil')::timestamptz
  );
  v_verified := arena.verify_leaderboard_score_input_manifest_v2(
    (v_sealed->>'manifestId')::uuid
  );
  IF v_sealed->>'contract' IS DISTINCT FROM
       'leaderboard-score-input-manifest-seal@2'
     OR (v_verified->>'contentValid')::boolean IS DISTINCT FROM true
     OR (v_verified->>'valid')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'projection v2 did not compose with manifest v2: %, %',
      v_sealed, v_verified;
  END IF;

  -- Missing/expired trust evidence cannot remain rankable even when raw
  -- values are present and numerically valid.
  UPDATE arena.metric_rankable_observations
  SET valid_until = pg_catalog.clock_timestamp() - interval '1 second'
  WHERE trader_id = 1
    AND metric = 'mdd';
  v_probe := arena.build_leaderboard_metric_trust_projection_v2(
    '90D', v_score_rows, v_bundle->'physicalBoards'
  );
  IF (v_probe->>'inputCount')::integer IS DISTINCT FROM 1000 THEN
    RAISE EXCEPTION 'expired MDD evidence entered projection v2';
  END IF;

  UPDATE arena.metric_rankable_observations
  SET valid_until = pg_catalog.clock_timestamp() + interval '1 hour'
  WHERE trader_id = 1
    AND metric = 'mdd';
  DELETE FROM arena.metric_rankable_observations
  WHERE trader_id = 1
    AND metric = 'win_rate';
  v_probe := arena.build_leaderboard_metric_trust_projection_v2(
    '90D', v_score_rows, v_bundle->'physicalBoards'
  );
  IF (v_probe->>'inputCount')::integer IS DISTINCT FROM 1000 THEN
    RAISE EXCEPTION 'missing win-rate evidence entered projection v2';
  END IF;
END
$projection_v2_semantics$;
ROLLBACK;

DO $projection_v1_catalog_proof$
DECLARE
  v_snapshot arena.fixture_projection_v1_catalog%ROWTYPE;
  v_current pg_catalog.pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_snapshot
  FROM arena.fixture_projection_v1_catalog;
  SELECT * INTO STRICT v_current
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'arena.build_leaderboard_metric_trust_projection_v1(text,jsonb,jsonb)'::regprocedure;
  IF v_current.oid <> v_snapshot.oid
     OR pg_catalog.to_jsonb(v_current) IS DISTINCT FROM v_snapshot.catalog THEN
    RAISE EXCEPTION 'projection v2 changed historical projection v1';
  END IF;
END
$projection_v1_catalog_proof$;

CREATE TABLE arena.fixture_projection_v2_catalog AS
SELECT function_row.oid, pg_catalog.to_jsonb(function_row) AS catalog
FROM pg_catalog.pg_proc AS function_row
WHERE function_row.oid =
  'arena.build_leaderboard_metric_trust_projection_v2(text,jsonb,jsonb)'::regprocedure;

GRANT EXECUTE ON FUNCTION
  arena.build_leaderboard_metric_trust_projection_v2(text, jsonb, jsonb)
  TO fixture_rogue;
SQL

  psql_cmd -q -f "$PROJECTION_V2_MIGRATION"
  psql_cmd -q <<'SQL'
DO $projection_v2_replay_proof$
DECLARE
  v_snapshot arena.fixture_projection_v2_catalog%ROWTYPE;
  v_current pg_catalog.pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_snapshot
  FROM arena.fixture_projection_v2_catalog;
  SELECT * INTO STRICT v_current
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'arena.build_leaderboard_metric_trust_projection_v2(text,jsonb,jsonb)'::regprocedure;
  IF v_current.oid <> v_snapshot.oid
     OR pg_catalog.to_jsonb(v_current) IS DISTINCT FROM v_snapshot.catalog
     OR pg_catalog.has_function_privilege(
       'fixture_rogue', v_current.oid, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'projection v2 replay changed identity or leaked ACL';
  END IF;
END
$projection_v2_replay_proof$;

ALTER FUNCTION arena.build_leaderboard_metric_trust_projection_v2(
  text, jsonb, jsonb
) RETURNS NULL ON NULL INPUT;
SQL
  set +e
  output="$(psql_cmd -q -f "$PROJECTION_V2_MIGRATION" 2>&1)"
  status=$?
  set -e
  if ((status == 0)); then
    echo 'projection v2 migration accepted catalog drift' >&2
    return 1
  fi
  if [[ "$output" != *'existing metric-trust projection v2 drifted'* ]]; then
    echo 'projection v2 catalog drift failed for the wrong reason' >&2
    echo "$output" >&2
    return 1
  fi
  psql_cmd -q <<'SQL'
ALTER FUNCTION arena.build_leaderboard_metric_trust_projection_v2(
  text, jsonb, jsonb
) CALLED ON NULL INPUT;
SQL
  psql_cmd -q -f "$PROJECTION_V2_MIGRATION"
}
