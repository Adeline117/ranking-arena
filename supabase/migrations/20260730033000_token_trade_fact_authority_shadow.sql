-- Migration: 20260730033000_token_trade_fact_authority_shadow.sql
-- Created: 2026-07-30T03:30:00Z
-- Description: Build a private, fail-closed token-trade evidence authority;
--   arena.position_history is only a non-authoritative legacy projection.
--   This is shadow-only: no public token MV, ranking
--   RPC, refresh function, or serving route is replaced by this migration.
--
-- The existing position rows deliberately remain untrusted. A row becomes a
-- shadow candidate only when an append-only fact attestation and a fresh
-- 7/30/90-day coverage evaluation bind to an immutable event_history RAW
-- artifact. Trust is never inferred from position_history.raw or raw metadata.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';

DO $preflight$
DECLARE
  v_required_columns text[];
  v_present_columns text[];
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL
     OR pg_catalog.to_regclass('arena.raw_objects') IS NULL
     OR pg_catalog.to_regclass('arena.position_history') IS NULL THEN
    RAISE EXCEPTION 'token trade authority foundations are missing';
  END IF;

  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'token trade authority requires Supabase runtime roles';
  END IF;

  IF pg_catalog.to_regclass('arena.token_trade_source_contracts') IS NOT NULL
     OR pg_catalog.to_regclass('arena.token_assets') IS NOT NULL
     OR pg_catalog.to_regclass('arena.token_trade_contract_assets') IS NOT NULL
     OR pg_catalog.to_regclass('arena.token_trade_fx_evidence') IS NOT NULL
     OR pg_catalog.to_regclass('arena.token_trade_fact_evidence') IS NOT NULL
     OR pg_catalog.to_regclass('arena.token_history_coverage_evidence') IS NOT NULL
     OR pg_catalog.to_regclass('arena.token_trade_fact_authority_shadow') IS NOT NULL THEN
    RAISE EXCEPTION 'token trade authority shadow relations already exist';
  END IF;

  v_required_columns := ARRAY[
    'id',
    'source_id',
    'trader_id',
    'job_type',
    'fetched_at',
    'content_hash',
    'quarantined',
    'source_run_id',
    'trust_artifact_role'
  ]::text[];

  SELECT pg_catalog.array_agg(attribute.attname ORDER BY attribute.attname)
    INTO v_present_columns
    FROM pg_catalog.pg_attribute AS attribute
   WHERE attribute.attrelid = 'arena.raw_objects'::pg_catalog.regclass
     AND attribute.attname = ANY (v_required_columns)
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped;

  IF v_present_columns IS DISTINCT FROM (
    SELECT pg_catalog.array_agg(name ORDER BY name)
      FROM pg_catalog.unnest(v_required_columns) AS required(name)
  ) THEN
    RAISE EXCEPTION 'raw_objects lacks typed token-history lineage columns';
  END IF;

  IF (SELECT pg_catalog.count(*)
        FROM arena.sources AS source_row
       WHERE source_row.slug IN ('binance_futures', 'okx_futures')) <> 2 THEN
    RAISE EXCEPTION 'reviewed Binance/OKX token fact sources are missing';
  END IF;
END
$preflight$;

-- This registry is migration-owned, not writer-owned. It records the exact
-- reviewed upstream semantics that an evidence writer is allowed to claim.
-- Field paths are documentary lineage keys only; the authority view never
-- reads JSON and cannot silently reinterpret a changed payload.
CREATE TABLE arena.token_trade_source_contracts (
  contract_id text PRIMARY KEY,
  source_id smallint NOT NULL UNIQUE
    REFERENCES arena.sources(id) ON DELETE RESTRICT,
  source_slug text NOT NULL UNIQUE,
  adapter_slug text NOT NULL,
  product_type text NOT NULL,
  native_currency text NOT NULL,
  source_row_identity_field_path text NOT NULL,
  token_field_path text NOT NULL,
  opened_at_field_path text NOT NULL,
  closed_at_field_path text NOT NULL,
  entry_price_field_path text NOT NULL,
  exit_price_field_path text NOT NULL,
  realized_pnl_field_path text NOT NULL,
  lifecycle_field_path text NOT NULL,
  lifecycle_marker_rule text NOT NULL
    CHECK (lifecycle_marker_rule IN ('exact_literal', 'positive_epoch_ms')),
  closed_lifecycle_marker_literal text,
  pnl_provenance text NOT NULL
    CHECK (pnl_provenance IN ('source_reported', 'arena_rebuilt')),
  price_provenance text NOT NULL
    CHECK (price_provenance IN ('source_reported', 'arena_rebuilt')),
  cost_basis_provenance text NOT NULL
    CHECK (cost_basis_provenance IN ('source_reported', 'arena_rebuilt')),
  fx_provenance text NOT NULL
    CHECK (fx_provenance IN ('not_required', 'arena_fx_snapshot')),
  required_pnl_trust_state text NOT NULL
    CHECK (required_pnl_trust_state IN ('source_owned', 'verified')),
  required_price_trust_state text NOT NULL
    CHECK (required_price_trust_state IN ('source_owned', 'verified')),
  required_cost_basis_trust_state text NOT NULL
    CHECK (required_cost_basis_trust_state IN ('source_owned', 'verified')),
  required_fx_trust_state text NOT NULL
    CHECK (required_fx_trust_state IN ('not_required', 'verified')),
  token_normalization_method_version text NOT NULL,
  fact_authority_method_version text NOT NULL,
  fx_method_version text NOT NULL,
  coverage_evaluator_method_version text NOT NULL,
  required_raw_artifact_role text NOT NULL
    CHECK (required_raw_artifact_role = 'event_history'),
  required_raw_job_type text NOT NULL
    CHECK (required_raw_job_type = 'history:position_history'),
  allowed_scan_terminal_states text[] NOT NULL CHECK (
    pg_catalog.cardinality(allowed_scan_terminal_states) > 0
    AND allowed_scan_terminal_states <@ ARRAY[
      'exhausted',
      'cursor_overlap',
      'window_prefix_proven'
    ]::text[]
    AND pg_catalog.array_position(allowed_scan_terminal_states, NULL) IS NULL
  ),
  max_coverage_freshness interval NOT NULL
    CHECK (
      max_coverage_freshness > interval '0 seconds'
      AND max_coverage_freshness <= interval '48 hours'
    ),
  max_window_end_lag interval NOT NULL CHECK (
    max_window_end_lag >= interval '0 seconds'
    AND max_window_end_lag <= interval '24 hours'
  ),
  max_raw_capture_lag interval NOT NULL CHECK (
    max_raw_capture_lag >= interval '0 seconds'
    AND max_raw_capture_lag <= interval '24 hours'
  ),
  max_fx_price_lag interval NOT NULL CHECK (
    max_fx_price_lag >= interval '0 seconds'
    AND max_fx_price_lag <= interval '24 hours'
  ),
  reviewed_at date NOT NULL,
  active boolean NOT NULL DEFAULT true,
  CHECK (pg_catalog.btrim(contract_id) <> ''),
  CHECK (pg_catalog.btrim(source_slug) <> ''),
  CHECK (pg_catalog.btrim(adapter_slug) <> ''),
  CHECK (pg_catalog.btrim(product_type) <> ''),
  CHECK (pg_catalog.btrim(native_currency) <> ''),
  CHECK (pg_catalog.btrim(source_row_identity_field_path) <> ''),
  CHECK (pg_catalog.btrim(token_field_path) <> ''),
  CHECK (pg_catalog.btrim(opened_at_field_path) <> ''),
  CHECK (pg_catalog.btrim(closed_at_field_path) <> ''),
  CHECK (pg_catalog.btrim(entry_price_field_path) <> ''),
  CHECK (pg_catalog.btrim(exit_price_field_path) <> ''),
  CHECK (pg_catalog.btrim(realized_pnl_field_path) <> ''),
  CHECK (pg_catalog.btrim(lifecycle_field_path) <> ''),
  CHECK (
    (
      lifecycle_marker_rule = 'exact_literal'
      AND closed_lifecycle_marker_literal IS NOT NULL
      AND pg_catalog.btrim(closed_lifecycle_marker_literal) <> ''
    )
    OR (
      lifecycle_marker_rule = 'positive_epoch_ms'
      AND closed_lifecycle_marker_literal IS NULL
    )
  ),
  CHECK (pg_catalog.btrim(token_normalization_method_version) <> ''),
  CHECK (pg_catalog.btrim(fact_authority_method_version) <> ''),
  CHECK (pg_catalog.btrim(fx_method_version) <> ''),
  CHECK (pg_catalog.btrim(coverage_evaluator_method_version) <> '')
);

INSERT INTO arena.token_trade_source_contracts (
  contract_id,
  source_id,
  source_slug,
  adapter_slug,
  product_type,
  native_currency,
  source_row_identity_field_path,
  token_field_path,
  opened_at_field_path,
  closed_at_field_path,
  entry_price_field_path,
  exit_price_field_path,
  realized_pnl_field_path,
  lifecycle_field_path,
  lifecycle_marker_rule,
  closed_lifecycle_marker_literal,
  pnl_provenance,
  price_provenance,
  cost_basis_provenance,
  fx_provenance,
  required_pnl_trust_state,
  required_price_trust_state,
  required_cost_basis_trust_state,
  required_fx_trust_state,
  token_normalization_method_version,
  fact_authority_method_version,
  fx_method_version,
  coverage_evaluator_method_version,
  required_raw_artifact_role,
  required_raw_job_type,
  allowed_scan_terminal_states,
  max_coverage_freshness,
  max_window_end_lag,
  max_raw_capture_lag,
  max_fx_price_lag,
  reviewed_at,
  active
)
SELECT
  'binance-futures-position-history@1',
  source_row.id,
  'binance_futures',
  'binance',
  'futures',
  'USDT',
  'tuple(portfolioId,response.data.list[].id,response.data.list[].symbol,response.data.list[].side)',
  'response.data.list[].symbol',
  'response.data.list[].opened',
  'response.data.list[].closed',
  'response.data.list[].avgCost',
  'response.data.list[].avgClosePrice',
  'response.data.list[].closingPnl',
  'response.data.list[].status',
  'exact_literal',
  'All Closed',
  'source_reported',
  'source_reported',
  'source_reported',
  'arena_fx_snapshot',
  'source_owned',
  'source_owned',
  'source_owned',
  'verified',
  'arena.derivative-token-normalization@1',
  'arena.binance-futures-token-trade-fact@1',
  'arena.usdt-usd-price-history-fx@1',
  'arena.binance-futures-history-coverage@1',
  'event_history',
  'history:position_history',
  ARRAY['exhausted', 'cursor_overlap', 'window_prefix_proven']::text[],
  interval '24 hours',
  interval '15 minutes',
  interval '15 minutes',
  interval '1 hour',
  DATE '2026-07-29',
  true
FROM arena.sources AS source_row
WHERE source_row.slug = 'binance_futures'
  AND source_row.adapter_slug = 'binance'
  AND source_row.product_type = 'futures'
  AND source_row.currency = 'USDT'
UNION ALL
SELECT
  'okx-futures-position-history@1',
  source_row.id,
  'okx_futures',
  'okx',
  'futures',
  'USDT',
  'tuple(historyTraderIdentity,data[].subPosId)',
  'data[].instId',
  'data[].openTime',
  'data[].closeTime',
  'data[].openAvgPx',
  'data[].closeAvgPx',
  'data[].pnl',
  'data[].closeTime',
  'positive_epoch_ms',
  NULL,
  'source_reported',
  'source_reported',
  'source_reported',
  'arena_fx_snapshot',
  'source_owned',
  'source_owned',
  'source_owned',
  'verified',
  'arena.derivative-token-normalization@1',
  'arena.okx-futures-token-trade-fact@1',
  'arena.usdt-usd-price-history-fx@1',
  'arena.okx-futures-history-coverage@1',
  'event_history',
  'history:position_history',
  ARRAY['exhausted', 'cursor_overlap', 'window_prefix_proven']::text[],
  interval '24 hours',
  interval '15 minutes',
  interval '15 minutes',
  interval '1 hour',
  DATE '2026-07-29',
  true
FROM arena.sources AS source_row
WHERE source_row.slug = 'okx_futures'
  AND source_row.adapter_slug = 'okx'
  AND source_row.product_type = 'futures'
  AND source_row.currency = 'USDT';

DO $contract_seed$
BEGIN
  IF (SELECT pg_catalog.count(*)
        FROM arena.token_trade_source_contracts) <> 2 THEN
    RAISE EXCEPTION 'reviewed token trade source contracts did not bind exactly';
  END IF;
END
$contract_seed$;

-- Canonical assets are separate from display tickers. CEX mappings are
-- migration-reviewed base assets; future DEX contracts must bind an exact
-- namespace + chain + protocol/address locator, so equal tickers on different
-- chains cannot collapse into one ranking identity.
CREATE TABLE arena.token_assets (
  asset_id text PRIMARY KEY CHECK (pg_catalog.btrim(asset_id) <> ''),
  asset_namespace text NOT NULL
    CHECK (asset_namespace IN ('cex', 'evm', 'solana', 'protocol')),
  canonical_ticker text NOT NULL CHECK (
    canonical_ticker = pg_catalog.upper(canonical_ticker)
    AND canonical_ticker ~ '^[A-Z0-9]{1,20}$'
    AND canonical_ticker ~ '[A-Z]'
  ),
  chain_id text,
  protocol_slug text,
  token_address text,
  active boolean NOT NULL DEFAULT true,
  CHECK (
    (
      asset_namespace = 'cex'
      AND chain_id IS NULL
      AND protocol_slug IS NULL
      AND token_address IS NULL
    )
    OR (
      asset_namespace IN ('evm', 'solana')
      AND chain_id IS NOT NULL
      AND pg_catalog.btrim(chain_id) <> ''
      AND protocol_slug IS NULL
      AND token_address IS NOT NULL
      AND pg_catalog.btrim(token_address) <> ''
    )
    OR (
      asset_namespace = 'protocol'
      AND chain_id IS NOT NULL
      AND pg_catalog.btrim(chain_id) <> ''
      AND protocol_slug IS NOT NULL
      AND pg_catalog.btrim(protocol_slug) <> ''
      AND token_address IS NOT NULL
      AND pg_catalog.btrim(token_address) <> ''
    )
  ),
  CHECK (
    asset_namespace <> 'evm'
    OR (
      chain_id ~ '^[1-9][0-9]*$'
      AND token_address = pg_catalog.lower(token_address)
      AND token_address ~ '^0x[0-9a-f]{40}$'
    )
  )
);

CREATE UNIQUE INDEX uq_token_assets_cex_ticker
  ON arena.token_assets (canonical_ticker)
  WHERE asset_namespace = 'cex';
CREATE UNIQUE INDEX uq_token_assets_onchain_locator
  ON arena.token_assets (asset_namespace, chain_id, token_address)
  WHERE asset_namespace IN ('evm', 'solana');
CREATE UNIQUE INDEX uq_token_assets_protocol_locator
  ON arena.token_assets (chain_id, protocol_slug, token_address)
  WHERE asset_namespace = 'protocol';

INSERT INTO arena.token_assets (
  asset_id,
  asset_namespace,
  canonical_ticker,
  chain_id,
  protocol_slug,
  token_address,
  active
) VALUES
  ('crypto:ada',  'cex', 'ADA',  NULL, NULL, NULL, true),
  ('crypto:atom', 'cex', 'ATOM', NULL, NULL, NULL, true),
  ('crypto:avax', 'cex', 'AVAX', NULL, NULL, NULL, true),
  ('crypto:bnb',  'cex', 'BNB',  NULL, NULL, NULL, true),
  ('crypto:btc',  'cex', 'BTC',  NULL, NULL, NULL, true),
  ('crypto:doge', 'cex', 'DOGE', NULL, NULL, NULL, true),
  ('crypto:dot',  'cex', 'DOT',  NULL, NULL, NULL, true),
  ('crypto:eth',  'cex', 'ETH',  NULL, NULL, NULL, true),
  ('crypto:link', 'cex', 'LINK', NULL, NULL, NULL, true),
  ('crypto:ltc',  'cex', 'LTC',  NULL, NULL, NULL, true),
  ('crypto:matic','cex', 'MATIC',NULL, NULL, NULL, true),
  ('crypto:near', 'cex', 'NEAR', NULL, NULL, NULL, true),
  ('crypto:sol',  'cex', 'SOL',  NULL, NULL, NULL, true),
  ('crypto:uni',  'cex', 'UNI',  NULL, NULL, NULL, true),
  ('crypto:xrp',  'cex', 'XRP',  NULL, NULL, NULL, true),
  (
    'evm:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    'evm',
    'USDC',
    '1',
    NULL,
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    true
  ),
  (
    'evm:42161:0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    'evm',
    'USDC',
    '42161',
    NULL,
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    true
  );

CREATE TABLE arena.token_trade_contract_assets (
  contract_id text NOT NULL
    REFERENCES arena.token_trade_source_contracts(contract_id) ON DELETE RESTRICT,
  source_asset_locator text NOT NULL CHECK (
    pg_catalog.btrim(source_asset_locator) <> ''
  ),
  source_base_asset text NOT NULL CHECK (
    source_base_asset = pg_catalog.upper(source_base_asset)
    AND source_base_asset ~ '^[A-Z0-9]{1,20}$'
  ),
  asset_id text NOT NULL
    REFERENCES arena.token_assets(asset_id) ON DELETE RESTRICT,
  PRIMARY KEY (contract_id, source_asset_locator)
);

INSERT INTO arena.token_trade_contract_assets (
  contract_id,
  source_asset_locator,
  source_base_asset,
  asset_id
)
SELECT
  contract.contract_id,
  CASE contract.source_slug
    WHEN 'binance_futures' THEN asset.canonical_ticker || 'USDT'
    WHEN 'okx_futures' THEN asset.canonical_ticker || '-USDT-SWAP'
  END,
  asset.canonical_ticker,
  asset.asset_id
FROM arena.token_trade_source_contracts AS contract
CROSS JOIN arena.token_assets AS asset
WHERE asset.asset_namespace = 'cex';

-- USD conversion is independent evidence. An event-history writer cannot
-- promote a literal rate: every accepted USDT/USD observation must bind a
-- distinct immutable price_history RAW digest and the contract-owned method.
-- RAW retention nulls the pointer but preserves the latest evidence tombstone,
-- so garbage collection cannot resurrect an older verified observation.
CREATE TABLE arena.token_trade_fx_evidence (
  fx_evidence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contract_id text NOT NULL
    REFERENCES arena.token_trade_source_contracts(contract_id) ON DELETE RESTRICT,
  source_id smallint NOT NULL
    REFERENCES arena.sources(id) ON DELETE RESTRICT,
  source_run_id text NOT NULL CHECK (
    source_run_id ~ '^[0-9a-f]{64}$'
    AND source_run_id <> pg_catalog.repeat('0', 64)
  ),
  source_raw_object_id bigint
    REFERENCES arena.raw_objects(id) ON DELETE SET NULL,
  base_currency text NOT NULL CHECK (base_currency = 'USDT'),
  quote_currency text NOT NULL CHECK (quote_currency = 'USD'),
  fx_rate_to_usd numeric,
  price_as_of timestamptz NOT NULL,
  fx_provenance text NOT NULL CHECK (fx_provenance = 'arena_fx_snapshot'),
  fx_trust_state text NOT NULL CHECK (fx_trust_state IN ('verified', 'unknown')),
  fx_method_version text NOT NULL CHECK (
    pg_catalog.btrim(fx_method_version) <> ''
  ),
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  declared_blocker_reasons text[] NOT NULL DEFAULT ARRAY['unreviewed']::text[]
    CHECK (
      pg_catalog.cardinality(declared_blocker_reasons) <= 32
      AND pg_catalog.array_position(declared_blocker_reasons, NULL) IS NULL
    ),
  CHECK (
    (
      fx_trust_state = 'verified'
      AND fx_rate_to_usd > 0
      AND fx_rate_to_usd NOT IN (
        'NaN'::numeric,
        'Infinity'::numeric,
        '-Infinity'::numeric
      )
    )
    OR (fx_trust_state = 'unknown' AND fx_rate_to_usd IS NULL)
  ),
  CHECK (price_as_of <= recorded_at + interval '5 minutes')
);

CREATE INDEX idx_token_trade_fx_evidence_observation_latest
  ON arena.token_trade_fx_evidence (
    contract_id,
    base_currency,
    quote_currency,
    price_as_of DESC,
    fx_evidence_id DESC
  );

-- Append-only row-level facts. No column defaults a trust state upward. The
-- default blocker makes an omitted blocker decision explicitly unrankable.
CREATE TABLE arena.token_trade_fact_evidence (
  evidence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contract_id text NOT NULL
    REFERENCES arena.token_trade_source_contracts(contract_id) ON DELETE RESTRICT,
  source_id smallint NOT NULL
    REFERENCES arena.sources(id) ON DELETE RESTRICT,
  trader_id bigint NOT NULL
    REFERENCES arena.traders(id) ON DELETE RESTRICT,
  source_run_id text NOT NULL CHECK (
    source_run_id ~ '^[0-9a-f]{64}$'
    AND source_run_id <> pg_catalog.repeat('0', 64)
  ),
  source_raw_object_id bigint
    REFERENCES arena.raw_objects(id) ON DELETE SET NULL,
  source_row_identity text NOT NULL CHECK (
    pg_catalog.btrim(source_row_identity) <> ''
  ),
  closed_at timestamptz NOT NULL,
  position_dedupe_hash text NOT NULL CHECK (
    pg_catalog.btrim(position_dedupe_hash) <> ''
  ),
  source_symbol text NOT NULL CHECK (pg_catalog.btrim(source_symbol) <> ''),
  source_asset_locator text NOT NULL CHECK (
    pg_catalog.btrim(source_asset_locator) <> ''
  ),
  asset_id text NOT NULL
    REFERENCES arena.token_assets(asset_id) ON DELETE RESTRICT,
  asset_namespace text NOT NULL
    CHECK (asset_namespace IN ('cex', 'evm', 'solana', 'protocol')),
  asset_chain_id text,
  asset_protocol_slug text,
  token_address text,
  normalized_token text,
  token_normalization_state text NOT NULL
    CHECK (token_normalization_state IN ('normalized', 'unsupported', 'unknown')),
  token_normalization_method_version text NOT NULL CHECK (
    pg_catalog.btrim(token_normalization_method_version) <> ''
  ),
  opened_at timestamptz,
  entry_price numeric,
  exit_price numeric,
  realized_pnl_source numeric,
  reported_currency text NOT NULL CHECK (
    reported_currency ~ '^[A-Za-z0-9._-]{2,16}$'
  ),
  fx_evidence_id bigint
    REFERENCES arena.token_trade_fx_evidence(fx_evidence_id) ON DELETE SET NULL,
  fx_rate_to_usd numeric,
  realized_pnl_usd numeric GENERATED ALWAYS AS (
    realized_pnl_source * fx_rate_to_usd
  ) STORED,
  lifecycle_state text NOT NULL
    CHECK (lifecycle_state IN ('closed', 'partial', 'unknown')),
  source_lifecycle_marker text,
  pnl_provenance text NOT NULL
    CHECK (pnl_provenance IN ('source_reported', 'arena_rebuilt', 'unknown')),
  pnl_trust_state text NOT NULL
    CHECK (pnl_trust_state IN ('source_owned', 'verified', 'partial', 'unknown')),
  price_provenance text NOT NULL
    CHECK (price_provenance IN ('source_reported', 'arena_rebuilt', 'unknown')),
  price_trust_state text NOT NULL
    CHECK (price_trust_state IN ('source_owned', 'verified', 'partial', 'unknown')),
  cost_basis_provenance text NOT NULL
    CHECK (cost_basis_provenance IN ('source_reported', 'arena_rebuilt', 'unknown')),
  cost_basis_trust_state text NOT NULL
    CHECK (cost_basis_trust_state IN ('source_owned', 'verified', 'partial', 'unknown')),
  fx_provenance text NOT NULL
    CHECK (fx_provenance IN ('not_required', 'arena_fx_snapshot', 'unknown')),
  fx_trust_state text NOT NULL
    CHECK (fx_trust_state IN ('not_required', 'verified', 'partial', 'unknown')),
  authority_method_version text NOT NULL CHECK (
    pg_catalog.btrim(authority_method_version) <> ''
  ),
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  declared_blocker_reasons text[] NOT NULL DEFAULT ARRAY['unreviewed']::text[]
    CHECK (
      pg_catalog.cardinality(declared_blocker_reasons) <= 32
      AND pg_catalog.array_position(declared_blocker_reasons, NULL) IS NULL
    ),
  CHECK (
    (token_normalization_state = 'normalized') = (normalized_token IS NOT NULL)
  ),
  CHECK (
    normalized_token IS NULL
    OR (
      normalized_token = pg_catalog.upper(normalized_token)
      AND normalized_token ~ '^[A-Z0-9]{1,20}$'
      AND normalized_token ~ '[A-Z]'
    )
  ),
  CHECK (
    (
      asset_namespace = 'cex'
      AND asset_chain_id IS NULL
      AND asset_protocol_slug IS NULL
      AND token_address IS NULL
    )
    OR (
      asset_namespace IN ('evm', 'solana')
      AND asset_chain_id IS NOT NULL
      AND pg_catalog.btrim(asset_chain_id) <> ''
      AND asset_protocol_slug IS NULL
      AND token_address IS NOT NULL
      AND pg_catalog.btrim(token_address) <> ''
    )
    OR (
      asset_namespace = 'protocol'
      AND asset_chain_id IS NOT NULL
      AND pg_catalog.btrim(asset_chain_id) <> ''
      AND asset_protocol_slug IS NOT NULL
      AND pg_catalog.btrim(asset_protocol_slug) <> ''
      AND token_address IS NOT NULL
      AND pg_catalog.btrim(token_address) <> ''
    )
  ),
  CHECK (
    asset_namespace <> 'evm'
    OR (
      asset_chain_id ~ '^[1-9][0-9]*$'
      AND token_address = pg_catalog.lower(token_address)
      AND token_address ~ '^0x[0-9a-f]{40}$'
    )
  ),
  CHECK (opened_at IS NULL OR opened_at <= closed_at),
  CHECK (
    source_lifecycle_marker IS NULL
    OR pg_catalog.btrim(source_lifecycle_marker) <> ''
  ),
  CHECK (
    entry_price IS NULL
    OR (
      entry_price > 0
      AND entry_price NOT IN (
        'NaN'::numeric,
        'Infinity'::numeric,
        '-Infinity'::numeric
      )
    )
  ),
  CHECK (
    exit_price IS NULL
    OR (
      exit_price > 0
      AND exit_price NOT IN (
        'NaN'::numeric,
        'Infinity'::numeric,
        '-Infinity'::numeric
      )
    )
  ),
  CHECK (
    realized_pnl_source IS NULL
    OR realized_pnl_source NOT IN (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
  ),
  CHECK (
    realized_pnl_usd IS NULL
    OR realized_pnl_usd NOT IN (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
  ),
  CHECK (
    (
      fx_trust_state IN ('not_required', 'verified')
      AND fx_rate_to_usd > 0
      AND fx_rate_to_usd NOT IN (
        'NaN'::numeric,
        'Infinity'::numeric,
        '-Infinity'::numeric
      )
    )
    OR (
      fx_trust_state = 'partial'
      AND (
        fx_rate_to_usd IS NULL
        OR (
          fx_rate_to_usd > 0
          AND fx_rate_to_usd NOT IN (
            'NaN'::numeric,
            'Infinity'::numeric,
            '-Infinity'::numeric
          )
        )
      )
    )
    OR (fx_trust_state = 'unknown' AND fx_rate_to_usd IS NULL)
  )
);

CREATE INDEX idx_token_trade_fact_evidence_recent_closed
  ON arena.token_trade_fact_evidence (closed_at DESC);
CREATE INDEX idx_token_trade_fact_evidence_authority_latest
  ON arena.token_trade_fact_evidence (
    source_id,
    trader_id,
    source_row_identity,
    evidence_id DESC
  );

-- Coverage completeness is generated from typed evaluator output. A writer
-- cannot insert the word "complete": caps, retention limits, unknown
-- evaluation, or insufficient bounds deterministically produce partial or
-- unknown. The view additionally pins the evaluator to the static contract.
CREATE TABLE arena.token_history_coverage_evidence (
  coverage_evidence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contract_id text NOT NULL
    REFERENCES arena.token_trade_source_contracts(contract_id) ON DELETE RESTRICT,
  source_id smallint NOT NULL
    REFERENCES arena.sources(id) ON DELETE RESTRICT,
  trader_id bigint NOT NULL
    REFERENCES arena.traders(id) ON DELETE RESTRICT,
  source_run_id text NOT NULL CHECK (
    source_run_id ~ '^[0-9a-f]{64}$'
    AND source_run_id <> pg_catalog.repeat('0', 64)
  ),
  source_raw_object_id bigint
    REFERENCES arena.raw_objects(id) ON DELETE SET NULL,
  asset_id text NOT NULL
    REFERENCES arena.token_assets(asset_id) ON DELETE RESTRICT,
  normalized_token text NOT NULL CHECK (
    normalized_token = pg_catalog.upper(normalized_token)
    AND normalized_token ~ '^[A-Z0-9]{1,20}$'
    AND normalized_token ~ '[A-Z]'
  ),
  window_days smallint NOT NULL CHECK (window_days IN (7, 30, 90)),
  window_end_at timestamptz NOT NULL,
  window_start_at timestamptz NOT NULL,
  covered_from_at timestamptz,
  covered_through_at timestamptz,
  source_as_of timestamptz NOT NULL,
  evaluator_state text NOT NULL CHECK (evaluator_state IN ('evaluated', 'unknown')),
  scan_terminal_state text NOT NULL CHECK (
    scan_terminal_state IN (
      'exhausted',
      'cursor_overlap',
      'window_prefix_proven',
      'partial',
      'unknown'
    )
  ),
  terminal_cursor_value text,
  overlap_closed_at timestamptz,
  caller_limited boolean NOT NULL,
  page_limited boolean NOT NULL,
  retention_limited boolean NOT NULL,
  observed_closed_row_count bigint CHECK (
    observed_closed_row_count IS NULL OR observed_closed_row_count >= 0
  ),
  coverage_evaluator_method_version text NOT NULL CHECK (
    pg_catalog.btrim(coverage_evaluator_method_version) <> ''
  ),
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  declared_blocker_reasons text[] NOT NULL DEFAULT ARRAY['unreviewed']::text[]
    CHECK (
      pg_catalog.cardinality(declared_blocker_reasons) <= 32
      AND pg_catalog.array_position(declared_blocker_reasons, NULL) IS NULL
    ),
  scan_complete boolean GENERATED ALWAYS AS (
    COALESCE(
      evaluator_state = 'evaluated'
      AND (
        scan_terminal_state = 'exhausted'
        OR (
          scan_terminal_state = 'cursor_overlap'
          AND pg_catalog.btrim(terminal_cursor_value) <> ''
          AND overlap_closed_at <= window_start_at
        )
        OR (
          scan_terminal_state = 'window_prefix_proven'
          AND covered_from_at <= window_start_at
        )
      )
    , false)
  ) STORED,
  history_completeness_state text GENERATED ALWAYS AS (
    CASE
      WHEN evaluator_state = 'unknown' THEN 'unknown'
      WHEN caller_limited
        OR page_limited
        OR retention_limited
        OR NOT COALESCE(
          evaluator_state = 'evaluated'
            AND (
              scan_terminal_state = 'exhausted'
              OR (
                scan_terminal_state = 'cursor_overlap'
                AND pg_catalog.btrim(terminal_cursor_value) <> ''
                AND overlap_closed_at <= window_start_at
              )
              OR (
                scan_terminal_state = 'window_prefix_proven'
                AND covered_from_at <= window_start_at
              )
            )
        , false)
        OR covered_from_at IS NULL
        OR covered_through_at IS NULL
        OR covered_from_at > window_start_at
        OR covered_through_at < window_end_at
        THEN 'partial'
      ELSE 'complete'
    END
  ) STORED,
  CHECK (
    window_start_at = window_end_at - (window_days::integer * interval '1 day')
  ),
  CHECK (
    covered_from_at IS NULL
    OR covered_through_at IS NULL
    OR covered_from_at <= covered_through_at
  ),
  CHECK (covered_through_at IS NULL OR covered_through_at <= source_as_of),
  CHECK (source_as_of <= recorded_at + interval '5 minutes')
);

CREATE INDEX idx_token_history_coverage_latest
  ON arena.token_history_coverage_evidence (
    source_id,
    trader_id,
    asset_id,
    window_days,
    coverage_evidence_id DESC
  );
CREATE INDEX idx_token_history_coverage_run
  ON arena.token_history_coverage_evidence (source_id, source_run_id);

ALTER TABLE arena.token_trade_source_contracts OWNER TO postgres;
ALTER TABLE arena.token_assets OWNER TO postgres;
ALTER TABLE arena.token_trade_contract_assets OWNER TO postgres;
ALTER TABLE arena.token_trade_fx_evidence OWNER TO postgres;
ALTER TABLE arena.token_trade_fact_evidence OWNER TO postgres;
ALTER TABLE arena.token_history_coverage_evidence OWNER TO postgres;

ALTER TABLE arena.token_trade_source_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.token_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.token_trade_contract_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.token_trade_fx_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.token_trade_fact_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.token_history_coverage_evidence ENABLE ROW LEVEL SECURITY;

CREATE POLICY token_trade_source_contracts_service_read
  ON arena.token_trade_source_contracts
  FOR SELECT TO service_role
  USING (true);

CREATE POLICY token_assets_service_read
  ON arena.token_assets
  FOR SELECT TO service_role
  USING (true);
CREATE POLICY token_trade_contract_assets_service_read
  ON arena.token_trade_contract_assets
  FOR SELECT TO service_role
  USING (true);

CREATE POLICY token_trade_fx_evidence_service_read
  ON arena.token_trade_fx_evidence
  FOR SELECT TO service_role
  USING (true);
CREATE POLICY token_trade_fx_evidence_service_append
  ON arena.token_trade_fx_evidence
  FOR INSERT TO service_role
  WITH CHECK (source_raw_object_id IS NOT NULL);

CREATE POLICY token_trade_fact_evidence_service_read
  ON arena.token_trade_fact_evidence
  FOR SELECT TO service_role
  USING (true);
CREATE POLICY token_trade_fact_evidence_service_append
  ON arena.token_trade_fact_evidence
  FOR INSERT TO service_role
  WITH CHECK (source_raw_object_id IS NOT NULL);

CREATE POLICY token_history_coverage_evidence_service_read
  ON arena.token_history_coverage_evidence
  FOR SELECT TO service_role
  USING (true);
CREATE POLICY token_history_coverage_evidence_service_append
  ON arena.token_history_coverage_evidence
  FOR INSERT TO service_role
  WITH CHECK (source_raw_object_id IS NOT NULL);

-- Select the latest attestation before applying any trust predicate. A newer
-- unknown/partial attestation therefore suppresses an older trusted one.
-- Cross joining the three windows makes the default state observable for
-- every legacy position row: no attestation means unknown and never rankable.
CREATE VIEW arena.token_trade_fact_authority_shadow
WITH (security_invoker = true, security_barrier = true)
AS
WITH authority_windows(window_days) AS MATERIALIZED (
  VALUES (7::smallint), (30::smallint), (90::smallint)
), latest_fact_versions AS MATERIALIZED (
  SELECT DISTINCT ON (
    evidence.source_id,
    evidence.trader_id,
    evidence.source_row_identity
  )
    evidence.*
  FROM arena.token_trade_fact_evidence AS evidence
  ORDER BY
    evidence.source_id,
    evidence.trader_id,
    evidence.source_row_identity,
    evidence.evidence_id DESC
), latest_fact_evidence AS MATERIALIZED (
  SELECT latest.*
  FROM latest_fact_versions AS latest
  WHERE latest.closed_at >=
        pg_catalog.statement_timestamp() - interval '90 days'
), latest_coverage_evidence AS MATERIALIZED (
  SELECT DISTINCT ON (
    coverage.source_id,
    coverage.trader_id,
    coverage.asset_id,
    coverage.window_days
  )
    coverage.*
  FROM arena.token_history_coverage_evidence AS coverage
  ORDER BY
    coverage.source_id,
    coverage.trader_id,
    coverage.asset_id,
    coverage.window_days,
    coverage.coverage_evidence_id DESC
), latest_fx_evidence AS MATERIALIZED (
  SELECT DISTINCT ON (
    fx.contract_id,
    fx.base_currency,
    fx.quote_currency,
    fx.price_as_of
  )
    fx.*
  FROM arena.token_trade_fx_evidence AS fx
  ORDER BY
    fx.contract_id,
    fx.base_currency,
    fx.quote_currency,
    fx.price_as_of,
    fx.fx_evidence_id DESC
), fact_bound AS MATERIALIZED (
  SELECT
    fact.source_id,
    source_row.slug AS source_slug,
    fact.trader_id,
    trader.source_id AS trader_source_id,
    trader.exchange_trader_id AS source_trader_id,
    window_row.window_days,
    fact.opened_at,
    fact.closed_at,
    fact.source_symbol,
    fact.entry_price,
    fact.exit_price,
    fact.realized_pnl_source,
    fact.realized_pnl_usd,
    fact.reported_currency,
    fact.position_dedupe_hash,
    fact.source_asset_locator,
    fact.asset_id,
    fact.asset_namespace,
    fact.asset_chain_id,
    fact.asset_protocol_slug,
    fact.token_address,
    fact.normalized_token,
    contract.contract_id AS bound_contract_id,
    contract.active AS contract_active,
    contract.fact_authority_method_version AS contract_fact_method,
    contract.token_normalization_method_version AS contract_token_method,
    contract.lifecycle_marker_rule AS contract_lifecycle_marker_rule,
    contract.closed_lifecycle_marker_literal AS contract_closed_lifecycle_marker,
    contract.fx_method_version AS contract_fx_method,
    contract.coverage_evaluator_method_version AS contract_coverage_method,
    contract.allowed_scan_terminal_states,
    contract.max_coverage_freshness,
    contract.max_window_end_lag,
    contract.max_raw_capture_lag,
    contract.max_fx_price_lag,
    fact.evidence_id,
    fact.contract_id AS fact_contract_id,
    fact.source_run_id AS fact_source_run_id,
    fact.source_raw_object_id AS fact_raw_object_id,
    fact.source_row_identity,
    fact.token_normalization_state,
    fact.token_normalization_method_version,
    fact.lifecycle_state,
    fact.source_lifecycle_marker,
    fact.pnl_provenance,
    fact.pnl_trust_state,
    fact.price_provenance,
    fact.price_trust_state,
    fact.cost_basis_provenance,
    fact.cost_basis_trust_state,
    fact.fx_provenance,
    fact.fx_trust_state,
    fact.fx_evidence_id,
    fact.fx_rate_to_usd AS fact_fx_rate_to_usd,
    fact.authority_method_version,
    fact.recorded_at AS fact_recorded_at,
    fact.declared_blocker_reasons AS fact_declared_blockers,
    fact_raw.id AS bound_fact_raw_id,
    fact_raw.fetched_at AS fact_raw_fetched_at,
    fact_raw.quarantined AS fact_raw_quarantined,
    fact_fx.fx_evidence_id AS bound_fx_evidence_id,
    latest_fx.fx_evidence_id AS latest_fx_evidence_id,
    fact_fx.source_run_id AS fx_source_run_id,
    fact_fx.source_raw_object_id AS fx_raw_object_id,
    fact_fx.fx_rate_to_usd AS evidence_fx_rate_to_usd,
    fact_fx.price_as_of AS fx_price_as_of,
    fact_fx.fx_provenance AS evidence_fx_provenance,
    fact_fx.fx_trust_state AS evidence_fx_trust_state,
    fact_fx.fx_method_version AS evidence_fx_method_version,
    fact_fx.recorded_at AS fx_recorded_at,
    fact_fx.declared_blocker_reasons AS fx_declared_blockers,
    fx_raw.id AS bound_fx_raw_id,
    fx_raw.fetched_at AS fx_raw_fetched_at,
    fx_raw.quarantined AS fx_raw_quarantined,
    mapping.asset_id AS mapped_asset_id,
    asset.asset_id AS bound_asset_id,
    asset.asset_namespace AS registry_asset_namespace,
    asset.chain_id AS registry_asset_chain_id,
    asset.protocol_slug AS registry_asset_protocol_slug,
    asset.token_address AS registry_token_address,
    asset.canonical_ticker AS registry_canonical_ticker,
    asset.active AS registry_asset_active,
    coverage.coverage_evidence_id,
    coverage.contract_id AS coverage_contract_id,
    coverage.source_run_id AS coverage_source_run_id,
    coverage.source_raw_object_id AS coverage_raw_object_id,
    coverage.asset_id AS coverage_asset_id,
    coverage.normalized_token AS coverage_normalized_token,
    coverage.window_start_at,
    coverage.window_end_at,
    coverage.covered_from_at,
    coverage.covered_through_at,
    coverage.source_as_of,
    coverage.evaluator_state,
    coverage.scan_terminal_state,
    coverage.scan_complete,
    coverage.caller_limited,
    coverage.page_limited,
    coverage.retention_limited,
    coverage.observed_closed_row_count,
    coverage.history_completeness_state,
    coverage.coverage_evaluator_method_version,
    coverage.recorded_at AS coverage_recorded_at,
    coverage.declared_blocker_reasons AS coverage_declared_blockers,
    coverage_raw.id AS bound_coverage_raw_id,
    coverage_raw.fetched_at AS coverage_raw_fetched_at,
    coverage_raw.quarantined AS coverage_raw_quarantined,
    source_row.status AS source_status,
    source_row.serving_mode AS source_serving_mode,
    source_row.adapter_slug AS source_adapter_slug,
    source_row.product_type AS source_product_type,
    source_row.currency AS source_registry_currency,
    contract.source_slug AS contract_source_slug,
    contract.adapter_slug AS contract_adapter_slug,
    contract.product_type AS contract_product_type,
    contract.native_currency AS contract_native_currency,
    contract.pnl_provenance AS contract_pnl_provenance,
    contract.price_provenance AS contract_price_provenance,
    contract.cost_basis_provenance AS contract_cost_basis_provenance,
    contract.fx_provenance AS contract_fx_provenance,
    contract.required_pnl_trust_state,
    contract.required_price_trust_state,
    contract.required_cost_basis_trust_state,
    contract.required_fx_trust_state,
    legacy_projection.dedupe_hash IS NOT NULL AS legacy_projection_found,
    legacy_projection.opened_at AS legacy_opened_at,
    legacy_projection.symbol AS legacy_symbol,
    legacy_projection.entry_price AS legacy_entry_price,
    legacy_projection.exit_price AS legacy_exit_price,
    legacy_projection.realized_pnl AS legacy_realized_pnl,
    legacy_projection.currency AS legacy_currency
  FROM latest_fact_evidence AS fact
  JOIN arena.traders AS trader
    ON trader.id = fact.trader_id
  JOIN arena.sources AS source_row
    ON source_row.id = fact.source_id
  CROSS JOIN authority_windows AS window_row
  LEFT JOIN arena.token_trade_source_contracts AS contract
    ON contract.source_id = fact.source_id
   AND contract.contract_id = fact.contract_id
  LEFT JOIN arena.token_trade_contract_assets AS mapping
    ON mapping.contract_id = contract.contract_id
   AND mapping.source_asset_locator = fact.source_asset_locator
   AND mapping.source_asset_locator = fact.source_symbol
   AND mapping.source_base_asset = fact.normalized_token
   AND mapping.asset_id = fact.asset_id
  LEFT JOIN arena.token_assets AS asset
    ON asset.asset_id = fact.asset_id
  LEFT JOIN arena.raw_objects AS fact_raw
    ON fact_raw.id = fact.source_raw_object_id
   AND fact_raw.source_id = fact.source_id
   AND fact_raw.trader_id = fact.trader_id
   AND fact_raw.source_run_id = fact.source_run_id
   AND fact_raw.content_hash = fact.source_run_id
   AND fact_raw.trust_artifact_role = contract.required_raw_artifact_role
   AND fact_raw.job_type = contract.required_raw_job_type
  LEFT JOIN arena.token_trade_fx_evidence AS fact_fx
    ON fact_fx.fx_evidence_id = fact.fx_evidence_id
   AND fact_fx.contract_id = contract.contract_id
   AND fact_fx.source_id = fact.source_id
  LEFT JOIN latest_fx_evidence AS latest_fx
    ON latest_fx.contract_id = fact_fx.contract_id
   AND latest_fx.base_currency = fact_fx.base_currency
   AND latest_fx.quote_currency = fact_fx.quote_currency
   AND latest_fx.price_as_of = fact_fx.price_as_of
  LEFT JOIN arena.raw_objects AS fx_raw
    ON fx_raw.id = fact_fx.source_raw_object_id
   AND fx_raw.source_id = fact_fx.source_id
   AND fx_raw.trader_id IS NULL
   AND fx_raw.source_run_id = fact_fx.source_run_id
   AND fx_raw.content_hash = fact_fx.source_run_id
   AND fx_raw.trust_artifact_role = 'price_history'
   AND fx_raw.job_type = 'price_history:USDT-USD'
  LEFT JOIN latest_coverage_evidence AS coverage
    ON coverage.source_id = fact.source_id
   AND coverage.trader_id = fact.trader_id
   AND coverage.asset_id = fact.asset_id
   AND coverage.window_days = window_row.window_days
  LEFT JOIN arena.raw_objects AS coverage_raw
    ON coverage_raw.id = coverage.source_raw_object_id
   AND coverage_raw.source_id = coverage.source_id
   AND coverage_raw.trader_id = coverage.trader_id
   AND coverage_raw.source_run_id = coverage.source_run_id
   AND coverage_raw.content_hash = coverage.source_run_id
   AND coverage_raw.trust_artifact_role = contract.required_raw_artifact_role
   AND coverage_raw.job_type = contract.required_raw_job_type
  LEFT JOIN arena.position_history AS legacy_projection
    ON legacy_projection.trader_id = fact.trader_id
   AND legacy_projection.closed_at = fact.closed_at
   AND legacy_projection.dedupe_hash = fact.position_dedupe_hash
), fact_evaluated AS (
  SELECT
    fact_bound.*,
    pg_catalog.array_remove(ARRAY[
      CASE WHEN fact_bound.source_status <> 'active' THEN 'source_not_active' END,
      CASE WHEN fact_bound.source_serving_mode <> 'serving'
        THEN 'source_not_serving' END,
      CASE WHEN fact_bound.bound_contract_id IS NULL
        THEN 'source_contract_missing' END,
      CASE WHEN fact_bound.contract_active IS NOT TRUE
        THEN 'source_contract_inactive' END,
      CASE WHEN fact_bound.source_slug IS DISTINCT FROM fact_bound.contract_source_slug
        OR fact_bound.source_adapter_slug
          IS DISTINCT FROM fact_bound.contract_adapter_slug
        OR fact_bound.source_product_type
          IS DISTINCT FROM fact_bound.contract_product_type
        OR fact_bound.source_registry_currency
          IS DISTINCT FROM fact_bound.contract_native_currency
        THEN 'source_contract_registry_mismatch' END,
      CASE WHEN fact_bound.trader_source_id IS DISTINCT FROM fact_bound.source_id
        OR fact_bound.fact_contract_id IS DISTINCT FROM fact_bound.bound_contract_id
        THEN 'fact_contract_or_identity_mismatch' END,
      CASE WHEN fact_bound.bound_fact_raw_id IS NULL
        THEN 'fact_raw_lineage_mismatch' END,
      CASE WHEN fact_bound.fact_raw_quarantined
        THEN 'fact_raw_quarantined' END,
      CASE WHEN fact_bound.fact_raw_fetched_at
          > fact_bound.fact_recorded_at + interval '5 minutes'
        THEN 'fact_raw_capture_time_mismatch' END,
      CASE WHEN fact_bound.legacy_projection_found
        AND (
          fact_bound.opened_at IS DISTINCT FROM fact_bound.legacy_opened_at
          OR fact_bound.source_symbol IS DISTINCT FROM fact_bound.legacy_symbol
          OR fact_bound.entry_price IS DISTINCT FROM fact_bound.legacy_entry_price
          OR fact_bound.exit_price IS DISTINCT FROM fact_bound.legacy_exit_price
          OR fact_bound.realized_pnl_source
            IS DISTINCT FROM fact_bound.legacy_realized_pnl
          OR fact_bound.reported_currency IS DISTINCT FROM fact_bound.legacy_currency
        ) THEN 'legacy_projection_mismatch' END,
      CASE WHEN fact_bound.closed_at IS NULL THEN 'closed_at_unknown' END,
      CASE WHEN fact_bound.opened_at IS NULL THEN 'opened_at_unknown' END,
      CASE WHEN fact_bound.lifecycle_state = 'partial'
        THEN 'lifecycle_partial' END,
      CASE WHEN fact_bound.lifecycle_state IS DISTINCT FROM 'closed'
        AND fact_bound.lifecycle_state IS DISTINCT FROM 'partial'
        THEN 'lifecycle_unknown' END,
      CASE
        WHEN fact_bound.source_lifecycle_marker IS NULL
          THEN 'source_lifecycle_marker_unknown'
        WHEN fact_bound.contract_lifecycle_marker_rule = 'exact_literal'
          AND fact_bound.source_lifecycle_marker IS DISTINCT FROM
            fact_bound.contract_closed_lifecycle_marker
          THEN 'source_lifecycle_marker_mismatch'
        WHEN fact_bound.contract_lifecycle_marker_rule = 'positive_epoch_ms'
          AND CASE
            WHEN fact_bound.source_lifecycle_marker !~ '^[1-9][0-9]{9,12}$'
              THEN true
            ELSE TIMESTAMPTZ 'epoch' +
              (fact_bound.source_lifecycle_marker::bigint * interval '1 millisecond')
              IS DISTINCT FROM fact_bound.closed_at
          END
          THEN 'source_lifecycle_marker_mismatch'
        WHEN fact_bound.contract_lifecycle_marker_rule IS NULL
          THEN 'source_lifecycle_marker_contract_missing'
      END,
      CASE WHEN fact_bound.token_normalization_state IS DISTINCT FROM 'normalized'
        OR fact_bound.normalized_token IS NULL
        THEN 'token_normalization_unknown' END,
      CASE WHEN fact_bound.token_normalization_method_version
          IS DISTINCT FROM fact_bound.contract_token_method
        THEN 'token_normalization_method_mismatch' END,
      CASE WHEN fact_bound.mapped_asset_id IS NULL
        OR fact_bound.bound_asset_id IS NULL
        OR fact_bound.registry_asset_active IS NOT TRUE
        OR fact_bound.asset_namespace
          IS DISTINCT FROM fact_bound.registry_asset_namespace
        OR fact_bound.asset_chain_id
          IS DISTINCT FROM fact_bound.registry_asset_chain_id
        OR fact_bound.asset_protocol_slug
          IS DISTINCT FROM fact_bound.registry_asset_protocol_slug
        OR fact_bound.token_address
          IS DISTINCT FROM fact_bound.registry_token_address
        OR fact_bound.normalized_token
          IS DISTINCT FROM fact_bound.registry_canonical_ticker
        THEN 'canonical_asset_mapping_mismatch' END,
      CASE WHEN fact_bound.source_symbol
          IS DISTINCT FROM fact_bound.source_asset_locator
        THEN 'source_instrument_mapping_mismatch' END,
      CASE WHEN fact_bound.reported_currency
          IS DISTINCT FROM fact_bound.contract_native_currency
        THEN 'currency_contract_mismatch' END,
      CASE WHEN fact_bound.authority_method_version
          IS DISTINCT FROM fact_bound.contract_fact_method
        OR fact_bound.pnl_provenance
          IS DISTINCT FROM fact_bound.contract_pnl_provenance
        OR fact_bound.price_provenance
          IS DISTINCT FROM fact_bound.contract_price_provenance
        OR fact_bound.cost_basis_provenance
          IS DISTINCT FROM fact_bound.contract_cost_basis_provenance
        OR fact_bound.fx_provenance
          IS DISTINCT FROM fact_bound.contract_fx_provenance
        THEN 'fact_method_or_provenance_mismatch' END,
      CASE WHEN fact_bound.pnl_trust_state
          IS DISTINCT FROM fact_bound.required_pnl_trust_state
        OR fact_bound.realized_pnl_source IS NULL
        OR fact_bound.realized_pnl_usd IS NULL
        THEN 'pnl_unknown' END,
      CASE WHEN fact_bound.price_trust_state
          IS DISTINCT FROM fact_bound.required_price_trust_state
        OR fact_bound.entry_price IS NULL
        OR fact_bound.exit_price IS NULL
        THEN 'price_unknown' END,
      CASE WHEN fact_bound.cost_basis_trust_state
          IS DISTINCT FROM fact_bound.required_cost_basis_trust_state
        OR fact_bound.entry_price IS NULL
        THEN 'cost_basis_unknown' END,
      CASE WHEN fact_bound.fx_trust_state
          IS DISTINCT FROM fact_bound.required_fx_trust_state
        THEN 'fx_unknown' END,
      CASE WHEN fact_bound.bound_fx_evidence_id IS NULL
        THEN 'fx_evidence_missing' END,
      CASE WHEN fact_bound.latest_fx_evidence_id
          IS DISTINCT FROM fact_bound.bound_fx_evidence_id
        THEN 'fx_evidence_superseded' END,
      CASE WHEN fact_bound.fact_fx_rate_to_usd
          IS DISTINCT FROM fact_bound.evidence_fx_rate_to_usd
        OR fact_bound.evidence_fx_provenance
          IS DISTINCT FROM fact_bound.contract_fx_provenance
        OR fact_bound.evidence_fx_trust_state
          IS DISTINCT FROM fact_bound.required_fx_trust_state
        OR fact_bound.evidence_fx_method_version
          IS DISTINCT FROM fact_bound.contract_fx_method
        THEN 'fx_evidence_contract_mismatch' END,
      CASE WHEN fact_bound.bound_fx_raw_id IS NULL
        THEN 'fx_raw_lineage_mismatch' END,
      CASE WHEN fact_bound.fx_raw_quarantined
        THEN 'fx_raw_quarantined' END,
      CASE WHEN fact_bound.fx_raw_fetched_at
          > fact_bound.fx_recorded_at + interval '5 minutes'
        OR fact_bound.fx_raw_fetched_at
          < fact_bound.fx_price_as_of - interval '5 minutes'
        THEN 'fx_raw_capture_time_mismatch' END,
      CASE WHEN fact_bound.fx_recorded_at
          > pg_catalog.statement_timestamp() + interval '5 minutes'
        THEN 'fx_evidence_future' END,
      CASE WHEN fact_bound.fx_price_as_of
          < fact_bound.closed_at - fact_bound.max_fx_price_lag
        OR fact_bound.fx_price_as_of
          > fact_bound.closed_at + fact_bound.max_fx_price_lag
        THEN 'fx_price_time_mismatch' END,
      CASE WHEN fact_bound.fact_recorded_at
          > pg_catalog.statement_timestamp() + interval '5 minutes'
        THEN 'fact_evidence_future' END,
      CASE WHEN fact_bound.coverage_evidence_id IS NULL
        THEN 'history_coverage_missing' END,
      CASE WHEN fact_bound.coverage_contract_id
          IS DISTINCT FROM fact_bound.bound_contract_id
        OR fact_bound.coverage_asset_id IS DISTINCT FROM fact_bound.asset_id
        OR fact_bound.coverage_normalized_token
          IS DISTINCT FROM fact_bound.normalized_token
        THEN 'coverage_contract_mismatch' END,
      CASE WHEN fact_bound.coverage_source_run_id
          IS DISTINCT FROM fact_bound.fact_source_run_id
        OR fact_bound.coverage_raw_object_id
          IS DISTINCT FROM fact_bound.fact_raw_object_id
        THEN 'coverage_fact_run_mismatch' END,
      CASE WHEN fact_bound.bound_coverage_raw_id IS NULL
        THEN 'coverage_raw_lineage_mismatch' END,
      CASE WHEN fact_bound.coverage_raw_quarantined
        THEN 'coverage_raw_quarantined' END,
      CASE WHEN fact_bound.coverage_raw_fetched_at
          > fact_bound.coverage_recorded_at + interval '5 minutes'
        OR fact_bound.coverage_raw_fetched_at
          > fact_bound.source_as_of + interval '5 minutes'
        OR fact_bound.coverage_raw_fetched_at
          < fact_bound.source_as_of - fact_bound.max_raw_capture_lag
        THEN 'coverage_raw_capture_time_mismatch' END,
      CASE WHEN fact_bound.coverage_evaluator_method_version
          IS DISTINCT FROM fact_bound.contract_coverage_method
        THEN 'coverage_evaluator_method_mismatch' END,
      CASE WHEN fact_bound.scan_terminal_state <> ALL (
          COALESCE(fact_bound.allowed_scan_terminal_states, ARRAY[]::text[])
        ) OR fact_bound.scan_complete IS NOT TRUE
        THEN 'history_scan_incomplete' END,
      CASE WHEN fact_bound.history_completeness_state = 'unknown'
        OR fact_bound.evaluator_state IS DISTINCT FROM 'evaluated'
        THEN 'history_unknown' END,
      CASE WHEN fact_bound.history_completeness_state = 'partial'
        THEN 'history_partial' END,
      CASE WHEN fact_bound.caller_limited THEN 'history_caller_limited' END,
      CASE WHEN fact_bound.page_limited THEN 'history_page_limited' END,
      CASE WHEN fact_bound.retention_limited
        THEN 'history_retention_limited' END,
      CASE WHEN fact_bound.covered_from_at IS NULL
        OR fact_bound.covered_through_at IS NULL
        OR fact_bound.covered_from_at > fact_bound.window_start_at
        OR fact_bound.covered_through_at < fact_bound.window_end_at
        THEN 'history_bounds_incomplete' END,
      CASE WHEN fact_bound.covered_through_at > fact_bound.source_as_of
        THEN 'history_bounds_after_source_as_of' END,
      CASE WHEN fact_bound.observed_closed_row_count IS NULL
        OR fact_bound.observed_closed_row_count < 1
        THEN 'history_fact_absent' END,
      CASE WHEN fact_bound.closed_at <= fact_bound.window_start_at
        OR fact_bound.closed_at > fact_bound.window_end_at
        THEN 'trade_outside_window' END,
      CASE WHEN fact_bound.window_end_at > fact_bound.source_as_of
        OR fact_bound.source_as_of - fact_bound.window_end_at
          > fact_bound.max_window_end_lag
        THEN 'window_end_source_as_of_mismatch' END,
      CASE WHEN fact_bound.source_as_of
          > pg_catalog.statement_timestamp() + interval '5 minutes'
        OR fact_bound.coverage_recorded_at
          > pg_catalog.statement_timestamp() + interval '5 minutes'
        THEN 'coverage_future' END,
      CASE WHEN fact_bound.source_as_of IS NULL
        OR fact_bound.max_coverage_freshness IS NULL
        OR fact_bound.source_as_of
          < pg_catalog.statement_timestamp() - fact_bound.max_coverage_freshness
        THEN 'coverage_stale' END
    ]::text[], NULL)
    || COALESCE(fact_bound.fact_declared_blockers, ARRAY[]::text[])
    || COALESCE(fact_bound.fx_declared_blockers, ARRAY[]::text[])
    || COALESCE(fact_bound.coverage_declared_blockers, ARRAY[]::text[])
      AS blocker_reasons
  FROM fact_bound
), fact_rows AS (
SELECT
  evaluated.source_id,
  evaluated.source_slug,
  evaluated.trader_id,
  evaluated.source_trader_id,
  evaluated.window_days,
  evaluated.fact_source_run_id AS source_run_id,
  evaluated.fact_raw_object_id AS source_raw_object_id,
  evaluated.source_row_identity,
  evaluated.position_dedupe_hash,
  evaluated.asset_id,
  evaluated.asset_namespace,
  evaluated.asset_chain_id,
  evaluated.asset_protocol_slug,
  evaluated.token_address,
  evaluated.normalized_token AS token,
  evaluated.source_symbol,
  evaluated.opened_at,
  evaluated.closed_at,
  evaluated.reported_currency,
  evaluated.realized_pnl_source,
  evaluated.realized_pnl_usd,
  evaluated.lifecycle_state,
  evaluated.source_lifecycle_marker,
  COALESCE(evaluated.history_completeness_state, 'unknown')
    AS history_completeness_state,
  COALESCE(evaluated.token_normalization_state, 'unknown')
    AS token_normalization_state,
  COALESCE(evaluated.price_trust_state, 'unknown') AS price_trust_state,
  COALESCE(evaluated.cost_basis_trust_state, 'unknown') AS cost_basis_trust_state,
  COALESCE(evaluated.fx_trust_state, 'unknown') AS fx_trust_state,
  evaluated.window_start_at,
  evaluated.window_end_at,
  evaluated.source_as_of,
  evaluated.contract_fact_method AS authority_method_version,
  evaluated.contract_coverage_method AS coverage_evaluator_method_version,
  CASE WHEN evaluated.legacy_projection_found THEN 'matched' ELSE 'missing' END
    AS legacy_projection_state,
  CASE
    WHEN pg_catalog.cardinality(evaluated.blocker_reasons) = 0 THEN 'complete'
    ELSE 'partial'
  END AS authority_state,
  evaluated.blocker_reasons,
  pg_catalog.cardinality(evaluated.blocker_reasons) = 0 AS rank_eligible
FROM fact_evaluated AS evaluated
), legacy_rows AS (
  SELECT
    trader.source_id,
    source_row.slug AS source_slug,
    position.trader_id,
    trader.exchange_trader_id AS source_trader_id,
    window_row.window_days,
    NULL::text AS source_run_id,
    NULL::bigint AS source_raw_object_id,
    NULL::text AS source_row_identity,
    position.dedupe_hash AS position_dedupe_hash,
    NULL::text AS asset_id,
    NULL::text AS asset_namespace,
    NULL::text AS asset_chain_id,
    NULL::text AS asset_protocol_slug,
    NULL::text AS token_address,
    NULL::text AS token,
    position.symbol AS source_symbol,
    position.opened_at,
    position.closed_at,
    position.currency AS reported_currency,
    position.realized_pnl AS realized_pnl_source,
    NULL::numeric AS realized_pnl_usd,
    'unknown'::text AS lifecycle_state,
    NULL::text AS source_lifecycle_marker,
    'unknown'::text AS history_completeness_state,
    'unknown'::text AS token_normalization_state,
    'unknown'::text AS price_trust_state,
    'unknown'::text AS cost_basis_trust_state,
    'unknown'::text AS fx_trust_state,
    NULL::timestamptz AS window_start_at,
    NULL::timestamptz AS window_end_at,
    NULL::timestamptz AS source_as_of,
    NULL::text AS authority_method_version,
    NULL::text AS coverage_evaluator_method_version,
    'legacy_only'::text AS legacy_projection_state,
    'unknown'::text AS authority_state,
    ARRAY['legacy_position_unattested']::text[] AS blocker_reasons,
    false AS rank_eligible
  FROM arena.position_history AS position
  JOIN arena.traders AS trader
    ON trader.id = position.trader_id
  JOIN arena.sources AS source_row
    ON source_row.id = trader.source_id
  CROSS JOIN authority_windows AS window_row
  WHERE position.closed_at >=
        pg_catalog.statement_timestamp() - interval '90 days'
    AND NOT EXISTS (
      SELECT 1
      FROM latest_fact_evidence AS fact
      WHERE fact.trader_id = position.trader_id
        AND fact.closed_at = position.closed_at
        AND fact.position_dedupe_hash = position.dedupe_hash
    )
)
SELECT * FROM fact_rows
UNION ALL
SELECT * FROM legacy_rows;

ALTER VIEW arena.token_trade_fact_authority_shadow OWNER TO postgres;

REVOKE ALL ON TABLE arena.token_trade_source_contracts
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE arena.token_trade_source_contracts TO service_role;

REVOKE ALL ON TABLE arena.token_assets
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE arena.token_assets TO service_role;

REVOKE ALL ON TABLE arena.token_trade_contract_assets
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE arena.token_trade_contract_assets TO service_role;

REVOKE ALL ON TABLE arena.token_trade_fx_evidence
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE arena.token_trade_fx_evidence TO service_role;
GRANT INSERT (
  contract_id,
  source_id,
  source_run_id,
  source_raw_object_id,
  base_currency,
  quote_currency,
  fx_rate_to_usd,
  price_as_of,
  fx_provenance,
  fx_trust_state,
  fx_method_version,
  declared_blocker_reasons
) ON arena.token_trade_fx_evidence TO service_role;

REVOKE ALL ON TABLE arena.token_trade_fact_evidence
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE arena.token_trade_fact_evidence TO service_role;
GRANT INSERT (
  contract_id,
  source_id,
  trader_id,
  source_run_id,
  source_raw_object_id,
  source_row_identity,
  closed_at,
  position_dedupe_hash,
  source_symbol,
  source_asset_locator,
  asset_id,
  asset_namespace,
  asset_chain_id,
  asset_protocol_slug,
  token_address,
  normalized_token,
  token_normalization_state,
  token_normalization_method_version,
  opened_at,
  entry_price,
  exit_price,
  realized_pnl_source,
  reported_currency,
  fx_evidence_id,
  fx_rate_to_usd,
  lifecycle_state,
  source_lifecycle_marker,
  pnl_provenance,
  pnl_trust_state,
  price_provenance,
  price_trust_state,
  cost_basis_provenance,
  cost_basis_trust_state,
  fx_provenance,
  fx_trust_state,
  authority_method_version,
  declared_blocker_reasons
) ON arena.token_trade_fact_evidence TO service_role;

REVOKE ALL ON TABLE arena.token_history_coverage_evidence
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE arena.token_history_coverage_evidence TO service_role;
GRANT INSERT (
  contract_id,
  source_id,
  trader_id,
  source_run_id,
  source_raw_object_id,
  asset_id,
  normalized_token,
  window_days,
  window_end_at,
  window_start_at,
  covered_from_at,
  covered_through_at,
  source_as_of,
  evaluator_state,
  scan_terminal_state,
  terminal_cursor_value,
  overlap_closed_at,
  caller_limited,
  page_limited,
  retention_limited,
  observed_closed_row_count,
  coverage_evaluator_method_version,
  declared_blocker_reasons
) ON arena.token_history_coverage_evidence TO service_role;

REVOKE ALL ON SEQUENCE arena.token_trade_fact_evidence_evidence_id_seq
  FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE, SELECT
  ON SEQUENCE arena.token_trade_fact_evidence_evidence_id_seq
  TO service_role;

REVOKE ALL ON SEQUENCE arena.token_trade_fx_evidence_fx_evidence_id_seq
  FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE, SELECT
  ON SEQUENCE arena.token_trade_fx_evidence_fx_evidence_id_seq
  TO service_role;

REVOKE ALL ON SEQUENCE arena.token_history_coverage_evidence_coverage_evidence_id_seq
  FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE, SELECT
  ON SEQUENCE arena.token_history_coverage_evidence_coverage_evidence_id_seq
  TO service_role;

REVOKE ALL ON TABLE arena.token_trade_fact_authority_shadow
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE arena.token_trade_fact_authority_shadow TO service_role;

DO $postflight$
DECLARE
  v_view_options text[];
BEGIN
  SELECT relation.reloptions
    INTO STRICT v_view_options
    FROM pg_catalog.pg_class AS relation
   WHERE relation.oid =
         'arena.token_trade_fact_authority_shadow'::pg_catalog.regclass
     AND relation.relkind = 'v'
     AND relation.relowner = 'postgres'::pg_catalog.regrole;

  IF v_view_options IS NULL
     OR NOT ('security_invoker=true' = ANY (v_view_options))
     OR NOT ('security_barrier=true' = ANY (v_view_options)) THEN
    RAISE EXCEPTION 'token trade authority shadow view security options drifted';
  END IF;

  IF (SELECT pg_catalog.count(*)
        FROM arena.token_trade_source_contracts) <> 2
     OR (SELECT pg_catalog.count(*)
           FROM arena.token_assets
          WHERE asset_namespace = 'cex') <> 15
     OR (SELECT pg_catalog.count(*)
           FROM arena.token_assets
          WHERE canonical_ticker = 'USDC'
            AND asset_namespace = 'evm') <> 2
     OR (SELECT pg_catalog.count(*)
           FROM arena.token_trade_contract_assets) <> 30
     OR NOT pg_catalog.has_table_privilege(
       'service_role', 'arena.token_trade_source_contracts', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'arena.token_trade_source_contracts', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'arena.token_trade_source_contracts', 'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'arena.token_trade_source_contracts', 'DELETE'
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role', 'arena.token_assets', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'arena.token_assets', 'INSERT, UPDATE, DELETE, TRUNCATE'
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role', 'arena.token_trade_contract_assets', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'arena.token_trade_contract_assets',
       'INSERT, UPDATE, DELETE, TRUNCATE'
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role', 'arena.token_trade_fx_evidence', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'arena.token_trade_fx_evidence', 'INSERT'
     )
     OR NOT pg_catalog.has_any_column_privilege(
       'service_role', 'arena.token_trade_fx_evidence', 'INSERT'
     )
     OR pg_catalog.has_column_privilege(
       'service_role', 'arena.token_trade_fx_evidence', 'fx_evidence_id', 'INSERT'
     )
     OR pg_catalog.has_column_privilege(
       'service_role', 'arena.token_trade_fx_evidence', 'recorded_at', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'arena.token_trade_fx_evidence',
       'UPDATE, DELETE, TRUNCATE'
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role', 'arena.token_trade_fact_evidence', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'arena.token_trade_fact_evidence', 'INSERT'
     )
     OR NOT pg_catalog.has_any_column_privilege(
       'service_role', 'arena.token_trade_fact_evidence', 'INSERT'
     )
     OR pg_catalog.has_column_privilege(
       'service_role', 'arena.token_trade_fact_evidence', 'evidence_id', 'INSERT'
     )
     OR pg_catalog.has_column_privilege(
       'service_role', 'arena.token_trade_fact_evidence', 'realized_pnl_usd', 'INSERT'
     )
     OR pg_catalog.has_column_privilege(
       'service_role', 'arena.token_trade_fact_evidence', 'recorded_at', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'arena.token_trade_fact_evidence', 'UPDATE, DELETE, TRUNCATE'
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role', 'arena.token_history_coverage_evidence', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'arena.token_history_coverage_evidence', 'INSERT'
     )
     OR NOT pg_catalog.has_any_column_privilege(
       'service_role', 'arena.token_history_coverage_evidence', 'INSERT'
     )
     OR pg_catalog.has_column_privilege(
       'service_role', 'arena.token_history_coverage_evidence',
       'coverage_evidence_id', 'INSERT'
     )
     OR pg_catalog.has_column_privilege(
       'service_role', 'arena.token_history_coverage_evidence',
       'scan_complete', 'INSERT'
     )
     OR pg_catalog.has_column_privilege(
       'service_role', 'arena.token_history_coverage_evidence',
       'history_completeness_state', 'INSERT'
     )
     OR pg_catalog.has_column_privilege(
       'service_role', 'arena.token_history_coverage_evidence', 'recorded_at', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'arena.token_history_coverage_evidence',
       'UPDATE, DELETE, TRUNCATE'
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role', 'arena.token_trade_fact_authority_shadow', 'SELECT'
     ) THEN
    RAISE EXCEPTION 'token trade authority service_role ACL drifted';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (VALUES ('anon'::text), ('authenticated'::text)) AS role_name(name)
     WHERE pg_catalog.has_table_privilege(
       role_name.name,
       'arena.token_trade_source_contracts',
       'SELECT, INSERT, UPDATE, DELETE, TRUNCATE'
     )
        OR pg_catalog.has_table_privilege(
       role_name.name,
       'arena.token_assets',
       'SELECT, INSERT, UPDATE, DELETE, TRUNCATE'
     )
        OR pg_catalog.has_table_privilege(
       role_name.name,
       'arena.token_trade_contract_assets',
       'SELECT, INSERT, UPDATE, DELETE, TRUNCATE'
     )
        OR pg_catalog.has_table_privilege(
       role_name.name,
       'arena.token_trade_fx_evidence',
       'SELECT, INSERT, UPDATE, DELETE, TRUNCATE'
     )
        OR pg_catalog.has_table_privilege(
       role_name.name,
       'arena.token_trade_fact_evidence',
       'SELECT, INSERT, UPDATE, DELETE, TRUNCATE'
     )
        OR pg_catalog.has_table_privilege(
       role_name.name,
       'arena.token_history_coverage_evidence',
       'SELECT, INSERT, UPDATE, DELETE, TRUNCATE'
     )
        OR pg_catalog.has_table_privilege(
       role_name.name,
       'arena.token_trade_fact_authority_shadow',
       'SELECT'
     )
  ) THEN
    RAISE EXCEPTION 'token trade authority public ACL drifted';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS relation
     WHERE relation.oid = ANY (ARRAY[
       'arena.token_trade_source_contracts'::pg_catalog.regclass,
       'arena.token_assets'::pg_catalog.regclass,
       'arena.token_trade_contract_assets'::pg_catalog.regclass,
       'arena.token_trade_fx_evidence'::pg_catalog.regclass,
       'arena.token_trade_fact_evidence'::pg_catalog.regclass,
       'arena.token_history_coverage_evidence'::pg_catalog.regclass
     ])
       AND (
         relation.relowner <> 'postgres'::pg_catalog.regrole
         OR NOT relation.relrowsecurity
       )
  ) THEN
    RAISE EXCEPTION 'token trade authority table ownership/RLS drifted';
  END IF;
END
$postflight$;

COMMENT ON TABLE arena.token_trade_source_contracts IS
  'Migration-owned reviewed Binance/OKX token fact semantics. Service writers can read but cannot mutate contracts.';
COMMENT ON TABLE arena.token_assets IS
  'Migration-owned canonical asset identities. Display tickers are not keys; on-chain identities include namespace, chain, and exact address.';
COMMENT ON TABLE arena.token_trade_contract_assets IS
  'Reviewed per-source asset locators mapped to canonical asset identities; service evidence writers cannot mutate mappings.';
COMMENT ON TABLE arena.token_trade_fx_evidence IS
  'Append-only USDT/USD price-history evidence. A distinct immutable price_history RAW digest is required before USD PnL can be trusted.';
COMMENT ON TABLE arena.token_trade_fact_evidence IS
  'Append-only typed token-trade attestations. Defaults fail closed; trust is accepted only through the static source contract and exact event_history RAW digest lineage.';
COMMENT ON TABLE arena.token_history_coverage_evidence IS
  'Append-only 7/30/90-day history evaluations. Completeness is generated from typed bounds and cap flags, then contract- and RAW-bound by the shadow view.';
COMMENT ON VIEW arena.token_trade_fact_authority_shadow IS
  'Private shadow-only token trade authority. Legacy/no-evidence rows remain unknown and rank_eligible=false; no public ranking cutover.';

NOTIFY pgrst, 'reload schema';

COMMIT;
