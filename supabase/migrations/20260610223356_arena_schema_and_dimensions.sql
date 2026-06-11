-- Migration: 20260610223356_arena_schema_and_dimensions.sql
-- Created: 2026-06-11T05:33:56Z
-- Description: ARENA_DATA_SPEC v1.2 §3 — new canonical `arena` schema (M1 of 6):
--   dimension tables exchanges + sources + source_secrets, seeded with the
--   exchanges/sources from spec §7. Runs alongside legacy public.* tables
--   (parallel build; per-source cutover via sources.serving_mode).
--
-- Deploy note: `arena` must be added to PostgREST exposed schemas
--   (supabase/config.toml [api].schemas for local; Dashboard → Settings →
--   API → Exposed schemas for hosted) before app reads can work.

-- ============================================================
-- Schema
-- ============================================================
CREATE SCHEMA IF NOT EXISTS arena;
GRANT USAGE ON SCHEMA arena TO anon, authenticated, service_role;

-- Future tables: service_role full access by default; anon/authenticated get
-- SELECT grants (RLS policies in M6 are the actual per-table gate).
ALTER DEFAULT PRIVILEGES IN SCHEMA arena
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA arena
  GRANT SELECT ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA arena
  GRANT USAGE, SELECT ON SEQUENCES TO service_role;

-- ============================================================
-- arena.exchanges — one row per exchange/protocol (spec §3, §4)
-- ============================================================
CREATE TABLE arena.exchanges (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  website text,
  access_class text NOT NULL
    CHECK (access_class IN ('open', 'us_blocked', 'hard_blocked')),
  notes text
);

-- ============================================================
-- arena.sources — one row per (exchange, product) data source (spec §3).
-- ALL per-source orchestrator config lives here, never hardcoded in TS.
-- ============================================================
CREATE TABLE arena.sources (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  exchange_id smallint NOT NULL REFERENCES arena.exchanges(id) ON DELETE CASCADE,
  product_type text NOT NULL
    CHECK (product_type IN ('spot', 'futures', 'cfd', 'onchain')),
  trader_kind_scope text NOT NULL DEFAULT 'human'
    CHECK (trader_kind_scope IN ('human', 'bot', 'mixed')),
  adapter_slug text NOT NULL,
  leaderboard_url text,
  timeframes_native int[] NOT NULL DEFAULT '{7,30,90}',
  timeframes_derived int[] NOT NULL DEFAULT '{}',
  tf_label_map jsonb NOT NULL DEFAULT '{}',
  -- expected_count is the day-one sanity floor ONLY (spec §5.1); the live
  -- baseline is median(actual_count) over the last 7 passing snapshots,
  -- computed at check time — deliberately NOT denormalized here.
  expected_count int,
  deep_profile_topn int NOT NULL DEFAULT 300,
  positions_topn int NOT NULL DEFAULT 100,
  profile_cache_ttl interval NOT NULL DEFAULT '6 hours',
  copier_table_depth text NOT NULL DEFAULT 'full'
    CHECK (copier_table_depth IN ('full', 'top10', 'top3_preview', 'none')),
  currency text NOT NULL DEFAULT 'USDT'
    CHECK (currency IN ('USDT', 'USDx', 'USDC')),
  page_size int,
  pagination_kind text
    CHECK (pagination_kind IS NULL OR
           pagination_kind IN ('numeric', 'next_prev', 'infinite_scroll', 'api_cursor')),
  cadence_tier_a interval NOT NULL DEFAULT '5 hours',
  cadence_tier_b interval NOT NULL DEFAULT '18 hours',
  cadence_tier_d interval NOT NULL DEFAULT '2 hours',
  fetch_region text NOT NULL DEFAULT 'local'
    CHECK (fetch_region IN ('local', 'vps_sg', 'vps_jp')),
  rate_budget_ms int NOT NULL DEFAULT 2500,
  -- phase drives alerting discipline (spec §15): phase<=1 Tier-A failures
  -- page in real time, everything else goes to the daily digest.
  phase smallint NOT NULL DEFAULT 2 CHECK (phase BETWEEN 0 AND 3),
  -- per-source cutover state machine: legacy → shadow → serving
  serving_mode text NOT NULL DEFAULT 'legacy'
    CHECK (serving_mode IN ('legacy', 'shadow', 'serving')),
  status text NOT NULL DEFAULT 'inactive'
    CHECK (status IN ('active', 'inactive', 'blocked_pending_vps', 'dropped')),
  meta jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_arena_sources_active ON arena.sources (status) WHERE status = 'active';

-- ============================================================
-- arena.source_secrets — persisted Playwright storageState (cookies etc).
-- Separate table so sources stays publicly readable; NO public policy is
-- ever added here (M6 leaves it service_role-only).
-- ============================================================
CREATE TABLE arena.source_secrets (
  source_id smallint PRIMARY KEY REFERENCES arena.sources(id) ON DELETE CASCADE,
  storage_state jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Lock secrets down immediately (default privileges above granted SELECT).
REVOKE SELECT ON arena.source_secrets FROM anon, authenticated;

-- ============================================================
-- Seed: exchanges (spec §7 / §4 access classes)
-- ============================================================
INSERT INTO arena.exchanges (slug, name, website, access_class, notes) VALUES
  ('binance',     'Binance',     'https://www.binance.com',  'us_blocked',   'Spot + futures copy-trading geo-block US IPs; web3 wallet board is open'),
  ('bybit',       'Bybit',       'https://www.bybit.com',    'open',         'copyTrade classic + MT5 CFD'),
  ('bitget',      'Bitget',      'https://www.bitget.com',   'open',         'futures/spot/cfd/bots; positions shown to non-copiers with 1h delay; balance history 180d retention'),
  ('mexc',        'MEXC',        'https://www.mexc.com',     'open',         'real copy-trading URL TBD on first manual session (spec §9.1)'),
  ('okx',         'OKX',         'https://www.okx.com',      'hard_blocked', 'CEX unreachable even via consumer VPN; web3 wallet board is open'),
  ('htx',         'HTX',         'https://www.htx.com',      'open',         '90d board only'),
  ('gate',        'Gate',        'https://www.gate.com',     'open',         'TF filter hidden behind filter icon; copiers top-10 only'),
  ('bingx',       'BingX',       'https://www.bingx.com',    'open',         'product × surface × TF matrix'),
  ('xt',          'XT',          'https://www.xt.com',       'open',         'spot pages degenerate after ~3 pages (all-zero rows)'),
  ('blofin',      'Blofin',      'https://www.blofin.com',   'open',         'bots tab + All/Trades/Bots chart scope'),
  ('btcc',        'BTCC',        'https://www.btcc.com',     'open',         'native 30d only; derive 7/90; TF labels 7D/1M/3M'),
  ('bitunix',     'Bitunix',     'https://www.bitunix.com',  'open',         'charts labeled UTC+0; 10-minute refresh note'),
  ('coinex',      'CoinEx',      'https://www.coinex.com',   'open',         NULL),
  ('kucoin',      'KuCoin',      'https://www.kucoin.com',   'open',         'TradePilot badge = AI-copy bot signal'),
  ('phemex',      'Phemex',      'https://phemex.com',       'open',         '30/90 only (no 7d); house AI Traders carousel'),
  ('lbank',       'LBank',       'https://www.lbank.com',    'open',         '7/30 only (no 90d); TF dropdown has 14D/180D — ignore'),
  ('bitmart',     'BitMart',     'https://www.bitmart.com',  'open',         'AIHub weekly ROI Arena; Latest NAV; do NOT ingest Beacon AI commentary'),
  ('toobit',      'Toobit',      'https://www.toobit.com',   'hard_blocked', 'same posture as OKX CEX'),
  ('bitfinex',    'Bitfinex',    'https://www.bitfinex.com', 'open',         'public rankings API > UI; model on bfxleaderboardTracker'),
  ('hyperliquid', 'Hyperliquid', 'https://hyperliquid.xyz',  'open',         '~382k traders; API/on-chain only, never headless-scrape'),
  ('gmx',         'GMX',         'https://gmx.io',           'open',         'on-chain; 7/30 native, compute 90'),
  ('gtrade',      'gTrade',      'https://gains.trade',      'open',         'on-chain; per-TF URLs; USDC'),
  ('binance_web3','Binance Wallet', 'https://web3.binance.com', 'open',     'BSC leaderboard; open even though CEX is us_blocked'),
  ('okx_web3',    'OKX Wallet',  'https://web3.okx.com',     'open',         'Solana leaderboard; open even though CEX is hard_blocked');

-- ============================================================
-- Seed: sources (spec §7; counts = survey-time expected_count).
-- Bitget bots split into spot/futures source rows because product_type is
-- per-board (spec §1.3): Spot Martingale+Grid → (spot,bot); Futures → (futures,bot).
-- Only the Bitget family is active at Phase 0.
-- ============================================================
INSERT INTO arena.sources
  (slug, exchange_id, product_type, trader_kind_scope, adapter_slug, leaderboard_url,
   timeframes_native, timeframes_derived, tf_label_map, expected_count,
   copier_table_depth, currency, page_size, pagination_kind,
   fetch_region, phase, status, meta)
VALUES
  -- ===== Phase 0: Bitget family (spec #5, #8, #6, #7) =====
  ('bitget_futures', (SELECT id FROM arena.exchanges WHERE slug='bitget'), 'futures', 'human', 'bitget',
   'https://www.bitget.com/zh-CN/copy-trading/futures',
   '{7,30,90}', '{}', '{}', 1860, 'full', 'USDT', 30, 'numeric',
   'local', 0, 'active',
   '{"boardKey":"futures","positions_delay_hours":1,"balance_history_retention_days":180,"copier_as_of_from_page":true}'),
  ('bitget_spot', (SELECT id FROM arena.exchanges WHERE slug='bitget'), 'spot', 'human', 'bitget',
   'https://www.bitget.com/zh-CN/copy-trading/spot',
   '{7,30,90}', '{}', '{}', 5550, 'full', 'USDT', 30, 'numeric',
   'local', 0, 'active',
   '{"boardKey":"spot","positions_delay_hours":1,"balance_history_retention_days":180,"copier_as_of_from_page":true}'),
  ('bitget_cfd', (SELECT id FROM arena.exchanges WHERE slug='bitget'), 'cfd', 'human', 'bitget',
   'https://www.bitget.com/zh-CN/copy-trading/cfd',
   '{7,30,90}', '{}', '{}', 210, 'full', 'USDT', 30, 'numeric',
   'local', 0, 'active',
   '{"boardKey":"cfd","positions_delay_hours":1,"balance_history_retention_days":180,"copier_as_of_from_page":true}'),
  ('bitget_bots_futures', (SELECT id FROM arena.exchanges WHERE slug='bitget'), 'futures', 'bot', 'bitget_bots',
   'https://www.bitget.com/zh-CN/copy-trading/bot',
   '{7,30,90}', '{}', '{}', NULL, 'full', 'USDT', NULL, 'infinite_scroll',
   'local', 0, 'active',
   '{"boards":["futures_grid","futures_martingale"],"inception_tf":true,"expected_count_note":"set after baseline crawl (spec 9.3)"}'),
  ('bitget_bots_spot', (SELECT id FROM arena.exchanges WHERE slug='bitget'), 'spot', 'bot', 'bitget_bots',
   'https://www.bitget.com/zh-CN/copy-trading/bot',
   '{7,30,90}', '{}', '{}', NULL, 'full', 'USDT', NULL, 'infinite_scroll',
   'local', 0, 'active',
   '{"boards":["spot_grid","spot_martingale"],"inception_tf":true,"expected_count_note":"set after baseline crawl (spec 9.3)"}'),

  -- ===== Phase 1: the 80% coverage set (spec §15) =====
  ('bybit_mt5', (SELECT id FROM arena.exchanges WHERE slug='bybit'), 'cfd', 'human', 'bybit_mt5',
   'https://www.bybit.com/copyMt5/',
   '{7,30,90}', '{}', '{}', 29424, 'none', 'USDx', 16, 'numeric',
   'local', 1, 'inactive',
   '{"click_all_traders":true,"non_realtime_disclosure":true,"master_trader_type":true}'),
  ('mexc_futures', (SELECT id FROM arena.exchanges WHERE slug='mexc'), 'futures', 'mixed', 'mexc',
   NULL,
   '{7}', '{30,90}', '{}', 23640, 'full', 'USDT', 30, 'numeric',
   'local', 1, 'inactive',
   '{"derived_board_sort":"roi","ai_traders_tab_is_bot":true,"style_tags":true,"radar_percentiles":true,"url_tbd":true}'),
  ('binance_futures', (SELECT id FROM arena.exchanges WHERE slug='binance'), 'futures', 'human', 'binance',
   'https://www.binance.com/en/copy-trading',
   '{7,30,90}', '{}', '{}', 9640, 'full', 'USDT', 20, 'numeric',
   'vps_sg', 1, 'inactive',
   '{"boardKey":"futures","click_all_portfolios":true,"position_history_dual_sort":true,"asset_pref_refresh_hours":2}'),
  ('binance_spot', (SELECT id FROM arena.exchanges WHERE slug='binance'), 'spot', 'human', 'binance',
   'https://www.binance.com/en/copy-trading/spot',
   '{7,30,90}', '{}', '{}', 2520, 'full', 'USDT', 20, 'numeric',
   'vps_sg', 1, 'inactive',
   '{"boardKey":"spot","click_all_portfolios":true,"position_history_dual_sort":true}'),
  ('bybit_copytrade', (SELECT id FROM arena.exchanges WHERE slug='bybit'), 'futures', 'mixed', 'bybit_copytrade',
   'https://www.bybit.com/copyTrade/',
   '{7,30,90}', '{}', '{}', 8800, 'full', 'USDT', 16, 'numeric',
   'local', 1, 'inactive',
   '{"product_subtype":"mixed_ui","bot_scope_series":true,"platform_aggregates":true,"click_all_traders":true}'),
  ('hyperliquid', (SELECT id FROM arena.exchanges WHERE slug='hyperliquid'), 'onchain', 'human', 'hyperliquid',
   'https://app.hyperliquid.xyz/leaderboard',
   '{7,30}', '{90}', '{}', 382000, 'none', 'USDC', NULL, 'api_cursor',
   'local', 1, 'inactive',
   '{"api_only":true,"compute_90d_from_fills":true,"build_vs_buy_spike":true,"series_topn_only":500}'),

  -- ===== Phase 2: long tail =====
  ('coinex_futures', (SELECT id FROM arena.exchanges WHERE slug='coinex'), 'futures', 'human', 'coinex',
   'https://www.coinex.com/en/copy-trading/traders',
   '{7,30,90}', '{}', '{}', 192, 'full', 'USDT', 12, 'numeric', 'local', 2, 'inactive', '{}'),
  ('htx_futures', (SELECT id FROM arena.exchanges WHERE slug='htx'), 'futures', 'human', 'htx',
   'https://futures.htx.com/en-us/copytrading/futures',
   '{90}', '{}', '{}', 60, 'full', 'USDT', 12, 'numeric', 'local', 2, 'inactive',
   '{"boardKey":"futures","click_all_traders":true,"site_refresh_minutes":15}'),
  ('htx_spot', (SELECT id FROM arena.exchanges WHERE slug='htx'), 'spot', 'human', 'htx',
   'https://futures.htx.com/en-us/copytrading/spot',
   '{90}', '{}', '{}', 24, 'full', 'USDT', 12, 'numeric', 'local', 2, 'inactive',
   '{"boardKey":"spot","click_all_traders":true}'),
  ('gate_futures', (SELECT id FROM arena.exchanges WHERE slug='gate'), 'futures', 'human', 'gate',
   'https://www.gate.com/zh/copytrading',
   '{7,30,90}', '{}', '{}', 170, 'top10', 'USDT', 12, 'numeric', 'local', 2, 'inactive',
   '{"boardKey":"futures","tf_filter_hidden":true,"roi_chart_dual_mode":true,"last_liquidation_field":true,"as_of_from_page":true}'),
  ('gate_cfd', (SELECT id FROM arena.exchanges WHERE slug='gate'), 'cfd', 'human', 'gate',
   'https://w.gate.com/zh/copytrading/tradfi',
   '{7,30,90}', '{}', '{}', 2580, 'top10', 'USDx', 12, 'numeric', 'local', 2, 'inactive',
   '{"boardKey":"cfd"}'),
  ('bingx_futures', (SELECT id FROM arena.exchanges WHERE slug='bingx'), 'futures', 'human', 'bingx',
   'https://bingx.com/en/CopyTrading',
   '{7,30,90}', '{}', '{}', 2076, 'full', 'USDT', 12, 'numeric', 'local', 2, 'inactive',
   '{"boardKey":"futures","product_surface_tf_matrix":true,"risk_rating_1_10":true}'),
  ('bingx_spot', (SELECT id FROM arena.exchanges WHERE slug='bingx'), 'spot', 'human', 'bingx',
   'https://bingx.com/en/CopyTrading?type=spot',
   '{7,30,90}', '{}', '{}', 72, 'full', 'USDT', 12, 'numeric', 'local', 2, 'inactive',
   '{"boardKey":"spot"}'),
  ('xt_futures', (SELECT id FROM arena.exchanges WHERE slug='xt'), 'futures', 'human', 'xt',
   'https://www.xt.com/en/copy-trading/futures',
   '{7,30,90}', '{}', '{}', 1880, 'full', 'USDT', 10, 'numeric', 'local', 2, 'inactive',
   '{"boardKey":"futures","click_view_all":true}'),
  ('xt_spot', (SELECT id FROM arena.exchanges WHERE slug='xt'), 'spot', 'human', 'xt',
   'https://www.xt.com/en/copy-trading/spot',
   '{7,30,90}', '{}', '{}', 30, 'full', 'USDT', 10, 'next_prev', 'local', 2, 'inactive',
   '{"boardKey":"spot","degenerate_page_stop":3}'),
  ('blofin_futures', (SELECT id FROM arena.exchanges WHERE slug='blofin'), 'futures', 'mixed', 'blofin',
   'https://blofin.com/copy-trade/futures?tab=allTraders',
   '{7,30,90}', '{}', '{}', 1656, 'full', 'USDT', 12, 'numeric', 'local', 2, 'inactive',
   '{"boardKey":"futures","bot_scope_series":true,"as_of_from_page":true}'),
  ('blofin_spot', (SELECT id FROM arena.exchanges WHERE slug='blofin'), 'spot', 'human', 'blofin',
   'https://blofin.com/copy-trade/spot',
   '{7,30,90}', '{}', '{}', 84, 'full', 'USDT', 12, 'numeric', 'local', 2, 'inactive',
   '{"boardKey":"spot"}'),
  ('btcc_futures', (SELECT id FROM arena.exchanges WHERE slug='btcc'), 'futures', 'human', 'btcc',
   'https://www.btcc.com/en-US/copy-trading?type=all',
   '{30}', '{7,90}', '{"7D":7,"1M":30,"3M":90}', 1824, 'full', 'USDT', 12, 'numeric', 'local', 2, 'inactive',
   '{"derived_board_sort":"roi"}'),
  ('bitunix_futures', (SELECT id FROM arena.exchanges WHERE slug='bitunix'), 'futures', 'human', 'bitunix',
   'https://www.bitunix.com/zh-tw/copy-trading/square/2/PL/1',
   '{7,30,90}', '{}', '{}', 4005, 'full', 'USDT', 9, 'numeric', 'local', 2, 'inactive',
   '{"charts_utc0_labeled":true,"site_refresh_minutes":10}'),
  ('kucoin_futures', (SELECT id FROM arena.exchanges WHERE slug='kucoin'), 'futures', 'mixed', 'kucoin',
   'https://www.kucoin.com/copytrading',
   '{7,30,90}', '{}', '{}', 120, 'full', 'USDT', 12, 'numeric', 'local', 2, 'inactive',
   '{"tradepilot_badge_is_bot":true,"tf_behind_filter":true}'),
  ('phemex_futures', (SELECT id FROM arena.exchanges WHERE slug='phemex'), 'futures', 'mixed', 'phemex',
   'https://phemex.com/copy-trading/list?t=r',
   '{30,90}', '{}', '{}', 240, 'full', 'USDT', 12, 'numeric', 'local', 2, 'inactive',
   '{"house_ai_traders":true,"skip_commentary_tab":true,"click_all_traders":true}'),
  ('lbank_futures', (SELECT id FROM arena.exchanges WHERE slug='lbank'), 'futures', 'human', 'lbank',
   'https://www.lbank.com/copy-trading?tab=all',
   '{7,30}', '{}', '{"7D":7,"30D":30}', 140, 'top3_preview', 'USDT', 20, 'numeric',
   'local', 2, 'inactive',
   '{"click_all_lead_traders":true,"ignore_tf_labels":["14D","180D"]}'),
  ('bitmart_futures', (SELECT id FROM arena.exchanges WHERE slug='bitmart'), 'futures', 'mixed', 'bitmart',
   'https://www.bitmart.com',
   '{90}', '{}', '{"24H":1,"7D":7,"1M":30,"3M":90}', 58, 'full', 'USDT', NULL, 'infinite_scroll',
   'local', 2, 'inactive',
   '{"weekly_arena_surface":true,"latest_nav":true,"style_tags":true,"no_beacon_ingestion":true}'),
  ('binance_web3_bsc', (SELECT id FROM arena.exchanges WHERE slug='binance_web3'), 'onchain', 'human', 'binance_web3',
   'https://web3.binance.com/en/leaderboard?chain=bsc',
   '{7,30,90}', '{}', '{}', 240, 'none', 'USDT', 24, 'numeric', 'local', 2, 'inactive',
   '{"click_all_toggle":true,"kol_flag":true,"pnl_buckets":true}'),
  ('okx_web3_solana', (SELECT id FROM arena.exchanges WHERE slug='okx_web3'), 'onchain', 'human', 'okx_web3',
   'https://web3.okx.com/copy-trade/leaderboard/solana',
   '{7,30,90}', '{}', '{"1D":1,"7D":7,"1M":30,"3M":90}', 3900, 'none', 'USDC', 20, 'numeric',
   'local', 2, 'inactive',
   '{"wallet_category_tags":true,"pnl_calendar":true,"preferred_market_cap":true,"near_realtime":true,"ignore_tf_labels":["3D"]}'),
  ('gmx', (SELECT id FROM arena.exchanges WHERE slug='gmx'), 'onchain', 'human', 'gmx',
   'https://app.gmx.io/#/leaderboard',
   '{7,30}', '{90}', '{}', 60, 'none', 'USDC', 20, 'numeric', 'local', 2, 'inactive',
   '{"api_only":true,"compute_90d":true}'),
  ('gtrade', (SELECT id FROM arena.exchanges WHERE slug='gtrade'), 'onchain', 'human', 'gtrade',
   'https://gains.trade/leaderboard',
   '{7,30,90}', '{}', '{}', 35, 'none', 'USDC', NULL, 'numeric', 'local', 2, 'inactive',
   '{"per_tf_urls":true,"aggregate_from_trades_table":true}'),

  -- ===== Phase 3: blocked / API-first pending =====
  ('bitfinex', (SELECT id FROM arena.exchanges WHERE slug='bitfinex'), 'futures', 'human', 'bitfinex',
   'https://www.bitfinex.com',
   '{7,30,90}', '{}', '{}', NULL, 'none', 'USDT', NULL, 'api_cursor', 'local', 3, 'inactive',
   '{"api_only":true,"reference":"bfxleaderboardTracker","count_tbd":true}'),
  ('okx_futures', (SELECT id FROM arena.exchanges WHERE slug='okx'), 'futures', 'human', 'okx',
   NULL, '{7,30,90}', '{}', '{}', NULL, 'full', 'USDT', NULL, NULL,
   'vps_sg', 3, 'blocked_pending_vps', '{"surfaces_assume_binance_like":true}'),
  ('okx_spot', (SELECT id FROM arena.exchanges WHERE slug='okx'), 'spot', 'human', 'okx',
   NULL, '{7,30,90}', '{}', '{}', NULL, 'full', 'USDT', NULL, NULL,
   'vps_sg', 3, 'blocked_pending_vps', '{}'),
  ('toobit_futures', (SELECT id FROM arena.exchanges WHERE slug='toobit'), 'futures', 'human', 'toobit',
   NULL, '{7,30,90}', '{}', '{}', NULL, 'full', 'USDT', NULL, NULL,
   'vps_sg', 3, 'blocked_pending_vps', '{}');
