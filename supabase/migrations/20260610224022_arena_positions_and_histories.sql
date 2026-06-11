-- Migration: 20260610224022_arena_positions_and_histories.sql
-- Created: 2026-06-11T05:40:22Z
-- Description: ARENA_DATA_SPEC v1.2 §3 — arena schema M4 of 6: current
--   positions (snapshot semantics, fully replaced per cycle) and the four
--   append-only history tables (incremental cursor ingestion), all
--   monthly-partitioned (spec §13.4) with dedupe_hash natural keys for
--   idempotent incremental upserts.

-- ============================================================
-- arena.positions_current — open positions snapshot, fully replaced per
-- trader per Tier-D cycle (spec §2.3). as_of carries source-disclosed
-- staleness (e.g. Bitget shows non-copiers a 1h-delayed view, so
-- as_of = scraped_at - 1h, spec §5.7).
-- ============================================================
CREATE TABLE arena.positions_current (
  trader_id bigint NOT NULL REFERENCES arena.traders(id) ON DELETE CASCADE,
  snapshot_at timestamptz NOT NULL,
  as_of timestamptz NOT NULL,
  symbol text NOT NULL,
  side text,
  leverage numeric,
  size numeric,
  entry_price numeric,
  mark_price numeric,
  unrealized_pnl numeric,
  currency text NOT NULL,
  raw jsonb,
  PRIMARY KEY (trader_id, symbol, side)
);

CREATE INDEX idx_arena_positions_snapshot ON arena.positions_current (snapshot_at);

-- ============================================================
-- arena.position_history — closed/partially-closed positions, partitioned
-- by closed_at (DEFAULT partition catches still-open imports with NULL).
-- dedupe_hash = adapter-computed stable hash of the source row's natural
-- identity (position id where the source has one, else field tuple).
-- ============================================================
CREATE TABLE arena.position_history (
  trader_id bigint NOT NULL REFERENCES arena.traders(id) ON DELETE CASCADE,
  opened_at timestamptz,
  closed_at timestamptz,
  symbol text NOT NULL,
  side text,
  leverage numeric,
  size numeric,
  entry_price numeric,
  exit_price numeric,
  realized_pnl numeric,
  currency text NOT NULL,
  dedupe_hash text NOT NULL,
  raw jsonb
) PARTITION BY RANGE (closed_at);

-- Partitioned unique index must include the partition key; closed_at is
-- stable per source row so (closed_at, dedupe_hash) stays idempotent.
CREATE UNIQUE INDEX uq_arena_position_history_dedupe
  ON arena.position_history (closed_at, dedupe_hash);
CREATE INDEX idx_arena_position_history_trader
  ON arena.position_history (trader_id, closed_at DESC);

CREATE TABLE arena.position_history_default
  PARTITION OF arena.position_history DEFAULT;

-- ============================================================
-- arena.order_records — order/latest records timeline (spec §3)
-- ============================================================
CREATE TABLE arena.order_records (
  trader_id bigint NOT NULL REFERENCES arena.traders(id) ON DELETE CASCADE,
  ts timestamptz NOT NULL,
  kind text,                          -- open/close × long/short, fill, etc. (per-source)
  symbol text,
  side text,
  price numeric,
  qty numeric,
  currency text NOT NULL,
  dedupe_hash text NOT NULL,
  raw jsonb
) PARTITION BY RANGE (ts);

CREATE UNIQUE INDEX uq_arena_order_records_dedupe
  ON arena.order_records (ts, dedupe_hash);
CREATE INDEX idx_arena_order_records_trader
  ON arena.order_records (trader_id, ts DESC);

-- ============================================================
-- arena.transfer_history — fund movements in/out of the lead account
-- ============================================================
CREATE TABLE arena.transfer_history (
  trader_id bigint NOT NULL REFERENCES arena.traders(id) ON DELETE CASCADE,
  ts timestamptz NOT NULL,
  direction text,                     -- in | out (normalized from per-source labels)
  asset text,
  amount numeric,
  currency text NOT NULL,
  dedupe_hash text NOT NULL,
  raw jsonb
) PARTITION BY RANGE (ts);

CREATE UNIQUE INDEX uq_arena_transfer_history_dedupe
  ON arena.transfer_history (ts, dedupe_hash);
CREATE INDEX idx_arena_transfer_history_trader
  ON arena.transfer_history (trader_id, ts DESC);

-- ============================================================
-- arena.copier_records — copier table rows for AGGREGATE stats only.
-- copier_label is stored for dedupe but NEVER rendered (spec §6 PII rule);
-- M6 gives this table no public SELECT policy.
-- ============================================================
CREATE TABLE arena.copier_records (
  trader_id bigint NOT NULL REFERENCES arena.traders(id) ON DELETE CASCADE,
  ts timestamptz NOT NULL,            -- as_of (source page timestamp where shown)
  copier_label text,
  copier_pnl numeric,
  copier_invested numeric,
  copy_duration_days int,
  currency text NOT NULL,
  dedupe_hash text NOT NULL,
  raw jsonb
) PARTITION BY RANGE (ts);

CREATE UNIQUE INDEX uq_arena_copier_records_dedupe
  ON arena.copier_records (ts, dedupe_hash);
CREATE INDEX idx_arena_copier_records_trader
  ON arena.copier_records (trader_id, ts DESC);

-- Initial monthly partitions (current + 2 ahead; maintenance job keeps going)
SELECT arena.ensure_month_partitions('position_history', 2);
SELECT arena.ensure_month_partitions('order_records', 2);
SELECT arena.ensure_month_partitions('transfer_history', 2);
SELECT arena.ensure_month_partitions('copier_records', 2);
