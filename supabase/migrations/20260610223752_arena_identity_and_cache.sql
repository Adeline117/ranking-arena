-- Migration: 20260610223752_arena_identity_and_cache.sql
-- Created: 2026-06-11T05:37:52Z
-- Description: ARENA_DATA_SPEC v1.2 §3 — arena schema M2 of 6: identity
--   (traders), bot instances (bots, shadow-row model), Tier-C lazy-fetch
--   cache (profile_cache) and incremental history cursors (ingest_cursors).

-- ============================================================
-- arena.traders — one Arena profile per (source, exchange_trader_id)
-- (spec §1.4). Bots get a shadow row here (trader_kind='bot') so the whole
-- stats pipeline is reused; bot-specific fields live in arena.bots.
-- ============================================================
CREATE TABLE arena.traders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id) ON DELETE CASCADE,
  exchange_trader_id text NOT NULL,
  nickname text,
  avatar_url_origin text,
  avatar_url_mirror text,           -- our Supabase Storage mirror (spec §1.4: never hotlink)
  wallet_address text,              -- on-chain sources: the address IS the identity
  trader_kind text NOT NULL DEFAULT 'human'
    CHECK (trader_kind IN ('human', 'bot')),
  bot_strategy text
    CHECK (bot_strategy IS NULL OR bot_strategy IN ('martingale', 'grid', 'ai')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  meta jsonb NOT NULL DEFAULT '{}', -- style tags, badges, level, country, KOL flag...
  UNIQUE (source_id, exchange_trader_id)
);

-- Homepage counter: distinct traders with last_seen_at within 30d (spec §8)
CREATE INDEX idx_arena_traders_last_seen ON arena.traders (last_seen_at DESC);
-- Bot/human leaderboard filter
CREATE INDEX idx_arena_traders_kind ON arena.traders (source_id, trader_kind)
  WHERE trader_kind = 'bot';
-- Cheap future cross-source join for on-chain identities (spec §3 note)
CREATE INDEX idx_arena_traders_wallet ON arena.traders (wallet_address)
  WHERE wallet_address IS NOT NULL;
-- Avatar mirror jobs: find unmirrored / stale
CREATE INDEX idx_arena_traders_unmirrored ON arena.traders (id)
  WHERE avatar_url_origin IS NOT NULL AND avatar_url_mirror IS NULL;

-- ============================================================
-- arena.bots — Bitget-style per-pair bot INSTANCES (spec §1.3).
-- shadow_trader_id = the traders row that carries this bot's stats/series;
-- owner_trader_id  = the human expert who owns the bot (one owner : N bots).
-- ============================================================
CREATE TABLE arena.bots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id) ON DELETE CASCADE,
  exchange_bot_id text NOT NULL,
  shadow_trader_id bigint NOT NULL REFERENCES arena.traders(id) ON DELETE CASCADE,
  owner_trader_id bigint REFERENCES arena.traders(id) ON DELETE SET NULL,
  pair text,
  product_type text
    CHECK (product_type IS NULL OR product_type IN ('spot', 'futures')),
  bot_strategy text
    CHECK (bot_strategy IS NULL OR bot_strategy IN ('martingale', 'grid', 'ai')),
  direction text,
  created_at_origin timestamptz,
  runtime_days int,
  profit_share_rate numeric,
  status text,
  raw jsonb,
  UNIQUE (source_id, exchange_bot_id),
  UNIQUE (shadow_trader_id)
);

CREATE INDEX idx_arena_bots_owner ON arena.bots (owner_trader_id)
  WHERE owner_trader_id IS NOT NULL;

-- ============================================================
-- arena.profile_cache — Tier-C lazy-fetch cache (spec §2.3-C, §2.4).
-- One row per (trader, timeframe, surface); payload is the parsed module
-- bundle returned to the client. timeframe 0 = "since inception" (bots).
-- is_refreshing guards duplicate background refreshes (single-flight is
-- primarily the deterministic BullMQ jobId; this flag covers stale-refresh).
-- ============================================================
CREATE TABLE arena.profile_cache (
  trader_id bigint NOT NULL REFERENCES arena.traders(id) ON DELETE CASCADE,
  timeframe smallint NOT NULL CHECK (timeframe IN (0, 7, 30, 90)),
  surface text NOT NULL
    CHECK (surface IN ('profile', 'positions', 'position_history',
                       'orders', 'transfers', 'copiers')),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  is_refreshing boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL,
  PRIMARY KEY (trader_id, timeframe, surface)
);

CREATE INDEX idx_arena_profile_cache_expiry ON arena.profile_cache (expires_at);

-- ============================================================
-- arena.ingest_cursors — incremental append-only history cursors
-- (spec §2.3 Histories row): latest seen ts/order id per trader+kind;
-- fetch newest pages until overlap, never re-fetch full history.
-- ============================================================
CREATE TABLE arena.ingest_cursors (
  trader_id bigint NOT NULL REFERENCES arena.traders(id) ON DELETE CASCADE,
  kind text NOT NULL
    CHECK (kind IN ('position_history', 'orders', 'transfers', 'copiers')),
  cursor_value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trader_id, kind)
);
