-- Migration: 20260721180903_metric_rankable_score_inputs_shadow.sql
-- Created: 2026-07-22T01:09:03Z
-- Description: Project the latest persisted leaderboard snapshot attempt's
-- complete USDT-comparable ROI+PnL pairs into a score-input shadow bundle.
-- This is a canary; the live score view and RPC stay unchanged. Acquisition
-- failures before snapshot persistence still require a durable attempt ledger.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('arena.metric_rankable_input_sets_shadow') IS NULL
     OR pg_catalog.to_regclass('arena.metric_rankable_observations') IS NULL
     OR pg_catalog.to_regclass('arena.metric_source_contracts') IS NULL
     OR pg_catalog.to_regclass('arena.metric_trust_runs') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_snapshots') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_entries') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL THEN
    RAISE EXCEPTION 'metric-trust score-input prerequisites are missing';
  END IF;

  IF pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'PostgREST API roles must exist';
  END IF;
END
$preflight$;

-- Select the latest persisted leaderboard snapshot attempt before applying any
-- pass/trust filter. A newer failed, partial, future-dated, or evidence-free
-- snapshot therefore suppresses the old pair instead of reviving it.
CREATE OR REPLACE VIEW arena.metric_rankable_score_inputs_shadow
WITH (security_invoker = true)
AS
WITH latest_attempt AS MATERIALIZED (
  SELECT DISTINCT ON (snapshot.source_id, snapshot.timeframe)
    snapshot.id AS snapshot_id,
    snapshot.source_id,
    snapshot.timeframe,
    snapshot.scraped_at,
    snapshot.actual_count,
    snapshot.count_check_passed
  FROM arena.leaderboard_snapshots AS snapshot
  ORDER BY
    snapshot.source_id,
    snapshot.timeframe,
    snapshot.scraped_at DESC,
    snapshot.id DESC
), current_entry_counts AS MATERIALIZED (
  SELECT
    latest.snapshot_id,
    pg_catalog.count(entry.snapshot_id)::bigint AS entry_count,
    pg_catalog.count(entry.snapshot_id) FILTER (
      WHERE entry.currency = 'USDT'
        AND entry_trader.source_id = latest.source_id
    )::bigint AS compatible_entry_count
  FROM latest_attempt AS latest
  LEFT JOIN arena.leaderboard_entries AS entry
    ON entry.snapshot_id = latest.snapshot_id
   AND entry.scraped_at = latest.scraped_at
   AND entry.timeframe = latest.timeframe
  LEFT JOIN arena.traders AS entry_trader
    ON entry_trader.id = entry.trader_id
  GROUP BY latest.snapshot_id
)
SELECT
  pair.source_id,
  pair.trader_id,
  pair.snapshot_id,
  pair.source_run_id,
  pair.source_contract_version,
  pair.metric_set_id,
  pair.roi_observation_id,
  pair.pnl_observation_id,
  roi_evidence.provenance AS roi_provenance,
  roi_evidence.methodology_version AS roi_methodology_version,
  pnl_evidence.provenance AS pnl_provenance,
  pnl_evidence.methodology_version AS pnl_methodology_version,
  CASE pair.timeframe
    WHEN 7 THEN 'arena-core-roi-pnl-7d-usdt@1'
    WHEN 30 THEN 'arena-core-roi-pnl-30d-usdt@1'
    WHEN 90 THEN 'arena-core-roi-pnl-90d-usdt@1'
  END AS ranking_method_id,
  'USDT'::pg_catalog.text AS comparison_currency,
  COALESCE(
    NULLIF(pg_catalog.btrim(source.meta->>'legacy_platform'), ''),
    source.slug
  ) AS platform,
  source.product_type,
  CASE WHEN source.product_type = 'spot' THEN 'spot' ELSE 'futures' END
    AS market_type,
  trader.exchange_trader_id AS trader_key,
  (pair.timeframe::pg_catalog.text || 'D') AS "window",
  entry.rank AS board_rank,
  pair.roi AS roi_pct,
  pair.pnl AS pnl_usd,
  -- No registered contracts exist for these score inputs yet. NULL prevents
  -- downstream canaries from borrowing unverified legacy enrichment.
  NULL::pg_catalog.numeric AS win_rate,
  NULL::pg_catalog.numeric AS max_drawdown,
  NULL::pg_catalog.numeric AS copiers,
  NULL::pg_catalog.numeric AS trades_count,
  NULL::pg_catalog.numeric AS sharpe_ratio,
  NULL::pg_catalog.numeric AS sortino_ratio,
  NULL::pg_catalog.numeric AS calmar_ratio,
  NULL::pg_catalog.numeric AS volatility_pct,
  trader.trader_kind,
  trader.nickname AS handle,
  COALESCE(trader.avatar_url_mirror, trader.avatar_url_origin) AS avatar_url,
  pair.currency,
  pair.source_as_of AS as_of,
  LEAST(roi_evidence.valid_until, pnl_evidence.valid_until) AS valid_until,
  roi_evidence.window_start,
  roi_evidence.window_end,
  latest.scraped_at AS board_as_of,
  run.completed_at AS acquisition_completed_at,
  pair.rank_eligible
FROM latest_attempt AS latest
JOIN current_entry_counts AS entry_count
  ON entry_count.snapshot_id = latest.snapshot_id
JOIN arena.metric_rankable_input_sets_shadow AS pair
  ON pair.source_id = latest.source_id
 AND pair.snapshot_id = latest.snapshot_id
 AND pair.timeframe = latest.timeframe
JOIN arena.metric_trust_runs AS run
  ON run.source_run_id = pair.source_run_id
 AND run.source_id = latest.source_id
 AND run.snapshot_id = latest.snapshot_id
 AND run.timeframe = latest.timeframe
 AND run.snapshot_scraped_at = latest.scraped_at
JOIN arena.metric_rankable_observations AS roi_evidence
  ON roi_evidence.id = pair.roi_observation_id
 AND roi_evidence.metric = 'roi'
 AND roi_evidence.value_unit = 'percent'
 AND roi_evidence.source_run_id = pair.source_run_id
 AND roi_evidence.snapshot_id = latest.snapshot_id
 AND roi_evidence.trader_id = pair.trader_id
JOIN arena.metric_rankable_observations AS pnl_evidence
  ON pnl_evidence.id = pair.pnl_observation_id
 AND pnl_evidence.metric = 'pnl'
 AND pnl_evidence.value_unit = 'currency'
 AND pnl_evidence.source_run_id = pair.source_run_id
 AND pnl_evidence.snapshot_id = latest.snapshot_id
 AND pnl_evidence.trader_id = pair.trader_id
JOIN arena.sources AS source
  ON source.id = latest.source_id
JOIN arena.traders AS trader
  ON trader.id = pair.trader_id
 AND trader.source_id = latest.source_id
JOIN arena.leaderboard_entries AS entry
  ON entry.snapshot_id = latest.snapshot_id
 AND entry.trader_id = pair.trader_id
 AND entry.scraped_at = latest.scraped_at
 AND entry.timeframe = latest.timeframe
WHERE latest.count_check_passed
  AND latest.scraped_at <= pg_catalog.statement_timestamp() + interval '5 minutes'
  AND run.completed_at <= pg_catalog.statement_timestamp() + interval '5 minutes'
  AND entry_count.entry_count = latest.actual_count::bigint
  AND entry_count.compatible_entry_count = latest.actual_count::bigint
  AND pair.rank_eligible
  AND pair.currency = 'USDT'
  AND source.status = 'active'
  AND source.serving_mode = 'serving'
  AND pair.timeframe = ANY (
    COALESCE(source.timeframes_native, ARRAY[]::integer[])
    || COALESCE(source.timeframes_derived, ARRAY[]::integer[])
  )
  AND source.currency = 'USDT'
  AND entry.currency = 'USDT'
  AND pg_catalog.btrim(COALESCE(source.meta->>'legacy_platform', '')) <> 'null';

-- Service-only canary bundle. scoreRows are the requested-window,
-- USDT-comparable advisory subset;
-- cohorts remains complete for the current active/serving registry when that
-- subset is empty. Its actions are advisory until a durable rollout-policy
-- universe and pre-snapshot acquisition-attempt ledger are installed.
CREATE OR REPLACE FUNCTION public.arena_metric_rankable_score_inputs_shadow_json(
  p_window text,
  p_per_platform_limit int DEFAULT 1000,
  p_max_age_hours int DEFAULT 48
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_timeframe smallint;
  v_ranking_method_id text;
BEGIN
  IF p_window IS NULL OR p_window NOT IN ('7D', '30D', '90D') THEN
    RAISE EXCEPTION 'invalid metric-trust score-input window: %', p_window
      USING ERRCODE = '22023';
  END IF;

  IF p_per_platform_limit IS NULL
     OR p_per_platform_limit < 1
     OR p_per_platform_limit > 10000 THEN
    RAISE EXCEPTION 'metric-trust score-input limit is outside 1..10000: %',
      p_per_platform_limit
      USING ERRCODE = '22023';
  END IF;

  IF p_max_age_hours IS NULL
     OR p_max_age_hours < 1
     OR p_max_age_hours > 168 THEN
    RAISE EXCEPTION 'metric-trust score-input max age is outside 1..168: %',
      p_max_age_hours
      USING ERRCODE = '22023';
  END IF;

  v_timeframe := CASE p_window
    WHEN '7D' THEN 7::smallint
    WHEN '30D' THEN 30::smallint
    WHEN '90D' THEN 90::smallint
  END;
  v_ranking_method_id := CASE p_window
    WHEN '7D' THEN 'arena-core-roi-pnl-7d-usdt@1'
    WHEN '30D' THEN 'arena-core-roi-pnl-30d-usdt@1'
    WHEN '90D' THEN 'arena-core-roi-pnl-90d-usdt@1'
  END;

  -- Every relation below is read by one statement and one MVCC snapshot.
  RETURN (
  WITH registry_cohorts AS MATERIALIZED (
    SELECT
      source.id AS source_id,
      source.slug AS registry_slug,
      COALESCE(
        NULLIF(pg_catalog.btrim(source.meta->>'legacy_platform'), ''),
        source.slug
      ) AS filter_source,
      source.currency AS source_currency
    FROM arena.sources AS source
    WHERE source.status = 'active'
      AND source.serving_mode = 'serving'
      AND v_timeframe = ANY (
        COALESCE(source.timeframes_native, ARRAY[]::integer[])
        || COALESCE(source.timeframes_derived, ARRAY[]::integer[])
      )
      AND pg_catalog.btrim(
        COALESCE(source.meta->>'legacy_platform', '')
      ) <> 'null'
  ), any_pair_contract_coverage AS MATERIALIZED (
    SELECT
      roi.source_id,
      pg_catalog.array_agg(
        DISTINCT common_currency.currency
        ORDER BY common_currency.currency
      ) AS available_currencies
    FROM arena.metric_source_contracts AS roi
    JOIN arena.metric_source_contracts AS pnl
      ON pnl.source_id = roi.source_id
     AND pnl.contract_version = roi.contract_version
     AND pnl.metric_set_id = roi.metric_set_id
     AND pnl.metric = 'pnl'
     AND pnl.value_unit = 'currency'
     AND pnl.active
     AND v_timeframe = ANY (pnl.timeframes)
    CROSS JOIN LATERAL pg_catalog.unnest(roi.currencies)
      AS common_currency(currency)
    WHERE roi.metric = 'roi'
      AND roi.value_unit = 'percent'
      AND roi.active
      AND v_timeframe = ANY (roi.timeframes)
      AND common_currency.currency = ANY (pnl.currencies)
    GROUP BY roi.source_id
  ), method_contract_coverage AS MATERIALIZED (
    SELECT DISTINCT roi.source_id
    FROM arena.metric_source_contracts AS roi
    JOIN arena.metric_source_contracts AS pnl
      ON pnl.source_id = roi.source_id
     AND pnl.contract_version = roi.contract_version
     AND pnl.metric_set_id = roi.metric_set_id
     AND pnl.metric = 'pnl'
     AND pnl.value_unit = 'currency'
     AND pnl.active
     AND v_timeframe = ANY (pnl.timeframes)
     AND 'USDT' = ANY (pnl.currencies)
    WHERE roi.metric = 'roi'
      AND roi.value_unit = 'percent'
      AND roi.active
      AND v_timeframe = ANY (roi.timeframes)
      AND 'USDT' = ANY (roi.currencies)
  ), latest_attempt AS MATERIALIZED (
    SELECT DISTINCT ON (snapshot.source_id)
      snapshot.source_id,
      snapshot.id AS latest_attempt_id,
      snapshot.scraped_at AS latest_attempt_scraped_at,
      snapshot.actual_count,
      snapshot.count_check_passed AS latest_attempt_passed
    FROM arena.leaderboard_snapshots AS snapshot
    JOIN registry_cohorts AS registry
      ON registry.source_id = snapshot.source_id
     AND snapshot.timeframe = v_timeframe
    ORDER BY
      snapshot.source_id,
      snapshot.scraped_at DESC,
      snapshot.id DESC
  ), attempt_entry_counts AS MATERIALIZED (
    SELECT
      attempt.latest_attempt_id,
      pg_catalog.count(entry.snapshot_id)::bigint AS entry_count,
      pg_catalog.count(entry.snapshot_id) FILTER (
        WHERE entry.currency = 'USDT'
          AND entry_trader.source_id = attempt.source_id
      )::bigint AS compatible_entry_count
    FROM latest_attempt AS attempt
    LEFT JOIN arena.leaderboard_entries AS entry
      ON entry.snapshot_id = attempt.latest_attempt_id
     AND entry.scraped_at = attempt.latest_attempt_scraped_at
     AND entry.timeframe = v_timeframe
    LEFT JOIN arena.traders AS entry_trader
      ON entry_trader.id = entry.trader_id
    GROUP BY attempt.latest_attempt_id
  ), exact_runs AS MATERIALIZED (
    SELECT
      attempt.source_id,
      run.source_run_id,
      run.acquisition_state,
      run.population_state,
      run.fetched_population,
      run.completed_at
    FROM latest_attempt AS attempt
    JOIN arena.metric_trust_runs AS run
      ON run.source_id = attempt.source_id
     AND run.snapshot_id = attempt.latest_attempt_id
     AND run.timeframe = v_timeframe
     AND run.snapshot_scraped_at = attempt.latest_attempt_scraped_at
  ), run_contracts AS MATERIALIZED (
    SELECT
      run.source_id,
      run.source_run_id,
      pg_catalog.array_agg(
        DISTINCT observation.source_contract_version
        ORDER BY observation.source_contract_version
      ) AS source_contract_versions,
      pg_catalog.array_agg(
        DISTINCT contract.metric_set_id
        ORDER BY contract.metric_set_id
      ) AS metric_set_ids
    FROM exact_runs AS run
    JOIN arena.metric_trust_observations AS observation
      ON observation.source_id = run.source_id
     AND observation.source_run_id = run.source_run_id
     AND observation.timeframe = v_timeframe
    JOIN arena.metric_source_contracts AS contract
      ON contract.id = observation.contract_id
    GROUP BY run.source_id, run.source_run_id
  ), eligible_counts AS MATERIALIZED (
    SELECT
      score_input.source_id,
      pg_catalog.count(*)::bigint AS eligible_count,
      pg_catalog.count(*) FILTER (
        WHERE score_input.board_rank <= p_per_platform_limit
      )::bigint AS returned_count
    FROM arena.metric_rankable_score_inputs_shadow AS score_input
    WHERE score_input."window" = p_window
      AND score_input.board_as_of > pg_catalog.statement_timestamp()
        - pg_catalog.make_interval(hours => p_max_age_hours)
    GROUP BY score_input.source_id
  ), cohort_evidence AS MATERIALIZED (
    SELECT
      registry.source_id,
      registry.registry_slug,
      registry.filter_source,
      registry.source_currency,
      attempt.latest_attempt_id,
      attempt.latest_attempt_scraped_at,
      attempt.latest_attempt_passed,
      attempt.actual_count,
      entry_count.entry_count,
      entry_count.compatible_entry_count,
      run.source_run_id,
      run.acquisition_state,
      run.population_state,
      run.fetched_population,
      run.completed_at AS acquisition_completed_at,
      COALESCE(eligible.eligible_count, 0::bigint) AS eligible_count,
      COALESCE(eligible.returned_count, 0::bigint) AS returned_count,
      COALESCE(contracts.source_contract_versions, ARRAY[]::text[])
        AS source_contract_versions,
      COALESCE(contracts.metric_set_ids, ARRAY[]::text[])
        AS metric_set_ids,
      COALESCE(any_contract.available_currencies, ARRAY[]::text[])
        AS contract_currencies,
      CASE
        WHEN registry.source_currency <> 'USDT' THEN 'comparison_currency_mismatch'
        WHEN coverage.source_id IS NULL
             AND any_contract.source_id IS NOT NULL
          THEN 'ranking_contract_currency_mismatch'
        WHEN coverage.source_id IS NULL THEN 'ranking_contract_missing'
        WHEN attempt.latest_attempt_id IS NULL THEN 'snapshot_missing'
        WHEN attempt.latest_attempt_scraped_at
             > pg_catalog.statement_timestamp() + interval '5 minutes'
          THEN 'snapshot_future'
        WHEN attempt.latest_attempt_scraped_at
             <= pg_catalog.statement_timestamp()
                - pg_catalog.make_interval(hours => p_max_age_hours)
          THEN 'snapshot_stale'
        WHEN NOT attempt.latest_attempt_passed THEN 'snapshot_partial'
        WHEN entry_count.entry_count IS DISTINCT FROM attempt.actual_count::bigint
          OR entry_count.compatible_entry_count
             IS DISTINCT FROM attempt.actual_count::bigint
          THEN 'population_count_mismatch'
        WHEN run.source_run_id IS NULL THEN 'trust_run_missing'
        WHEN run.completed_at
             > pg_catalog.statement_timestamp() + interval '5 minutes'
          THEN 'trust_run_future'
        WHEN run.acquisition_state = 'partial' THEN 'acquisition_partial'
        WHEN run.acquisition_state = 'unknown' THEN 'acquisition_unknown'
        WHEN run.population_state = 'partial' THEN 'population_partial'
        WHEN run.population_state = 'unknown' THEN 'population_unknown'
        WHEN COALESCE(eligible.eligible_count, 0) = 0
             AND attempt.actual_count = 0
             AND run.fetched_population = 0 THEN 'verified_empty'
        WHEN COALESCE(eligible.eligible_count, 0) = 0 THEN 'metrics_unrankable'
        ELSE 'rankable'
      END AS evidence_state,
      CASE
        WHEN registry.source_currency <> 'USDT'
          OR coverage.source_id IS NULL
          OR attempt.latest_attempt_id IS NULL
          OR attempt.latest_attempt_scraped_at
             > pg_catalog.statement_timestamp() + interval '5 minutes'
          OR run.completed_at
             > pg_catalog.statement_timestamp() + interval '5 minutes'
          OR (
            attempt.latest_attempt_passed
            AND entry_count.entry_count IS NOT DISTINCT FROM attempt.actual_count::bigint
            AND entry_count.compatible_entry_count
                IS NOT DISTINCT FROM attempt.actual_count::bigint
            AND run.source_run_id IS NULL
          ) THEN false
        ELSE true
      END AS withdrawal_allowed,
      CASE
        WHEN registry.source_currency = 'USDT'
         AND coverage.source_id IS NOT NULL
         AND attempt.latest_attempt_passed
         AND attempt.latest_attempt_scraped_at
             > pg_catalog.statement_timestamp()
                - pg_catalog.make_interval(hours => p_max_age_hours)
         AND attempt.latest_attempt_scraped_at
             <= pg_catalog.statement_timestamp() + interval '5 minutes'
         AND entry_count.entry_count IS NOT DISTINCT FROM attempt.actual_count::bigint
         AND entry_count.compatible_entry_count
             IS NOT DISTINCT FROM attempt.actual_count::bigint
         AND run.source_run_id IS NOT NULL
         AND run.completed_at
             <= pg_catalog.statement_timestamp() + interval '5 minutes'
         AND run.acquisition_state = 'complete'
         AND run.population_state = 'verified'
          THEN true
        ELSE false
      END AS rows_authoritative
    FROM registry_cohorts AS registry
    LEFT JOIN any_pair_contract_coverage AS any_contract
      ON any_contract.source_id = registry.source_id
    LEFT JOIN method_contract_coverage AS coverage
      ON coverage.source_id = registry.source_id
    LEFT JOIN latest_attempt AS attempt
      ON attempt.source_id = registry.source_id
    LEFT JOIN attempt_entry_counts AS entry_count
      ON entry_count.latest_attempt_id = attempt.latest_attempt_id
    LEFT JOIN exact_runs AS run
      ON run.source_id = registry.source_id
    LEFT JOIN run_contracts AS contracts
      ON contracts.source_id = run.source_id
     AND contracts.source_run_id = run.source_run_id
    LEFT JOIN eligible_counts AS eligible
      ON eligible.source_id = registry.source_id
  ), score_rows AS MATERIALIZED (
    SELECT COALESCE(
      pg_catalog.jsonb_agg(
        payload_row
        ORDER BY payload_row.platform, payload_row.board_rank, payload_row.trader_key
      ),
      '[]'::pg_catalog.jsonb
    ) AS payload
    FROM (
      SELECT score_input.*
      FROM arena.metric_rankable_score_inputs_shadow AS score_input
      JOIN cohort_evidence AS cohort
        ON cohort.source_id = score_input.source_id
       AND cohort.rows_authoritative
      WHERE score_input."window" = p_window
        AND score_input.board_rank <= p_per_platform_limit
        AND score_input.board_as_of > pg_catalog.statement_timestamp()
          - pg_catalog.make_interval(hours => p_max_age_hours)
    ) AS payload_row
  ), cohorts AS MATERIALIZED (
    SELECT COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'source_id', evidence.source_id,
          'registry_slug', evidence.registry_slug,
          'filter_source', evidence.filter_source,
          'window', p_window,
          'comparison_currency', 'USDT',
          'source_currency', evidence.source_currency,
          'latest_attempt_id', evidence.latest_attempt_id,
          'latest_attempt_scraped_at', evidence.latest_attempt_scraped_at,
          'latest_attempt_passed', evidence.latest_attempt_passed,
          'actual_count', evidence.actual_count,
          'entry_count', evidence.entry_count,
          'compatible_entry_count', evidence.compatible_entry_count,
          'source_run_id', evidence.source_run_id,
          'acquisition_state', evidence.acquisition_state,
          'population_state', evidence.population_state,
          'fetched_population', evidence.fetched_population,
          'acquisition_completed_at', evidence.acquisition_completed_at,
          'eligible_count', evidence.eligible_count,
          'returned_count', evidence.returned_count,
          'rank_depth', p_per_platform_limit,
          'source_contract_versions', evidence.source_contract_versions,
          'metric_set_ids', evidence.metric_set_ids,
          'contract_currencies', evidence.contract_currencies,
          'evidence_state', evidence.evidence_state,
          'reason', evidence.evidence_state,
          'rows_authoritative', evidence.rows_authoritative,
          'withdrawal_allowed', evidence.withdrawal_allowed,
          'action_advisory', true,
          'publication_action', CASE
            WHEN evidence.rows_authoritative AND evidence.returned_count > 0
              THEN 'publish'
            WHEN evidence.withdrawal_allowed THEN 'withdraw'
            ELSE 'hold'
          END
        )
        ORDER BY evidence.registry_slug
      ),
      '[]'::pg_catalog.jsonb
    ) AS payload
    FROM cohort_evidence AS evidence
  )
  SELECT pg_catalog.jsonb_build_object(
    'schemaVersion', 'metric-rankable-score-inputs-shadow@1',
    'authorityScope', 'persisted_leaderboard_snapshot_attempts',
    'enforcementMode', 'shadow',
    'actionsAdvisory', true,
    'window', p_window,
    'rankDepth', p_per_platform_limit,
    'rankingMethodId', v_ranking_method_id,
    'comparisonCurrency', 'USDT',
    'scoreRows', score_rows.payload,
    'cohorts', cohorts.payload
  )
  FROM score_rows
  CROSS JOIN cohorts
  );
END;
$function$;

REVOKE ALL ON arena.metric_rankable_score_inputs_shadow
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON arena.metric_rankable_score_inputs_shadow TO service_role;

REVOKE ALL
  ON FUNCTION public.arena_metric_rankable_score_inputs_shadow_json(text, int, int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE
  ON FUNCTION public.arena_metric_rankable_score_inputs_shadow_json(text, int, int)
  TO service_role;

DO $postflight$
BEGIN
  IF NOT pg_catalog.has_table_privilege(
    'service_role', 'arena.metric_rankable_score_inputs_shadow', 'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'anon', 'arena.metric_rankable_score_inputs_shadow', 'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'authenticated', 'arena.metric_rankable_score_inputs_shadow', 'SELECT'
  ) THEN
    RAISE EXCEPTION 'metric rankable score-input view privileges drifted';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.arena_metric_rankable_score_inputs_shadow_json(text,integer,integer)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    'public.arena_metric_rankable_score_inputs_shadow_json(text,integer,integer)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    'public.arena_metric_rankable_score_inputs_shadow_json(text,integer,integer)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'metric rankable score-input RPC privileges drifted';
  END IF;
END
$postflight$;

COMMENT ON VIEW arena.metric_rankable_score_inputs_shadow IS
  'Latest persisted leaderboard snapshot attempt only; complete USDT ROI+PnL trust pairs projected for score canaries. Not a live cutover.';
COMMENT ON FUNCTION public.arena_metric_rankable_score_inputs_shadow_json(text, int, int) IS
  'Service-only metric-trust score-input canary with registry-complete persisted-snapshot cohort states; pre-snapshot attempt failures require a separate ledger.';

NOTIFY pgrst, 'reload schema';

COMMIT;
