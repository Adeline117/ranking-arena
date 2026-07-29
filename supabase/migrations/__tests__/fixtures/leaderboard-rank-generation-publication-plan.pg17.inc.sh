#!/usr/bin/env bash

# Sourced only by leaderboard-rank-generation-atomic-writer.pg17.sh. It keeps
# the production migration proof on the same real dependency chain while
# supplying the smallest database-backed bundle needed for source planning.

install_publication_plan_fixture() {
  local include_extra_score_identity=false
  if [[ "$PUBLICATION_PLAN_MANIFEST_MUTATION" == 'omit-identity' ]]; then
    include_extra_score_identity=true
  fi

  psql_cmd -q \
    -v include_extra_score_identity="$include_extra_score_identity" <<'SQL'
INSERT INTO arena.sources (
  registry_slug,
  filter_source,
  exchange_name,
  season_id
) VALUES
  ('delta', 'delta', 'Delta', '90D'),
  ('gamma', 'gamma', 'Gamma', '90D');

-- The shared atomic-writer foundation exposes only the serving-registry
-- columns used by earlier migrations. Add the production identity columns
-- and physical board relations needed by the trust projection proof.
ALTER TABLE arena.sources
  ADD COLUMN id smallint,
  ADD COLUMN slug text,
  ADD COLUMN meta jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE arena.sources
SET id = CASE registry_slug
      WHEN 'alpha' THEN 1::smallint
      WHEN 'beta' THEN 2::smallint
      WHEN 'delta' THEN 3::smallint
      WHEN 'gamma' THEN 4::smallint
    END,
    slug = registry_slug;

ALTER TABLE arena.sources
  ALTER COLUMN id SET NOT NULL,
  ALTER COLUMN slug SET NOT NULL,
  ADD CONSTRAINT fixture_sources_id_key UNIQUE (id),
  ADD CONSTRAINT fixture_sources_slug_key UNIQUE (slug);

CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL,
  exchange_trader_id text NOT NULL,
  UNIQUE (source_id, exchange_trader_id)
);

CREATE TABLE arena.leaderboard_snapshots (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL,
  timeframe smallint NOT NULL,
  scraped_at timestamptz NOT NULL,
  count_check_passed boolean NOT NULL
);

CREATE TABLE arena.leaderboard_entries (
  scraped_at timestamptz NOT NULL,
  snapshot_id bigint NOT NULL,
  trader_id bigint NOT NULL,
  timeframe smallint NOT NULL,
  rank integer NOT NULL,
  PRIMARY KEY (scraped_at, snapshot_id, trader_id)
);

CREATE TABLE arena.fixture_publication_plan_bundle_state (
  source_as_of timestamptz NOT NULL,
  include_extra_score_identity boolean NOT NULL DEFAULT false
);

INSERT INTO arena.fixture_publication_plan_bundle_state (
  source_as_of,
  include_extra_score_identity
)
VALUES (
  pg_catalog.clock_timestamp() - interval '1 minute',
  :'include_extra_score_identity'::boolean
);

INSERT INTO arena.leaderboard_snapshots (
  id, source_id, timeframe, scraped_at, count_check_passed
)
SELECT 101, 1, 90, state.source_as_of, true
FROM arena.fixture_publication_plan_bundle_state AS state
UNION ALL
SELECT 102, 2, 90, state.source_as_of, true
FROM arena.fixture_publication_plan_bundle_state AS state;

INSERT INTO arena.traders (id, source_id, exchange_trader_id)
SELECT
  rows.ordinal_position::bigint,
  CASE WHEN rows.ordinal_position <= 1000 THEN 1 ELSE 2 END::smallint,
  'trader-' || pg_catalog.lpad(rows.ordinal_position::text, 6, '0')
FROM arena.fixture_publication_plan_bundle_state AS state
CROSS JOIN LATERAL pg_catalog.generate_series(
  1,
  CASE WHEN state.include_extra_score_identity THEN 1002 ELSE 1001 END
) AS rows(ordinal_position);

INSERT INTO arena.leaderboard_entries (
  scraped_at, snapshot_id, trader_id, timeframe, rank
)
SELECT
  state.source_as_of,
  CASE WHEN rows.ordinal_position <= 1000 THEN 101 ELSE 102 END,
  rows.ordinal_position,
  90,
  CASE WHEN rows.ordinal_position <= 1000
    THEN rows.ordinal_position
    ELSE rows.ordinal_position - 1000
  END
FROM arena.fixture_publication_plan_bundle_state AS state
CROSS JOIN LATERAL pg_catalog.generate_series(
  1,
  CASE WHEN state.include_extra_score_identity THEN 1002 ELSE 1001 END
) AS rows(ordinal_position);

-- The publication plan must rebuild scorer inputs from the private metric-
-- trust projection, not trust numeric fields supplied by the bundle RPC. Keep
-- these fixture relations column-compatible with the production views so the
-- real owner-only projection helper is exercised unchanged.
CREATE TABLE arena.metric_rankable_score_inputs_shadow (
  source_id smallint NOT NULL,
  trader_id bigint NOT NULL,
  snapshot_id bigint NOT NULL,
  source_run_id text NOT NULL,
  source_contract_version text NOT NULL,
  metric_set_id text NOT NULL,
  roi_observation_id bigint NOT NULL,
  pnl_observation_id bigint NOT NULL,
  roi_provenance text NOT NULL,
  roi_methodology_version text NOT NULL,
  pnl_provenance text NOT NULL,
  pnl_methodology_version text NOT NULL,
  ranking_method_id text NOT NULL,
  comparison_currency text NOT NULL,
  platform text NOT NULL,
  product_type text NOT NULL,
  market_type text NOT NULL,
  trader_key text NOT NULL,
  "window" text NOT NULL,
  board_rank integer NOT NULL,
  roi_pct numeric NOT NULL,
  pnl_usd numeric NOT NULL,
  win_rate numeric,
  max_drawdown numeric,
  copiers numeric,
  trades_count numeric,
  sharpe_ratio numeric,
  sortino_ratio numeric,
  calmar_ratio numeric,
  volatility_pct numeric,
  trader_kind text,
  handle text,
  avatar_url text,
  currency text NOT NULL,
  as_of timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  board_as_of timestamptz NOT NULL,
  acquisition_completed_at timestamptz NOT NULL,
  rank_eligible boolean NOT NULL
);

CREATE TABLE arena.metric_rankable_observations (
  id bigint PRIMARY KEY,
  contract_id bigint NOT NULL,
  trader_id bigint NOT NULL,
  source_id smallint NOT NULL,
  snapshot_id bigint NOT NULL,
  snapshot_scraped_at timestamptz NOT NULL,
  source_run_id text NOT NULL,
  source_contract_version text NOT NULL,
  timeframe smallint NOT NULL,
  metric text NOT NULL,
  field_path text NOT NULL,
  provenance text NOT NULL,
  methodology_version text NOT NULL,
  value numeric NOT NULL,
  value_unit text NOT NULL,
  currency text NOT NULL,
  source_as_of timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  quality text NOT NULL,
  history_state text NOT NULL,
  price_state text NOT NULL,
  cost_basis_state text NOT NULL,
  population_state text NOT NULL,
  window_state text NOT NULL,
  unit_state text NOT NULL,
  freshness_state text NOT NULL,
  blocking_reasons jsonb NOT NULL,
  evaluator_version text NOT NULL,
  recorded_at timestamptz NOT NULL,
  metric_set_id text NOT NULL
);

WITH state AS MATERIALIZED (
  SELECT
    fixture.source_as_of,
    fixture.include_extra_score_identity
  FROM arena.fixture_publication_plan_bundle_state AS fixture
), generated AS MATERIALIZED (
  SELECT
    rows.ordinal_position::bigint AS trader_id,
    CASE WHEN rows.ordinal_position <= 1000 THEN 1 ELSE 2 END::smallint
      AS source_id,
    CASE WHEN rows.ordinal_position <= 1000 THEN 101 ELSE 102 END::bigint
      AS snapshot_id,
    CASE WHEN rows.ordinal_position <= 1000 THEN 'alpha' ELSE 'beta' END
      AS platform,
    CASE WHEN rows.ordinal_position <= 1000
      THEN rows.ordinal_position
      ELSE rows.ordinal_position - 1000
    END::integer AS board_rank,
    'trader-' || pg_catalog.lpad(rows.ordinal_position::text, 6, '0')
      AS trader_key,
    CASE WHEN rows.ordinal_position <= 1000
      THEN pg_catalog.repeat('a', 64)
      ELSE pg_catalog.repeat('b', 64)
    END AS source_run_id,
    CASE WHEN rows.ordinal_position <= 1000
      THEN 'fixture-alpha-trust@1'
      ELSE 'fixture-beta-trust@1'
    END AS source_contract_version,
    CASE WHEN rows.ordinal_position <= 1000
      THEN 'fixture-alpha-90d-usdt@1'
      ELSE 'fixture-beta-90d-usdt@1'
    END AS metric_set_id,
    state.source_as_of
  FROM state
  CROSS JOIN LATERAL pg_catalog.generate_series(
    1,
    CASE WHEN state.include_extra_score_identity THEN 1002 ELSE 1001 END
  ) AS rows(ordinal_position)
)
INSERT INTO arena.metric_rankable_score_inputs_shadow (
  source_id,
  trader_id,
  snapshot_id,
  source_run_id,
  source_contract_version,
  metric_set_id,
  roi_observation_id,
  pnl_observation_id,
  roi_provenance,
  roi_methodology_version,
  pnl_provenance,
  pnl_methodology_version,
  ranking_method_id,
  comparison_currency,
  platform,
  product_type,
  market_type,
  trader_key,
  "window",
  board_rank,
  roi_pct,
  pnl_usd,
  win_rate,
  max_drawdown,
  copiers,
  trades_count,
  sharpe_ratio,
  sortino_ratio,
  calmar_ratio,
  volatility_pct,
  trader_kind,
  handle,
  avatar_url,
  currency,
  as_of,
  valid_until,
  window_start,
  window_end,
  board_as_of,
  acquisition_completed_at,
  rank_eligible
)
SELECT
  generated.source_id,
  generated.trader_id,
  generated.snapshot_id,
  generated.source_run_id,
  generated.source_contract_version,
  generated.metric_set_id,
  generated.trader_id * 10 + 1,
  generated.trader_id * 10 + 2,
  'source_reported',
  'fixture-source-reported@1',
  'source_reported',
  'fixture-source-reported@1',
  'arena-core-roi-pnl-90d-usdt@1',
  'USDT',
  generated.platform,
  'futures',
  'futures',
  generated.trader_key,
  '90D',
  generated.board_rank,
  30,
  12000,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  'lead_trader',
  'fixture-' || generated.trader_key,
  'https://example.invalid/' || generated.trader_key || '.png',
  'USDT',
  generated.source_as_of,
  generated.source_as_of + interval '2 hours',
  generated.source_as_of - interval '90 days',
  generated.source_as_of,
  generated.source_as_of,
  generated.source_as_of + interval '1 minute',
  true
FROM generated;

WITH state AS MATERIALIZED (
  SELECT
    fixture.source_as_of,
    fixture.include_extra_score_identity
  FROM arena.fixture_publication_plan_bundle_state AS fixture
), generated AS MATERIALIZED (
  SELECT
    rows.ordinal_position::bigint AS trader_id,
    CASE WHEN rows.ordinal_position <= 1000 THEN 1 ELSE 2 END::smallint
      AS source_id,
    CASE WHEN rows.ordinal_position <= 1000 THEN 101 ELSE 102 END::bigint
      AS snapshot_id,
    CASE WHEN rows.ordinal_position <= 1000
      THEN pg_catalog.repeat('a', 64)
      ELSE pg_catalog.repeat('b', 64)
    END AS source_run_id,
    CASE WHEN rows.ordinal_position <= 1000
      THEN 'fixture-alpha-trust@1'
      ELSE 'fixture-beta-trust@1'
    END AS source_contract_version,
    CASE WHEN rows.ordinal_position <= 1000
      THEN 'fixture-alpha-90d-usdt@1'
      ELSE 'fixture-beta-90d-usdt@1'
    END AS metric_set_id,
    state.source_as_of
  FROM state
  CROSS JOIN LATERAL pg_catalog.generate_series(
    1,
    CASE WHEN state.include_extra_score_identity THEN 1002 ELSE 1001 END
  ) AS rows(ordinal_position)
)
INSERT INTO arena.metric_rankable_observations (
  id,
  contract_id,
  trader_id,
  source_id,
  snapshot_id,
  snapshot_scraped_at,
  source_run_id,
  source_contract_version,
  timeframe,
  metric,
  field_path,
  provenance,
  methodology_version,
  value,
  value_unit,
  currency,
  source_as_of,
  valid_until,
  window_start,
  window_end,
  quality,
  history_state,
  price_state,
  cost_basis_state,
  population_state,
  window_state,
  unit_state,
  freshness_state,
  blocking_reasons,
  evaluator_version,
  recorded_at,
  metric_set_id
)
SELECT
  generated.trader_id * 10 + metric.observation_offset,
  generated.source_id::bigint * 10 + metric.observation_offset,
  generated.trader_id,
  generated.source_id,
  generated.snapshot_id,
  generated.source_as_of,
  generated.source_run_id,
  generated.source_contract_version,
  90,
  metric.name,
  metric.field_path,
  'source_reported',
  'fixture-source-reported@1',
  metric.value,
  'percent',
  'USDT',
  generated.source_as_of,
  generated.source_as_of + interval '2 hours',
  generated.source_as_of - interval '90 days',
  generated.source_as_of,
  'complete',
  'source_owned',
  'source_owned',
  'source_owned',
  'verified',
  'verified',
  'verified',
  'verified',
  '[]'::jsonb,
  'metric-trust@1',
  generated.source_as_of + interval '1 minute',
  generated.metric_set_id
FROM generated
CROSS JOIN LATERAL (
  VALUES
    (3::bigint, 'win_rate'::text, '$.win_rate'::text, 66::numeric),
    (4::bigint, 'mdd'::text, '$.max_drawdown'::text, 8::numeric)
) AS metric(observation_offset, name, field_path, value);

CREATE FUNCTION public.arena_score_inputs_publish_bundle_json(
  p_window text,
  p_rank_limit integer,
  p_max_age_hours integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH state AS MATERIALIZED (
    SELECT
      fixture.source_as_of,
      fixture.include_extra_score_identity
    FROM arena.fixture_publication_plan_bundle_state AS fixture
  ), physical_boards AS MATERIALIZED (
    SELECT pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'registry_slug', source.registry_slug,
        'filter_source', source.filter_source,
        'window', p_window,
        'snapshot_id', CASE source.filter_source
          WHEN 'alpha' THEN pg_catalog.to_jsonb(101::bigint)
          WHEN 'beta' THEN pg_catalog.to_jsonb(102::bigint)
          WHEN 'gamma' THEN pg_catalog.to_jsonb(103::bigint)
          ELSE 'null'::jsonb
        END,
        'scraped_at', CASE
          WHEN source.filter_source IN ('alpha', 'beta')
            THEN pg_catalog.to_jsonb(pg_catalog.to_char(
              state.source_as_of AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ))
          WHEN source.filter_source = 'gamma'
            THEN pg_catalog.to_jsonb(pg_catalog.to_char(
              state.source_as_of AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ))
          ELSE 'null'::jsonb
        END,
        'actual_count', CASE source.filter_source
          WHEN 'alpha' THEN 1000
          WHEN 'beta' THEN CASE
            WHEN state.include_extra_score_identity THEN 2
            ELSE 1
          END
          WHEN 'gamma' THEN 1
          ELSE 0
        END,
        'entry_count', CASE source.filter_source
          WHEN 'alpha' THEN 1000
          WHEN 'beta' THEN CASE
            WHEN state.include_extra_score_identity THEN 2
            ELSE 1
          END
          WHEN 'gamma' THEN 1
          ELSE 0
        END,
        'rank_limit', p_rank_limit,
        'rank_limited_entry_count', CASE source.filter_source
          WHEN 'alpha' THEN 1000
          WHEN 'beta' THEN CASE
            WHEN state.include_extra_score_identity THEN 2
            ELSE 1
          END
          WHEN 'gamma' THEN 1
          ELSE 0
        END,
        'latest_passed_tie_count', CASE
          WHEN source.filter_source IN ('alpha', 'beta', 'gamma') THEN 1
          ELSE 0
        END,
        'evidence_status', CASE source.filter_source
          WHEN 'alpha' THEN 'passed'
          WHEN 'beta' THEN 'passed'
          WHEN 'gamma' THEN 'latest_attempt_failed'
          ELSE 'missing'
        END,
        'latest_attempt_id', CASE source.filter_source
          WHEN 'alpha' THEN pg_catalog.to_jsonb(101::bigint)
          WHEN 'beta' THEN pg_catalog.to_jsonb(102::bigint)
          WHEN 'gamma' THEN pg_catalog.to_jsonb(104::bigint)
          ELSE 'null'::jsonb
        END,
        'latest_attempt_scraped_at', CASE
          WHEN source.filter_source = 'delta' THEN 'null'::jsonb
          ELSE pg_catalog.to_jsonb(pg_catalog.to_char(
            state.source_as_of AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ))
        END,
        'latest_attempt_passed', CASE
          WHEN source.filter_source IN ('alpha', 'beta') THEN 'true'::jsonb
          WHEN source.filter_source = 'gamma' THEN 'false'::jsonb
          ELSE 'null'::jsonb
        END
      ) ORDER BY source.registry_slug COLLATE pg_catalog."C"
    ) AS value
    FROM arena.sources AS source
    CROSS JOIN state
    WHERE source.season_id = p_window
      AND source.is_serving
  ), score_rows AS MATERIALIZED (
    SELECT pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'platform', generated.source,
        'trader_key', generated.source_trader_id,
        'board_rank', CASE
          WHEN generated.source = 'alpha' THEN generated.ordinal_position
          WHEN generated.source = 'beta' THEN generated.ordinal_position - 1000
          ELSE 1
        END,
        'roi_pct', 30,
        'pnl_usd', 12000,
        'win_rate', 66,
        'max_drawdown', 8,
        'sharpe_ratio', 2.2,
        'trades_count', 140
      ) ORDER BY generated.ordinal_position
    ) AS value
    FROM (
      SELECT
        ordinal_position,
        CASE WHEN ordinal_position <= 1000 THEN 'alpha' ELSE 'beta' END
          AS source,
        'trader-' || pg_catalog.lpad(ordinal_position::text, 6, '0')
          AS source_trader_id
      FROM state
      CROSS JOIN LATERAL pg_catalog.generate_series(
        1,
        CASE WHEN state.include_extra_score_identity THEN 1002 ELSE 1001 END
      ) AS rows(ordinal_position)
      UNION ALL
      SELECT
        2001 AS ordinal_position,
        'gamma' AS source,
        'gamma-trader-001' AS source_trader_id
      FROM state
    ) AS generated
  )
  SELECT pg_catalog.jsonb_build_object(
    'contract', 'fixture-publication-score-bundle@1',
    'window', p_window,
    'rankLimit', p_rank_limit,
    'maxAgeHours', p_max_age_hours,
    'physicalBoards', physical_boards.value,
    'scoreRows', score_rows.value
  )
  FROM physical_boards
  CROSS JOIN score_rows
$function$;
SQL
}

seed_trusted_publication_plan_fixture() {
  if [[ "$PUBLICATION_PLAN_RETAIN_MODE" == 'legacy' ]]; then
    return
  fi

  # A full first-generation promotion would duplicate the entire writer and
  # finalizer harness. Instead, seed one already-sealed predecessor through
  # the real manifest sealer, claim RPC, FKs, source insert guard, production
  # field-commitment helper, and deferred plan-completeness trigger. The live
  # generation is then claimed normally as generation two.
  psql_cmd -q \
    -v retain_mode="$PUBLICATION_PLAN_RETAIN_MODE" <<'SQL'
SELECT pg_catalog.set_config(
  'arena.fixture_trusted_prior_retain_mode',
  :'retain_mode',
  false
);

CREATE TABLE arena.fixture_trusted_prior_plan (
  retain_mode text NOT NULL,
  score_cohort_id uuid NOT NULL,
  score_input_manifest_id uuid NOT NULL,
  score_input_manifest_digest text NOT NULL,
  source_as_of timestamptz NOT NULL,
  metric_input_count integer NOT NULL,
  metric_evidence_valid_until timestamptz NOT NULL,
  metric_evidence_sha256 text NOT NULL,
  target_identity_sha256 text NOT NULL,
  target_payload_sha256 text NOT NULL
);

DO $trusted_prior_plan$
DECLARE
  v_retain_mode text := pg_catalog.current_setting(
    'arena.fixture_trusted_prior_retain_mode'
  );
  v_prior_cohort constant uuid :=
    '27500000-0000-4750-8750-000000000001'::uuid;
  v_manifest_valid_until timestamptz :=
    pg_catalog.clock_timestamp() + interval '4 hours';
  v_metric_valid_until timestamptz;
  v_source_as_of timestamptz :=
    pg_catalog.clock_timestamp() - interval '10 minutes';
  v_planned_at timestamptz := pg_catalog.clock_timestamp();
  v_seal jsonb;
  v_claim jsonb;
  v_manifest_id uuid;
  v_manifest_digest text;
  v_source_evidence jsonb := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'contract', 'fixture-trusted-prior-source@1',
      'source', 'gamma',
      'snapshotId', 103
    )
  );
  v_source_evidence_sha256 text;
  v_identity_sha256 text;
  v_field_commitment text;
  v_field_chunk_sha256 text;
  v_payload_sha256 text;
  v_metric_evidence_sha256 text;
  v_manifest_attestation_sha256 text;
  v_authority_sha256 text;
  v_plan_sources jsonb;
  v_plan_sha256 text;
BEGIN
  IF v_retain_mode NOT IN ('trusted', 'expired') THEN
    RAISE EXCEPTION 'invalid trusted-prior retain mode: %', v_retain_mode;
  END IF;
  v_metric_valid_until := CASE v_retain_mode
    WHEN 'trusted' THEN pg_catalog.clock_timestamp() + interval '2 hours'
    ELSE pg_catalog.clock_timestamp() + interval '1 minute'
  END;
  v_metric_evidence_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        'fixture-source-metric-evidence@1',
        'gamma',
        1,
        pg_catalog.to_char(
          v_metric_valid_until AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )
      )::text,
      'UTF8'
    )),
    'hex'
  );

  v_seal := arena.seal_leaderboard_score_input_manifest_v1(
    '90D',
    pg_catalog.repeat('1', 64),
    pg_catalog.repeat('2', 64),
    pg_catalog.repeat('3', 64),
    pg_catalog.jsonb_build_object(
      'contract', 'fixture-trusted-prior-bundle@1',
      'source', 'gamma'
    ),
    'leaderboard-score-metric-trust-core-projection@1',
    pg_catalog.jsonb_build_object(
      'forcedUnknownInputs', pg_catalog.jsonb_build_array(
        'sharpe_ratio', 'profit_factor', 'trades_count'
      )
    ),
    'leaderboard-score-trusted-roi-pnl-win-mdd-usdt@1',
    pg_catalog.jsonb_build_object(
      'rankingMethodId', 'arena-v4-roi-pnl-win-mdd-90d-usdt@1',
      'comparisonCurrency', 'USDT',
      'requiredMetrics', pg_catalog.jsonb_build_array(
        'roi', 'pnl', 'win_rate', 'mdd'
      ),
      'rankablePairCount', 1,
      'rankableObservationCount', 4,
      'sourceMetricAsOf', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_array(
          'gamma',
          pg_catalog.to_char(
            v_source_as_of AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          )
        )
      ),
      'sourceTrustEvidence', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_array(
          'gamma',
          1,
          pg_catalog.to_char(
            v_source_as_of AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ),
          pg_catalog.to_char(
            v_metric_valid_until AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ),
          v_metric_evidence_sha256
        )
      ),
      'validUntil', pg_catalog.to_char(
        v_metric_valid_until AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    ),
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'source', 'gamma',
      'source_trader_id', 'gamma-trader-001',
      'roi', 12,
      'pnl', 500,
      'max_drawdown', 10,
      'win_rate', 60,
      'sharpe_ratio', NULL::numeric,
      'profit_factor', NULL::numeric,
      'trades_count', NULL::integer
    )),
    v_manifest_valid_until
  );
  v_manifest_id := (v_seal->>'manifestId')::uuid;
  v_manifest_digest := v_seal->>'manifestDigest';

  v_claim := public.claim_leaderboard_rank_generation(
    '90D',
    v_prior_cohort,
    pg_catalog.repeat('4', 64),
    1,
    1,
    v_planned_at,
    300
  );
  IF (v_claim->>'generation_seq')::bigint IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'trusted prior fixture was not generation one: %',
      v_claim;
  END IF;

  INSERT INTO arena.leaderboard_rank_generation_manifest_bindings (
    contract,
    season_id,
    generation_seq,
    score_cohort_id,
    score_input_manifest_id,
    score_input_manifest_digest,
    bound_at
  ) VALUES (
    'leaderboard-rank-generation-manifest-binding@1',
    '90D',
    1,
    v_prior_cohort,
    v_manifest_id,
    v_manifest_digest,
    v_planned_at
  );

  v_source_evidence_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      v_source_evidence::text,
      'UTF8'
    )),
    'hex'
  );
  v_identity_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array('gamma-trader-001')::text,
      'UTF8'
    )),
    'hex'
  );
  v_field_commitment :=
    arena.build_leaderboard_rank_manifest_field_commitment_v1(
      'gamma',
      'gamma-trader-001',
      12,
      500,
      60,
      10,
      NULL,
      NULL,
      20,
      50,
      '{"roi":0.5,"pnl":0.5,"drawdown":0.5,"sharpe":0.5,"consistency":null}'::jsonb,
      50,
      50,
      NULL
    );
  v_field_chunk_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_array(
          'gamma-trader-001',
          v_field_commitment
        )
      )::text,
      'UTF8'
    )),
    'hex'
  );
  v_payload_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        'leaderboard-rank-generation-source-score-payload@1',
        '90D',
        'gamma',
        1,
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_array(0, 1, v_field_chunk_sha256)
        )
      )::text,
      'UTF8'
    )),
    'hex'
  );
  v_manifest_attestation_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        'fixture-prior-manifest-attestation@1',
        v_manifest_digest
      )::text,
      'UTF8'
    )),
    'hex'
  );
  v_authority_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        'fixture-prior-authority@1',
        '90D',
        pg_catalog.jsonb_build_array('gamma')
      )::text,
      'UTF8'
    )),
    'hex'
  );
  v_plan_sources := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_array(
      'gamma',
      'replace',
      pg_catalog.to_char(
        v_source_as_of AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      pg_catalog.jsonb_build_array('gamma'),
      pg_catalog.jsonb_build_array(103),
      v_source_evidence_sha256,
      1,
      v_identity_sha256,
      v_payload_sha256,
      1,
      pg_catalog.to_char(
        v_metric_valid_until AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      v_metric_evidence_sha256,
      NULL,
      NULL,
      NULL
    )
  );
  v_plan_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        'leaderboard-rank-generation-publication-plan@1',
        '90D',
        1,
        v_prior_cohort::text,
        v_manifest_id::text,
        v_manifest_digest,
        v_manifest_attestation_sha256,
        v_authority_sha256,
        v_plan_sources
      )::text,
      'UTF8'
    )),
    'hex'
  );

  INSERT INTO arena.leaderboard_rank_generation_publication_plans (
    contract,
    season_id,
    generation_seq,
    score_cohort_id,
    score_input_manifest_id,
    score_input_manifest_digest,
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
    '90D',
    1,
    v_prior_cohort,
    v_manifest_id,
    v_manifest_digest,
    v_manifest_attestation_sha256,
    v_authority_sha256,
    v_plan_sha256,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    v_planned_at,
    v_manifest_valid_until
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
    metric_evidence_sha256
  ) VALUES (
    'leaderboard-rank-generation-publication-plan-source@1',
    '90D',
    1,
    v_prior_cohort,
    'gamma',
    'replace',
    v_source_as_of,
    pg_catalog.jsonb_build_array('gamma'),
    pg_catalog.jsonb_build_array(103),
    v_source_evidence,
    v_source_evidence_sha256,
    1,
    v_identity_sha256,
    v_payload_sha256,
    1,
    v_metric_valid_until,
    v_metric_evidence_sha256
  );

  UPDATE ONLY arena.leaderboard_rank_generation_heads
  SET phase = 'failed',
      lease_expires_at = NULL,
      updated_at = pg_catalog.clock_timestamp()
  WHERE season_id = '90D'
    AND generation_seq = 1
    AND score_cohort_id = v_prior_cohort;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'trusted prior fixture did not terminate generation one';
  END IF;

  INSERT INTO arena.fixture_trusted_prior_plan (
    retain_mode,
    score_cohort_id,
    score_input_manifest_id,
    score_input_manifest_digest,
    source_as_of,
    metric_input_count,
    metric_evidence_valid_until,
    metric_evidence_sha256,
    target_identity_sha256,
    target_payload_sha256
  ) VALUES (
    v_retain_mode,
    v_prior_cohort,
    v_manifest_id,
    v_manifest_digest,
    v_source_as_of,
    1,
    v_metric_valid_until,
    v_metric_evidence_sha256,
    v_identity_sha256,
    v_payload_sha256
  );
END
$trusted_prior_plan$;
SQL
}

prove_publication_plan_install_rejects_preexisting_stage() {
  # Rollout cannot infer a same-transaction publication plan for an already
  # committed private graph. Seed an exact batch/row sentinel while constraint
  # triggers are suppressed, then prove the migration's explicit transaction
  # rolls back before leaving any publication-plan object behind.
  psql_cmd -q <<'SQL'
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO arena.leaderboard_rank_generation_stage_batches (
  contract,
  season_id,
  generation_seq,
  score_cohort_id,
  batch_index,
  score_input_manifest_id,
  score_input_manifest_digest,
  batch_sha256_plan,
  batch_sha256,
  row_count,
  source_count,
  first_source,
  first_source_trader_id,
  last_source,
  last_source_trader_id,
  staged_at
) VALUES (
  'leaderboard-rank-generation-stage-batch@1',
  '7D',
  9007199254739999,
  '07500000-0000-4750-8750-000000000001'::uuid,
  0,
  '07500000-0000-4750-8750-000000000002'::uuid,
  pg_catalog.repeat('7', 64),
  ARRAY[pg_catalog.repeat('8', 64)],
  pg_catalog.repeat('8', 64),
  1,
  1,
  'alpha',
  'preexisting-stage-sentinel',
  'alpha',
  'preexisting-stage-sentinel',
  '2026-07-29 00:00:00+00'::timestamptz
);

INSERT INTO arena.leaderboard_rank_generation_stage_rows (
  contract,
  season_id,
  generation_seq,
  score_cohort_id,
  batch_index,
  batch_position,
  source,
  source_trader_id,
  row_payload,
  staged_at
) VALUES (
  'leaderboard-rank-generation-stage-row@1',
  '7D',
  9007199254739999,
  '07500000-0000-4750-8750-000000000001'::uuid,
  0,
  1,
  'alpha',
  'preexisting-stage-sentinel',
  pg_catalog.jsonb_populate_record(
    NULL::arena.leaderboard_rank_batch_row_v1,
    pg_catalog.jsonb_build_object(
      'source', 'alpha',
      'source_trader_id', 'preexisting-stage-sentinel'
    )
  ),
  '2026-07-29 00:00:00+00'::timestamptz
);
COMMIT;
SQL

  local stage_before
  stage_before="$(psql_cmd -Atq <<'SQL'
SELECT pg_catalog.encode(
  pg_catalog.sha256(
    pg_catalog.convert_to(
      pg_catalog.jsonb_build_object(
        'batches', (
          SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(batch.*))
          FROM ONLY arena.leaderboard_rank_generation_stage_batches AS batch
        ),
        'rows', (
          SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(staged.*))
          FROM ONLY arena.leaderboard_rank_generation_stage_rows AS staged
        )
      )::text,
      'UTF8'
    )
  ),
  'hex'
);
SQL
)"

  if psql_cmd -q -f "$PUBLICATION_PLAN_MIGRATION" >"$ERROR_FILE" 2>&1; then
    echo 'publication-plan migration accepted a pre-existing private graph' >&2
    exit 1
  fi
  if ! rg -q 'publication-plan installation requires an empty private stage' \
      "$ERROR_FILE"; then
    echo 'publication-plan migration rejected pre-existing stage for an unexpected reason' >&2
    sed -n '1,360p' "$ERROR_FILE" >&2
    exit 1
  fi

  local stage_after
  stage_after="$(psql_cmd -Atq <<'SQL'
SELECT pg_catalog.encode(
  pg_catalog.sha256(
    pg_catalog.convert_to(
      pg_catalog.jsonb_build_object(
        'batches', (
          SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(batch.*))
          FROM ONLY arena.leaderboard_rank_generation_stage_batches AS batch
        ),
        'rows', (
          SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(staged.*))
          FROM ONLY arena.leaderboard_rank_generation_stage_rows AS staged
        )
      )::text,
      'UTF8'
    )
  ),
  'hex'
);
SQL
)"
  if [[ "$stage_after" != "$stage_before" ]]; then
    echo 'failed publication-plan installation changed the private stage' >&2
    exit 1
  fi

  local leaked_objects
  leaked_objects="$(psql_cmd -Atq <<'SQL'
SELECT pg_catalog.concat_ws(
  '|',
  (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'arena'
      AND relation.relname LIKE
        'leaderboard_rank_generation_publication_plan%'
  ),
  (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = function.pronamespace
    WHERE namespace.nspname = 'arena'
      AND function.proname IN (
        'guard_rank_generation_publication_plan_source_insert_v1',
        'seal_leaderboard_rank_generation_publication_plan_v1',
        'defer_rank_generation_publication_plan_checks_v1',
        'seal_rank_generation_publication_plan_from_batch_zero_v1',
        'validate_rank_generation_publication_plan_complete_v1'
      )
  ),
  (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger
    WHERE trigger.tgrelid =
            'arena.leaderboard_rank_generation_stage_batches'::regclass
      AND trigger.tgname IN (
        'rank_generation_stage_batches_defer_publication_plan',
        'leaderboard_rank_generation_stage_batches_publication_plan'
      )
      AND NOT trigger.tgisinternal
  )
);
SQL
)"
  if [[ "$leaked_objects" != '0|0|0' ]]; then
    echo "failed publication-plan installation leaked objects: $leaked_objects" >&2
    exit 1
  fi

  psql_cmd -q <<'SQL'
BEGIN;
SET LOCAL session_replication_role = replica;
DELETE FROM arena.leaderboard_rank_generation_stage_rows
WHERE season_id = '7D'
  AND generation_seq = 9007199254739999;
DELETE FROM arena.leaderboard_rank_generation_stage_batches
WHERE season_id = '7D'
  AND generation_seq = 9007199254739999;
COMMIT;
SQL
}

run_publication_plan_manifest_mutation_proof() {
  local fixture_shape
  fixture_shape="$(psql_cmd -Atq <<'SQL'
WITH current_bundle AS MATERIALIZED (
  SELECT public.arena_score_inputs_publish_bundle_json('90D', 1000, 48)
    AS value
), canonical_score_rows AS MATERIALIZED (
  SELECT pg_catalog.jsonb_agg(
    score_row.value
    ORDER BY
      (score_row.value->>'platform') COLLATE pg_catalog."C",
      (score_row.value->>'trader_key') COLLATE pg_catalog."C"
  ) AS value
  FROM current_bundle
  CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
    current_bundle.value->'scoreRows'
  ) AS score_row(value)
), stored AS MATERIALIZED (
  SELECT manifest.manifest
  FROM arena.fixture_atomic_writer_case AS fixture
  JOIN ONLY arena.leaderboard_score_input_manifests AS manifest
    ON manifest.manifest_id = fixture.score_input_manifest_id
)
SELECT pg_catalog.concat_ws(
  '|',
  pg_catalog.jsonb_array_length(stored.manifest->'inputs'),
  pg_catalog.jsonb_array_length(current_bundle.value->'scoreRows'),
  (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.jsonb_array_elements(stored.manifest->'inputs')
      AS input(value)
    WHERE pg_catalog.jsonb_typeof(input.value->'profit_factor') <> 'null'
  ),
  stored.manifest->'source'->>'scoreRowsDigest' = pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      canonical_score_rows.value::text,
      'UTF8'
    )),
    'hex'
  ),
  stored.manifest->'source'->>'physicalBoardsDigest' = pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      (current_bundle.value->'physicalBoards')::text,
      'UTF8'
    )),
    'hex'
  ),
  stored.manifest->'source'->>'sourceBundleDigest' = pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        'leaderboard-score-publish-bundle@1',
        '90D',
        1000,
        48,
        canonical_score_rows.value,
        current_bundle.value->'physicalBoards'
      )::text,
      'UTF8'
    )),
    'hex'
  )
)
FROM stored
CROSS JOIN current_bundle
CROSS JOIN canonical_score_rows;
SQL
)"

  case "$PUBLICATION_PLAN_MANIFEST_MUTATION" in
    omit-identity)
      if [[ "$fixture_shape" != '1001|1003|0|t|t|t' ]]; then
        echo "omitted-identity publication fixture drifted: $fixture_shape" >&2
        exit 1
      fi
      ;;
    profit-factor)
      if [[ "$fixture_shape" != '1001|1002|1001|t|t|t' ]]; then
        echo "forged-profit-factor publication fixture drifted: $fixture_shape" >&2
        exit 1
      fi
      ;;
    *)
      echo "unexpected publication manifest mutation: $PUBLICATION_PLAN_MANIFEST_MUTATION" >&2
      exit 1
      ;;
  esac

  local serving_before
  serving_before="$(psql_cmd -Atq <<'SQL'
SELECT pg_catalog.encode(
  pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'ranks', COALESCE((
        SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(rank_row.*)
          ORDER BY rank_row.season_id, rank_row.source,
                   rank_row.source_trader_id)
        FROM public.leaderboard_ranks AS rank_row
      ), '[]'::jsonb),
      'fences', COALESCE((
        SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(fence.*)
          ORDER BY fence.season_id, fence.source)
        FROM ONLY arena.leaderboard_rank_mutation_fences AS fence
      ), '[]'::jsonb),
      'freshness', COALESCE((
        SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(freshness.*)
          ORDER BY freshness.season_id, freshness.source)
        FROM ONLY public.leaderboard_source_freshness AS freshness
      ), '[]'::jsonb),
      'publications', COALESCE((
        SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(publication.*)
          ORDER BY publication.id)
        FROM ONLY arena.leaderboard_rank_publications AS publication
      ), '[]'::jsonb)
    )::text,
    'UTF8'
  )), 'hex');
SQL
)"

  expect_failure \
    "$PUBLICATION_PLAN_MANIFEST_MUTATION manifest escaped exact DB projection" \
    'publication manifest is not the exact current canonical scorer population' \
    "BEGIN;
     SELECT arena.write_leaderboard_rank_generation_batch_v1(
       fixture.season_id,
       fixture.generation_seq,
       fixture.score_cohort_id,
       0,
       fixture.score_input_manifest_id,
       fixture.score_input_manifest_digest,
       fixture.batch_sha256_plan,
       fixture.batch_0_rows
     )
     FROM arena.fixture_atomic_writer_case AS fixture;
     SET CONSTRAINTS
       arena.leaderboard_rank_generation_stage_batches_publication_plan
       IMMEDIATE;
     COMMIT;"

  local rolled_back_shape
  rolled_back_shape="$(psql_cmd -Atq <<'SQL'
SELECT pg_catalog.concat_ws(
  '|',
  (SELECT pg_catalog.count(*) FROM ONLY
    arena.leaderboard_rank_generation_stage_batches),
  (SELECT pg_catalog.count(*) FROM ONLY
    arena.leaderboard_rank_generation_stage_rows),
  (SELECT pg_catalog.count(*) FROM ONLY
    arena.leaderboard_rank_generation_batch_receipts),
  (SELECT pg_catalog.count(*) FROM ONLY
    arena.leaderboard_rank_manifest_attestations),
  (SELECT pg_catalog.count(*) FROM ONLY
    arena.leaderboard_rank_manifest_attestation_chunks),
  (SELECT pg_catalog.count(*) FROM ONLY
    arena.leaderboard_rank_generation_publication_plans),
  (SELECT pg_catalog.count(*) FROM ONLY
    arena.leaderboard_rank_generation_publication_plan_sources)
);
SQL
)"
  if [[ "$rolled_back_shape" != '0|0|0|0|0|0|0' ]]; then
    echo "rejected publication manifest left private state: $rolled_back_shape" >&2
    exit 1
  fi

  local serving_after
  serving_after="$(psql_cmd -Atq <<'SQL'
SELECT pg_catalog.encode(
  pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'ranks', COALESCE((
        SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(rank_row.*)
          ORDER BY rank_row.season_id, rank_row.source,
                   rank_row.source_trader_id)
        FROM public.leaderboard_ranks AS rank_row
      ), '[]'::jsonb),
      'fences', COALESCE((
        SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(fence.*)
          ORDER BY fence.season_id, fence.source)
        FROM ONLY arena.leaderboard_rank_mutation_fences AS fence
      ), '[]'::jsonb),
      'freshness', COALESCE((
        SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(freshness.*)
          ORDER BY freshness.season_id, freshness.source)
        FROM ONLY public.leaderboard_source_freshness AS freshness
      ), '[]'::jsonb),
      'publications', COALESCE((
        SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(publication.*)
          ORDER BY publication.id)
        FROM ONLY arena.leaderboard_rank_publications AS publication
      ), '[]'::jsonb)
    )::text,
    'UTF8'
  )), 'hex');
SQL
)"
  if [[ "$serving_after" != "$serving_before" ]]; then
    echo 'rejected publication manifest changed serving state' >&2
    exit 1
  fi

  printf 'PostgreSQL 17 publication-plan %s fail-closed proof passed.\n' \
    "$PUBLICATION_PLAN_MANIFEST_MUTATION"
}

run_publication_plan_proof() {
  # Seed one exact legacy publication for gamma. It predates the immutable
  # trust-gated plan contract, so the first gated rollout must classify it as
  # unavailable just like delta; only alpha and beta are fresh replacements.
  psql_cmd -q <<'SQL'
INSERT INTO public.leaderboard_ranks (
  season_id,
  source,
  source_type,
  source_trader_id,
  rank,
  arena_score,
  roi,
  pnl,
  win_rate,
  max_drawdown,
  followers,
  trades_count,
  handle,
  computed_at,
  profitability_score,
  risk_control_score,
  score_completeness,
  is_outlier,
  metrics_estimated,
  arena_score_v4,
  arena_score_v3,
  score_factors,
  rank_publication_id
) VALUES (
  '90D',
  'gamma',
  'futures',
  'gamma-trader-001',
  1,
  50,
  12,
  500,
  60,
  10,
  5,
  20,
  'retained-gamma',
  pg_catalog.clock_timestamp(),
  50,
  50,
  'full',
  false,
  false,
  50,
  50,
  '{"roi":0.5,"pnl":0.5,"drawdown":0.5,"sharpe":0.5,"consistency":null}'::jsonb,
  '27500000-0000-4750-8750-000000000001'::uuid
);

DO $retained_publication$
DECLARE
  v_prior_cohort constant uuid :=
    '27500000-0000-4750-8750-000000000001'::uuid;
  v_source_as_of timestamptz;
  v_recorded_at timestamptz := pg_catalog.clock_timestamp();
  v_mutation_seq bigint;
  v_identity_sha256 text;
  v_proof jsonb;
BEGIN
  IF pg_catalog.to_regclass('arena.fixture_trusted_prior_plan') IS NULL THEN
    v_source_as_of := pg_catalog.clock_timestamp() - interval '10 minutes';
  ELSE
    EXECUTE $prior_source_as_of$
      SELECT prior.source_as_of
      FROM arena.fixture_trusted_prior_plan AS prior
    $prior_source_as_of$
    INTO STRICT v_source_as_of;
  END IF;

  SELECT fence.mutation_seq
  INTO STRICT v_mutation_seq
  FROM ONLY arena.leaderboard_rank_mutation_fences AS fence
  WHERE fence.season_id = '90D'
    AND fence.source = 'gamma';

  v_identity_sha256 := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_array('gamma-trader-001')::text,
        'UTF8'
      )
    ),
    'hex'
  );
  v_proof := pg_catalog.jsonb_build_object(
    'source', 'gamma',
    'source_as_of', pg_catalog.to_char(
      v_source_as_of AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'recorded_at', pg_catalog.to_char(
      v_recorded_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'score_cohort_id', v_prior_cohort,
    'rank_mutation_seq', v_mutation_seq,
    'published_rank_count', 1,
    'published_identity_sha256', v_identity_sha256
  );

  INSERT INTO arena.leaderboard_rank_publications (
    id,
    season_id,
    request_sha256,
    source_count,
    trader_count,
    proofs,
    published_at
  ) VALUES (
    v_prior_cohort,
    '90D',
    pg_catalog.repeat('d', 64),
    1,
    1,
    pg_catalog.jsonb_build_array(v_proof),
    v_recorded_at
  );

  PERFORM pg_catalog.set_config(
    'arena.leaderboard_seal_cohort',
    v_prior_cohort::text,
    true
  );
  INSERT INTO public.leaderboard_source_freshness (
    season_id,
    source,
    source_as_of,
    recorded_at,
    score_cohort_id,
    rank_mutation_seq,
    published_rank_count,
    published_identity_sha256
  ) VALUES (
    '90D',
    'gamma',
    v_source_as_of,
    v_recorded_at,
    v_prior_cohort,
    v_mutation_seq,
    1,
    v_identity_sha256
  );
END
$retained_publication$;

-- A legacy freshness observation may exist without an immutable publication
-- proof. With no live delta row, that all-NULL proof tuple is explicitly
-- unavailable rather than a retained publication.
INSERT INTO public.leaderboard_source_freshness (
  season_id,
  source,
  source_as_of,
  recorded_at
) VALUES (
  '90D',
  'delta',
  pg_catalog.clock_timestamp() - interval '5 minutes',
  pg_catalog.clock_timestamp()
);
SQL

  local workspace_reset
  workspace_reset="$(psql_cmd -Atq <<'SQL'
WITH definition AS MATERIALIZED (
  SELECT pg_catalog.pg_get_functiondef(
    'arena.seal_leaderboard_rank_generation_publication_plan_v1(text,bigint,uuid,uuid,text)'::regprocedure
  ) AS value
)
SELECT
  pg_catalog.strpos(
    definition.value,
    'DROP TABLE IF EXISTS pg_temp.leaderboard_rank_publication_plan_work'
  ) > 0
  AND pg_catalog.strpos(
    definition.value,
    'DROP TABLE IF EXISTS pg_temp.leaderboard_rank_publication_plan_work'
  ) < pg_catalog.strpos(
    definition.value,
    'CREATE TEMP TABLE leaderboard_rank_publication_plan_work'
  )
FROM definition;
SQL
)"
  if [[ "$workspace_reset" != 't' ]]; then
    echo 'publication-plan new-path workspace is not reset per invocation' >&2
    exit 1
  fi

  capture_publication_serving_state() {
    psql_cmd -Atqc "
      SELECT pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            pg_catalog.jsonb_build_object(
              'ranks', COALESCE((
                SELECT pg_catalog.jsonb_agg(
                  pg_catalog.to_jsonb(rank_row.*)
                  ORDER BY rank_row.season_id, rank_row.source,
                           rank_row.source_trader_id
                )
                FROM public.leaderboard_ranks AS rank_row
              ), '[]'::jsonb),
              'fences', COALESCE((
                SELECT pg_catalog.jsonb_agg(
                  pg_catalog.to_jsonb(fence.*)
                  ORDER BY fence.season_id, fence.source
                )
                FROM ONLY arena.leaderboard_rank_mutation_fences AS fence
              ), '[]'::jsonb),
              'freshness', COALESCE((
                SELECT pg_catalog.jsonb_agg(
                  pg_catalog.to_jsonb(freshness.*)
                  ORDER BY freshness.season_id, freshness.source
                )
                FROM ONLY public.leaderboard_source_freshness AS freshness
              ), '[]'::jsonb),
              'publications', COALESCE((
                SELECT pg_catalog.jsonb_agg(
                  pg_catalog.to_jsonb(publication.*)
                  ORDER BY publication.id
                )
                FROM ONLY arena.leaderboard_rank_publications AS publication
              ), '[]'::jsonb),
              'rankSequence', (
                SELECT pg_catalog.jsonb_build_object(
                  'last_value', sequence_row.last_value,
                  'is_called', sequence_row.is_called
                )
                FROM public.leaderboard_ranks_id_seq AS sequence_row
              )
            )::text,
            'UTF8'
          )
        ),
        'hex'
      );"
  }

  capture_publication_private_state() {
    psql_cmd -Atqc "
      SELECT pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            pg_catalog.jsonb_build_object(
              'plans', COALESCE((
                SELECT pg_catalog.jsonb_agg(
                  pg_catalog.to_jsonb(plan.*)
                  ORDER BY plan.season_id, plan.generation_seq
                )
                FROM ONLY arena.leaderboard_rank_generation_publication_plans
                  AS plan
              ), '[]'::jsonb),
              'sources', COALESCE((
                SELECT pg_catalog.jsonb_agg(
                  pg_catalog.to_jsonb(source_plan.*)
                  ORDER BY source_plan.season_id,
                           source_plan.generation_seq,
                           source_plan.source
                )
                FROM ONLY
                  arena.leaderboard_rank_generation_publication_plan_sources
                    AS source_plan
              ), '[]'::jsonb),
              'stageBatches', COALESCE((
                SELECT pg_catalog.jsonb_agg(
                  pg_catalog.to_jsonb(batch.*) ORDER BY batch.batch_index
                )
                FROM ONLY arena.leaderboard_rank_generation_stage_batches
                  AS batch
              ), '[]'::jsonb),
              'stageRows', COALESCE((
                SELECT pg_catalog.jsonb_agg(
                  pg_catalog.to_jsonb(staged.*)
                  ORDER BY staged.batch_index, staged.batch_position
                )
                FROM ONLY arena.leaderboard_rank_generation_stage_rows
                  AS staged
              ), '[]'::jsonb),
              'receipts', COALESCE((
                SELECT pg_catalog.jsonb_agg(
                  pg_catalog.to_jsonb(receipt.*) ORDER BY receipt.batch_index
                )
                FROM ONLY arena.leaderboard_rank_generation_batch_receipts
                  AS receipt
              ), '[]'::jsonb)
            )::text,
            'UTF8'
          )
        ),
        'hex'
      );"
  }

  local serving_baseline
  local private_baseline
  serving_baseline="$(capture_publication_serving_state)"
  private_baseline="$(capture_publication_private_state)"

  local bundle_binding
  bundle_binding="$(psql_cmd -Atq <<'SQL'
SELECT pg_catalog.concat_ws(
  '|',
  stored.manifest->'source'->'evidence'->'physicalBoards'
    IS NOT DISTINCT FROM current_bundle.value->'physicalBoards',
  pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      (stored.manifest->'source'->'evidence'->'physicalBoards')::text,
      'UTF8'
    )),
    'hex'
  ),
  pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      (current_bundle.value->'physicalBoards')::text,
      'UTF8'
    )),
    'hex'
  ),
  (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.jsonb_array_elements(current_bundle.value->'scoreRows')
      AS score_row(value)
    WHERE score_row.value->>'platform' = 'gamma'
  ),
  (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.jsonb_array_elements(stored.manifest->'inputs')
      AS input(value)
    WHERE input.value->>'source' = 'gamma'
  ),
  (
    SELECT pg_catalog.concat_ws(
      ':',
      board.value->>'evidence_status',
      board.value->>'actual_count',
      board.value->>'entry_count',
      board.value->>'rank_limited_entry_count'
    )
    FROM pg_catalog.jsonb_array_elements(current_bundle.value->'physicalBoards')
      AS board(value)
    WHERE board.value->>'filter_source' = 'gamma'
  ),
  (
    SELECT pg_catalog.concat_ws(
      ':',
      score_row.value->>'trader_key',
      score_row.value->>'board_rank'
    )
    FROM pg_catalog.jsonb_array_elements(current_bundle.value->'scoreRows')
      AS score_row(value)
    WHERE score_row.value->>'platform' = 'gamma'
  )
)
FROM arena.fixture_atomic_writer_case AS fixture
JOIN ONLY arena.leaderboard_score_input_manifests AS stored
  ON stored.manifest_id = fixture.score_input_manifest_id
CROSS JOIN LATERAL (
  SELECT public.arena_score_inputs_publish_bundle_json(
    fixture.season_id,
    1000,
    48
  ) AS value
) AS current_bundle;
SQL
)"
  if [[ "$bundle_binding" != \
    t\|*\|*\|1\|0\|latest_attempt_failed:1:1:1\|gamma-trader-001:1 ]]; then
    echo "publication manifest/current bundle fixture drifted: $bundle_binding" >&2
    exit 1
  fi

  expect_failure \
    'service role read publication-plan headers' \
    'permission denied' \
    "SET ROLE service_role;
     SELECT pg_catalog.count(*)
     FROM arena.leaderboard_rank_generation_publication_plans;"
  expect_failure \
    'rogue role read publication-plan sources' \
    'permission denied' \
    "SET ROLE fixture_rogue;
     SELECT pg_catalog.count(*)
     FROM arena.leaderboard_rank_generation_publication_plan_sources;"
  expect_failure \
    'service role called owner-only publication-plan sealer' \
    'permission denied for function seal_leaderboard_rank_generation_publication_plan_v1' \
    "SET ROLE service_role;
     SELECT arena.seal_leaderboard_rank_generation_publication_plan_v1(
       '90D', 1,
       '17500000-0000-4750-8750-000000000001'::uuid,
       '17500000-0000-4750-8750-000000000002'::uuid,
       repeat('a', 64)
     );"

  # A positive plan cannot be manufactured in a detached transaction before
  # its immutable batch-zero binding/stage evidence exists.
  expect_failure \
    'detached transaction sealed a positive publication plan' \
    'manifest binding|batch-zero|top-level transaction' \
    "SELECT arena.seal_leaderboard_rank_generation_publication_plan_v1(
       fixture.season_id,
       fixture.generation_seq,
       fixture.score_cohort_id,
       fixture.score_input_manifest_id,
       fixture.score_input_manifest_digest
     )
     FROM arena.fixture_atomic_writer_case AS fixture;"
  if [[ "$(capture_publication_private_state)" != "$private_baseline" \
     || "$(capture_publication_serving_state)" != "$serving_baseline" ]]; then
    echo 'rejected detached publication plan changed durable state' >&2
    exit 1
  fi

  expect_failure \
    'SAVEPOINT batch zero escaped publication-plan transaction guard' \
    'exact batch header from the current (top-level )?transaction|transaction-atomic|top-level transaction|immutable after header commit' \
    "BEGIN;
     SAVEPOINT publication_plan_subtransaction;
     SELECT arena.write_leaderboard_rank_generation_batch_v1(
       fixture.season_id,
       fixture.generation_seq,
       fixture.score_cohort_id,
       0,
       fixture.score_input_manifest_id,
       fixture.score_input_manifest_digest,
       fixture.batch_sha256_plan,
       fixture.batch_0_rows
     )
     FROM arena.fixture_atomic_writer_case AS fixture;
     SET CONSTRAINTS ALL IMMEDIATE;
     RELEASE SAVEPOINT publication_plan_subtransaction;
     COMMIT;"
  if [[ "$(capture_publication_private_state)" != "$private_baseline" \
     || "$(capture_publication_serving_state)" != "$serving_baseline" ]]; then
    echo 'rejected SAVEPOINT publication plan changed durable state' >&2
    exit 1
  fi

  # A caller may inherit immediate constraint mode. The writer/plan hook must
  # restore its required deferred ordering before the stage header is inserted;
  # otherwise the hook can run before stage rows and plan sources exist.
  psql_cmd -q <<'SQL'
BEGIN;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT arena.write_leaderboard_rank_generation_batch_v1(
  fixture.season_id,
  fixture.generation_seq,
  fixture.score_cohort_id,
  0,
  fixture.score_input_manifest_id,
  fixture.score_input_manifest_digest,
  fixture.batch_sha256_plan,
  fixture.batch_0_rows
)
FROM arena.fixture_atomic_writer_case AS fixture;
ROLLBACK;
SQL
  if [[ "$(capture_publication_private_state)" != "$private_baseline" \
     || "$(capture_publication_serving_state)" != "$serving_baseline" ]]; then
    echo 'immediate-constraint rollback left publication-plan state' >&2
    exit 1
  fi

  # Force the deferred batch-zero and completeness triggers in one top-level
  # transaction, inspect the complete plan, then prove rollback is all-or-none.
  psql_cmd -q \
    -v retain_mode="$PUBLICATION_PLAN_RETAIN_MODE" <<'SQL'
BEGIN;
SELECT pg_catalog.set_config(
  'arena.fixture_publication_plan_retain_mode',
  :'retain_mode',
  true
);
SELECT arena.write_leaderboard_rank_generation_batch_v1(
  fixture.season_id,
  fixture.generation_seq,
  fixture.score_cohort_id,
  0,
  fixture.score_input_manifest_id,
  fixture.score_input_manifest_digest,
  fixture.batch_sha256_plan,
  fixture.batch_0_rows
)
FROM arena.fixture_atomic_writer_case AS fixture;
DO $same_transaction_bundle$
DECLARE
  v_manifest_boards jsonb;
  v_current_boards jsonb;
BEGIN
  SELECT
    stored.manifest->'source'->'evidence'->'physicalBoards',
    public.arena_score_inputs_publish_bundle_json(
      fixture.season_id,
      1000,
      48
    )->'physicalBoards'
  INTO STRICT v_manifest_boards, v_current_boards
  FROM arena.fixture_atomic_writer_case AS fixture
  JOIN ONLY arena.leaderboard_score_input_manifests AS stored
    ON stored.manifest_id = fixture.score_input_manifest_id;
  IF v_manifest_boards IS DISTINCT FROM v_current_boards THEN
    RAISE EXCEPTION 'same-transaction physical-board fixture drifted';
  END IF;
END
$same_transaction_bundle$;
SET CONSTRAINTS
  arena.leaderboard_rank_generation_stage_batches_publication_plan IMMEDIATE;
DO $rolled_back_plan$
DECLARE
  v_actual text;
  v_expected text := CASE pg_catalog.current_setting(
    'arena.fixture_publication_plan_retain_mode'
  )
    WHEN 'trusted' THEN '4|2|1|1|1001|1|1002'
    ELSE '4|2|0|2|1001|0|1001'
  END;
BEGIN
  SELECT pg_catalog.concat_ws(
      '|',
      plan.source_count,
      plan.replace_source_count,
      plan.retain_source_count,
      plan.unavailable_source_count,
      plan.staged_rank_count,
      plan.retained_rank_count,
      plan.target_rank_count
    )
  INTO STRICT v_actual
  FROM ONLY arena.leaderboard_rank_generation_publication_plans AS plan
  JOIN arena.fixture_atomic_writer_case AS fixture
    ON fixture.season_id = plan.season_id
   AND fixture.generation_seq = plan.generation_seq
   AND fixture.score_cohort_id = plan.score_cohort_id;
  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION
      'deferred publication plan population drifted: actual %, expected %',
      v_actual,
      v_expected;
  END IF;
END
$rolled_back_plan$;
ROLLBACK;
SQL
  if [[ "$(capture_publication_private_state)" != "$private_baseline" \
     || "$(capture_publication_serving_state)" != "$serving_baseline" ]]; then
    echo 'rolled-back batch-zero publication plan left durable state' >&2
    exit 1
  fi

  local first_result
  first_result="$(psql_cmd -Atq <<'SQL'
SELECT arena.write_leaderboard_rank_generation_batch_v1(
  fixture.season_id,
  fixture.generation_seq,
  fixture.score_cohort_id,
  0,
  fixture.score_input_manifest_id,
  fixture.score_input_manifest_digest,
  fixture.batch_sha256_plan,
  fixture.batch_0_rows
)::text
FROM arena.fixture_atomic_writer_case AS fixture;
SQL
)"
  if [[ "$first_result" != *'"batch_index": 0'* \
     || "$first_result" != *'"row_count": 1000'* ]]; then
    echo "publication-plan batch zero returned unexpected receipt: $first_result" >&2
    exit 1
  fi

  local plan_shape
  local expected_plan_shape
  plan_shape="$(psql_cmd -Atqc "
    SELECT pg_catalog.concat_ws(
      '|',
      plan.source_count,
      plan.replace_source_count,
      plan.retain_source_count,
      plan.unavailable_source_count,
      plan.staged_rank_count,
      plan.retained_rank_count,
      plan.target_rank_count,
      plan.plan_write_top_xid = batch.stage_write_top_xid,
      plan.xmin = batch.xmin,
      (SELECT pg_catalog.string_agg(
         source_plan.source || ':' || source_plan.disposition || ':' ||
           source_plan.target_rank_count::text,
         ',' ORDER BY source_plan.source COLLATE pg_catalog.\"C\"
       )
       FROM ONLY
         arena.leaderboard_rank_generation_publication_plan_sources
           AS source_plan
       WHERE source_plan.season_id = plan.season_id
         AND source_plan.generation_seq = plan.generation_seq)
    )
    FROM ONLY arena.leaderboard_rank_generation_publication_plans AS plan
    JOIN arena.fixture_atomic_writer_case AS fixture
      ON fixture.season_id = plan.season_id
     AND fixture.generation_seq = plan.generation_seq
     AND fixture.score_cohort_id = plan.score_cohort_id
    JOIN ONLY arena.leaderboard_rank_generation_stage_batches AS batch
      ON batch.season_id = plan.season_id
     AND batch.generation_seq = plan.generation_seq
     AND batch.score_cohort_id = plan.score_cohort_id
    WHERE plan.season_id = '90D'
      AND batch.batch_index = 0;")"
  case "$PUBLICATION_PLAN_RETAIN_MODE" in
    trusted)
      expected_plan_shape='4|2|1|1|1001|1|1002|t|t|alpha:replace:1000,beta:replace:1,delta:unavailable:0,gamma:retain:1'
      ;;
    legacy|expired)
      expected_plan_shape='4|2|0|2|1001|0|1001|t|t|alpha:replace:1000,beta:replace:1,delta:unavailable:0,gamma:unavailable:0'
      ;;
  esac
  if [[ "$plan_shape" != "$expected_plan_shape" ]]; then
    echo "committed publication plan shape drifted: $plan_shape" >&2
    exit 1
  fi

  local source_disposition_shape
  local expected_source_disposition_shape
  source_disposition_shape="$(psql_cmd -Atq <<'SQL'
WITH fixture AS MATERIALIZED (
  SELECT current_case.*
  FROM arena.fixture_atomic_writer_case AS current_case
), gamma AS MATERIALIZED (
  SELECT source_plan.*
  FROM ONLY arena.leaderboard_rank_generation_publication_plan_sources
    AS source_plan
  JOIN fixture
    ON fixture.season_id = source_plan.season_id
   AND fixture.generation_seq = source_plan.generation_seq
   AND fixture.score_cohort_id = source_plan.score_cohort_id
  WHERE source_plan.season_id = '90D'
    AND source_plan.source = 'gamma'
), delta AS MATERIALIZED (
  SELECT source_plan.*
  FROM ONLY arena.leaderboard_rank_generation_publication_plan_sources
    AS source_plan
  JOIN fixture
    ON fixture.season_id = source_plan.season_id
   AND fixture.generation_seq = source_plan.generation_seq
   AND fixture.score_cohort_id = source_plan.score_cohort_id
  WHERE source_plan.season_id = '90D'
    AND source_plan.source = 'delta'
)
SELECT pg_catalog.concat_ws(
  '|',
  gamma.disposition,
  gamma.target_rank_count,
  gamma.source_as_of IS NULL,
  pg_catalog.num_nonnulls(
    gamma.prior_score_cohort_id,
    gamma.prior_rank_mutation_seq,
    gamma.prior_recorded_at,
    gamma.target_payload_sha256
  ),
  gamma.target_identity_sha256 =
    '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  gamma.metric_input_count,
  gamma.metric_evidence_valid_until IS NULL,
  gamma.metric_evidence_sha256 IS NULL,
  delta.disposition,
  delta.target_rank_count,
  delta.source_as_of IS NULL,
  (
    SELECT pg_catalog.num_nonnulls(
      freshness.score_cohort_id,
      freshness.rank_mutation_seq,
      freshness.published_rank_count,
      freshness.published_identity_sha256
    )
    FROM ONLY public.leaderboard_source_freshness AS freshness
    WHERE freshness.season_id = '90D'
      AND freshness.source = 'delta'
  ),
  NOT EXISTS (
    SELECT 1
    FROM public.leaderboard_ranks AS rank_row
    WHERE rank_row.season_id = '90D'
      AND rank_row.source = 'delta'
  ),
  NOT EXISTS (
    SELECT 1
    FROM ONLY arena.leaderboard_rank_publications AS publication
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(publication.proofs)
      AS proof(value)
    WHERE publication.season_id = '90D'
      AND proof.value->>'source' = 'delta'
  )
)
FROM gamma
CROSS JOIN delta;
SQL
)"
  case "$PUBLICATION_PLAN_RETAIN_MODE" in
    trusted)
      expected_source_disposition_shape='retain|1|f|4|f|1|f|f|unavailable|0|t|0|t|t'
      ;;
    legacy|expired)
      expected_source_disposition_shape='unavailable|0|t|0|t|0|t|t|unavailable|0|t|0|t|t'
      ;;
  esac
  if [[ "$source_disposition_shape" != \
        "$expected_source_disposition_shape" ]]; then
    echo "retain/unavailable proof semantics drifted: $source_disposition_shape" >&2
    exit 1
  fi

  if [[ "$PUBLICATION_PLAN_RETAIN_MODE" == 'trusted' ]]; then
    local trusted_inheritance_shape
    trusted_inheritance_shape="$(psql_cmd -Atq <<'SQL'
WITH fixture AS MATERIALIZED (
  SELECT current_case.*
  FROM arena.fixture_atomic_writer_case AS current_case
), current_gamma AS MATERIALIZED (
  SELECT source_plan.*
  FROM ONLY arena.leaderboard_rank_generation_publication_plan_sources
    AS source_plan
  JOIN fixture
    ON fixture.season_id = source_plan.season_id
   AND fixture.generation_seq = source_plan.generation_seq
   AND fixture.score_cohort_id = source_plan.score_cohort_id
  WHERE source_plan.source = 'gamma'
), prior_gamma AS MATERIALIZED (
  SELECT source_plan.*
  FROM ONLY arena.leaderboard_rank_generation_publication_plan_sources
    AS source_plan
  JOIN arena.fixture_trusted_prior_plan AS prior
    ON prior.score_cohort_id = source_plan.score_cohort_id
   AND prior.source_as_of = source_plan.source_as_of
  WHERE source_plan.season_id = '90D'
    AND source_plan.source = 'gamma'
)
SELECT pg_catalog.concat_ws(
  '|',
  current_gamma.source_as_of IS NOT DISTINCT FROM prior.source_as_of,
  freshness.source_as_of IS NOT DISTINCT FROM prior.source_as_of,
  current_gamma.metric_input_count IS NOT DISTINCT FROM
    prior.metric_input_count,
  current_gamma.metric_evidence_valid_until IS NOT DISTINCT FROM
    prior.metric_evidence_valid_until,
  current_gamma.metric_evidence_sha256 IS NOT DISTINCT FROM
    prior.metric_evidence_sha256,
  current_gamma.target_identity_sha256 IS NOT DISTINCT FROM
    prior.target_identity_sha256,
  current_gamma.target_payload_sha256 IS NOT DISTINCT FROM
    prior.target_payload_sha256,
  current_gamma.prior_score_cohort_id IS NOT DISTINCT FROM
    prior.score_cohort_id,
  prior_gamma.metric_input_count IS NOT DISTINCT FROM
    prior.metric_input_count,
  prior_gamma.metric_evidence_valid_until IS NOT DISTINCT FROM
    prior.metric_evidence_valid_until,
  prior_gamma.metric_evidence_sha256 IS NOT DISTINCT FROM
    prior.metric_evidence_sha256,
  prior.metric_evidence_valid_until >= head.lease_expires_at
)
FROM current_gamma
CROSS JOIN arena.fixture_trusted_prior_plan AS prior
JOIN ONLY public.leaderboard_source_freshness AS freshness
  ON freshness.season_id = '90D'
 AND freshness.source = 'gamma'
JOIN ONLY arena.leaderboard_rank_generation_heads AS head
  ON head.season_id = '90D'
 AND head.generation_seq = (SELECT generation_seq FROM fixture)
CROSS JOIN prior_gamma;
SQL
)"
    if [[ "$trusted_inheritance_shape" != \
          't|t|t|t|t|t|t|t|t|t|t|t' ]]; then
      echo "trusted gamma evidence was not inherited exactly: $trusted_inheritance_shape" >&2
      exit 1
    fi
  elif [[ "$PUBLICATION_PLAN_RETAIN_MODE" == 'expired' ]]; then
    local expired_evidence_shape
    expired_evidence_shape="$(psql_cmd -Atq <<'SQL'
WITH fixture AS MATERIALIZED (
  SELECT current_case.*
  FROM arena.fixture_atomic_writer_case AS current_case
), current_gamma AS MATERIALIZED (
  SELECT source_plan.*
  FROM ONLY arena.leaderboard_rank_generation_publication_plan_sources
    AS source_plan
  JOIN fixture
    ON fixture.season_id = source_plan.season_id
   AND fixture.generation_seq = source_plan.generation_seq
   AND fixture.score_cohort_id = source_plan.score_cohort_id
  WHERE source_plan.source = 'gamma'
), prior_gamma AS MATERIALIZED (
  SELECT source_plan.*
  FROM ONLY arena.leaderboard_rank_generation_publication_plan_sources
    AS source_plan
  JOIN arena.fixture_trusted_prior_plan AS prior
    ON prior.score_cohort_id = source_plan.score_cohort_id
   AND prior.source_as_of = source_plan.source_as_of
  WHERE source_plan.season_id = '90D'
    AND source_plan.source = 'gamma'
)
SELECT pg_catalog.concat_ws(
  '|',
  current_gamma.disposition = 'unavailable',
  current_gamma.target_rank_count = 0,
  pg_catalog.num_nonnulls(
    current_gamma.source_as_of,
    current_gamma.target_payload_sha256,
    current_gamma.metric_evidence_valid_until,
    current_gamma.metric_evidence_sha256,
    current_gamma.prior_score_cohort_id,
    current_gamma.prior_rank_mutation_seq,
    current_gamma.prior_recorded_at
  ) = 0,
  current_gamma.metric_input_count = 0,
  prior_gamma.metric_input_count IS NOT DISTINCT FROM
    prior.metric_input_count,
  prior_gamma.metric_evidence_valid_until IS NOT DISTINCT FROM
    prior.metric_evidence_valid_until,
  prior_gamma.metric_evidence_sha256 IS NOT DISTINCT FROM
    prior.metric_evidence_sha256,
  prior.metric_evidence_valid_until < head.lease_expires_at,
  freshness.source_as_of IS NOT DISTINCT FROM prior.source_as_of
)
FROM current_gamma
CROSS JOIN arena.fixture_trusted_prior_plan AS prior
JOIN ONLY public.leaderboard_source_freshness AS freshness
  ON freshness.season_id = '90D'
 AND freshness.source = 'gamma'
JOIN ONLY arena.leaderboard_rank_generation_heads AS head
  ON head.season_id = '90D'
 AND head.generation_seq = (SELECT generation_seq FROM fixture)
CROSS JOIN prior_gamma;
SQL
)"
    if [[ "$expired_evidence_shape" != 't|t|t|t|t|t|t|t|t' ]]; then
      echo "expired gamma evidence was renewed or retained: $expired_evidence_shape" >&2
      exit 1
    fi
  fi
  if [[ "$(capture_publication_serving_state)" != "$serving_baseline" ]]; then
    echo 'batch-zero publication plan mutated live serving state' >&2
    exit 1
  fi

  local private_sealed
  local replay_result
  local replay_plan_a
  local replay_plan_b
  private_sealed="$(capture_publication_private_state)"
  replay_result="$(psql_cmd -Atq <<'SQL'
SELECT arena.write_leaderboard_rank_generation_batch_v1(
  fixture.season_id,
  fixture.generation_seq,
  fixture.score_cohort_id,
  0,
  fixture.score_input_manifest_id,
  fixture.score_input_manifest_digest,
  fixture.batch_sha256_plan,
  fixture.batch_0_rows
)::text
FROM arena.fixture_atomic_writer_case AS fixture;
SQL
)"
  replay_plan_a="$(psql_cmd -Atq <<'SQL'
SELECT arena.seal_leaderboard_rank_generation_publication_plan_v1(
  fixture.season_id,
  fixture.generation_seq,
  fixture.score_cohort_id,
  fixture.score_input_manifest_id,
  fixture.score_input_manifest_digest
)::text
FROM arena.fixture_atomic_writer_case AS fixture;
SQL
)"
  replay_plan_b="$(psql_cmd -Atq <<'SQL'
SELECT arena.seal_leaderboard_rank_generation_publication_plan_v1(
  fixture.season_id,
  fixture.generation_seq,
  fixture.score_cohort_id,
  fixture.score_input_manifest_id,
  fixture.score_input_manifest_digest
)::text
FROM arena.fixture_atomic_writer_case AS fixture;
SQL
)"
  if [[ "$replay_result" != "$first_result" \
     || -z "$replay_plan_a" \
     || "$replay_plan_b" != "$replay_plan_a" \
     || "$(capture_publication_private_state)" != "$private_sealed" \
     || "$(capture_publication_serving_state)" != "$serving_baseline" ]]; then
    echo 'publication-plan response-loss replay was not frozen and zero-write' >&2
    exit 1
  fi

  expect_failure \
    'owner updated immutable publication-plan header' \
    'publication receipts are immutable' \
    "UPDATE arena.leaderboard_rank_generation_publication_plans
     SET planned_at = planned_at
     WHERE (season_id, generation_seq, score_cohort_id) = (
       SELECT season_id, generation_seq, score_cohort_id
       FROM arena.fixture_atomic_writer_case
     );"
  expect_failure \
    'owner deleted immutable publication-plan source' \
    'publication receipts are immutable' \
    "DELETE FROM arena.leaderboard_rank_generation_publication_plan_sources
     WHERE (season_id, generation_seq, score_cohort_id) = (
       SELECT season_id, generation_seq, score_cohort_id
       FROM arena.fixture_atomic_writer_case
     )
       AND source = 'delta';"
  expect_failure \
    'owner truncated immutable publication plans' \
    'publication receipts are immutable' \
    'TRUNCATE arena.leaderboard_rank_generation_publication_plans CASCADE;'
  expect_failure \
    'owner appended a source after the publication-plan transaction' \
    'current full transaction id|exact current header' \
    "INSERT INTO arena.leaderboard_rank_generation_publication_plan_sources (
       contract, season_id, generation_seq, score_cohort_id, source,
       disposition, source_as_of, registry_slugs, snapshot_ids,
       source_evidence, source_evidence_sha256, target_rank_count,
       target_identity_sha256, target_payload_sha256,
       metric_input_count, metric_evidence_valid_until,
       metric_evidence_sha256,
       prior_score_cohort_id, prior_rank_mutation_seq, prior_recorded_at
     )
     SELECT contract, season_id, generation_seq, score_cohort_id, 'epsilon',
       disposition, source_as_of, '[\"epsilon\"]'::jsonb, snapshot_ids,
       source_evidence, source_evidence_sha256, target_rank_count,
       target_identity_sha256, target_payload_sha256,
       metric_input_count, metric_evidence_valid_until,
       metric_evidence_sha256,
       prior_score_cohort_id, prior_rank_mutation_seq, prior_recorded_at
     FROM arena.leaderboard_rank_generation_publication_plan_sources
     WHERE (season_id, generation_seq, score_cohort_id) = (
       SELECT season_id, generation_seq, score_cohort_id
       FROM arena.fixture_atomic_writer_case
     )
       AND source = 'alpha';"
  if [[ "$(capture_publication_private_state)" != "$private_sealed" \
     || "$(capture_publication_serving_state)" != "$serving_baseline" ]]; then
    echo 'rejected publication-plan mutation changed durable state' >&2
    exit 1
  fi
}
