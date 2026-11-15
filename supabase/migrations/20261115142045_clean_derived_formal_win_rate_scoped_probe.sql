-- Forward replacement for 20261113150757_clean_derived_formal_win_rate.sql
-- (never applied to production). The body is identical except that the
-- board-history probe (seen_as_native_headline) is evaluated only for the rows
-- whose classification can depend on it.
--
-- The original evaluates a correlated EXISTS over arena.leaderboard_entries
-- (16M rows) for every in-scope trader_stats row: 180,875 rows on production
-- (2026-11-15). Measured there read-only, 20,000 rows take 40 s, so the
-- statement needs about 6 minutes against this file's 5-minute
-- statement_timeout, with arena.trader_stats locked SHARE ROW EXCLUSIVE
-- throughout.
--
-- Every predicate that reads the flag (both candidate branches and all three
-- "unprovable" counters) also requires either
--   web3:  slug IN (okx_web3_solana, binance_web3_bsc) AND timeframe = 90
--          AND onchain_enriched
--   btcc:  slug = btcc_futures AND abs(win_rate - window_ratio_pct) <= 0.005
-- so the flag on any other row is never consulted. Only 8,883 of the 180,875
-- rows meet one of those conditions. Candidates, updates and reported counts
-- are unchanged.
--
-- The archive markers written into extras keep the original identifier
-- '20261113150757' on purpose: the body is otherwise byte-identical and the
-- marker names the cleanup, not the file that carried it.
--
-- Clean Arena-derived values out of the formal arena.trader_stats.win_rate column
-- (issue #441).
--
-- Rule: a win rate the exchange publishes is never self-derived into the
-- formal column (死命令「不自派生交易所提供的字段」). Two historical writers broke it:
--
-- A. On-chain enrichment (okx_web3_solana, binance_web3_bsc; timeframe 90 only).
--    worker onchain-enrich (51cf7319c, 2026-07-01) and the on-demand RPC
--    arena_apply_onchain_enrichment (20260702120132) ran
--    `win_rate = COALESCE(ts.win_rate, <chain win rate>)` until df9c5c005
--    (2026-07-15) gated it behind isOnchainQualityCanonical, which no shipped
--    enrichment ever satisfies; bf3fa8a4d removed the formal write for both
--    boards. 20260715212448 already quarantined binance_web3_bsc rows by the
--    same equality proof; this migration extends it to okx_web3_solana and to
--    rows whose board history contained a different exchange value.
--    Provable dirty row = the formal value still equals extras.onchain_win_rate
--    (the chain value the same writer stores beside it), it never appeared as
--    a native board headline for that trader/timeframe, and no exchange
--    profile ever wrote the row (okx profile writes replace extras wholesale
--    and always carry their own keys; binance_web3 has no profile surface).
--    Action: win_rate -> NULL (exactly what the current code would hold: the
--    COALESCE fill only happened when no exchange value was present). The chain
--    value already sits in extras.onchain_win_rate; the old formal value is
--    archived in extras.onchain_typed_win_rate_quarantine.
--
-- B. BTCC profile (btcc_futures, every timeframe). parseBtccProfile wrote
--    round(totalWinTradeNum / totalTradeNum * 100, 2) to the formal column
--    until 60f4cc288, while the exchange value profitInfo.winRate was stored in
--    the same write at extras.all_time.win_rate.
--    Provable dirty row = formal value matches the row's own win/total ratio
--    (within the 0.005 JS-rounding band), differs from extras.all_time.win_rate,
--    and never appeared as a native (non-derived) board headline.
--    Action: restore win_rate = extras.all_time.win_rate (what the fixed parser
--    writes), move the ratio to extras.derived_window_win_rate_pct (+ basis) if
--    absent, and archive the old value in extras.formal_win_rate_cleanup.
--
-- Not provable, reported by NOTICE and left untouched:
--   * web3 rows whose formal value is not in board history but no longer
--     equals extras.onchain_win_rate (a later enrichment refreshed the extras
--     value; the chain origin of the formal value can no longer be shown);
--   * okx_web3_solana rows matching the chain value that an exchange profile
--     also wrote (write order is not recorded, so the value may be exchange);
--   * btcc rows matching the ratio with no numeric extras.all_time.win_rate.
--
-- Pure-DEX sources whose self-derivation is sanctioned (hyperliquid, gmx,
-- gtrade, ...) are out of scope by construction: only the three slugs above
-- are read. Idempotent: every cleaned row leaves its candidate predicate.
-- Scores: leaderboard_ranks are recomputed from arena_score_inputs at the next
-- publication; BTCC derived 7/90 board entries copy trader_stats.win_rate and
-- need one derive-boards run before that publication (see PR #441 notes).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
DECLARE
  v_matched integer;
BEGIN
  SELECT pg_catalog.count(*)
  INTO v_matched
  FROM (
    VALUES
      ('arena.trader_stats'::text, 'trader_id'::text, 'bigint'::text),
      ('arena.trader_stats', 'timeframe', 'smallint'),
      ('arena.trader_stats', 'win_rate', 'numeric'),
      ('arena.trader_stats', 'win_positions', 'integer'),
      ('arena.trader_stats', 'total_positions', 'integer'),
      ('arena.trader_stats', 'extras', 'jsonb'),
      ('arena.traders', 'id', 'bigint'),
      ('arena.traders', 'source_id', 'smallint'),
      ('arena.sources', 'id', 'smallint'),
      ('arena.sources', 'slug', 'text'),
      ('arena.leaderboard_entries', 'snapshot_id', 'bigint'),
      ('arena.leaderboard_entries', 'trader_id', 'bigint'),
      ('arena.leaderboard_entries', 'timeframe', 'smallint'),
      ('arena.leaderboard_entries', 'headline_win_rate', 'numeric'),
      ('arena.leaderboard_snapshots', 'id', 'bigint'),
      ('arena.leaderboard_snapshots', 'is_derived', 'boolean')
  ) AS expected(relation_name, column_name, column_type)
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = pg_catalog.to_regclass(expected.relation_name)
   AND attribute.attname = expected.column_name
   AND NOT attribute.attisdropped
   AND pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) = expected.column_type;

  IF v_matched <> 16 THEN
    RAISE EXCEPTION
      'formal win-rate cleanup preflight: expected 16 arena columns with exact types, found %',
      v_matched;
  END IF;
END
$preflight$;

-- Freeze concurrent ingest writers for the short cleanup window so a board or
-- profile publish cannot interleave with candidate selection.
LOCK TABLE arena.trader_stats IN SHARE ROW EXCLUSIVE MODE;

-- One classified view of every in-scope row. JSON values are cast only behind
-- a CASE on jsonb_typeof (WHERE-clause AND order is not guaranteed), so a
-- malformed extras value can never abort the migration.
-- Session temp tables, emptied at COMMIT (no DROP needed; IF NOT EXISTS keeps a
-- rerun in the same session valid).
CREATE TEMP TABLE IF NOT EXISTS formal_win_rate_rows (
  slug text NOT NULL,
  trader_id bigint NOT NULL,
  timeframe smallint NOT NULL,
  win_rate numeric NOT NULL,
  win_positions integer,
  total_positions integer,
  onchain_enriched boolean,
  chain_win_rate numeric,
  exchange_profile_written boolean NOT NULL,
  exchange_all_time_win_rate numeric,
  window_ratio_pct numeric,
  seen_as_native_headline boolean NOT NULL
) ON COMMIT DELETE ROWS;

CREATE TEMP TABLE IF NOT EXISTS formal_win_rate_cleanup_candidates (
  cleanup_class text NOT NULL,
  trader_id bigint NOT NULL,
  timeframe smallint NOT NULL,
  previous_win_rate numeric NOT NULL,
  restored_win_rate numeric,
  derived_window_win_rate numeric,
  PRIMARY KEY (trader_id, timeframe)
) ON COMMIT DELETE ROWS;

DO $empty$
BEGIN
  IF EXISTS (SELECT 1 FROM formal_win_rate_rows)
     OR EXISTS (SELECT 1 FROM formal_win_rate_cleanup_candidates) THEN
    RAISE EXCEPTION 'formal win-rate cleanup work tables are not empty';
  END IF;
END
$empty$;

INSERT INTO formal_win_rate_rows
SELECT
  s.slug,
  ts.trader_id,
  ts.timeframe,
  ts.win_rate,
  ts.win_positions,
  ts.total_positions,
  (ts.extras->>'onchain_derivation') = 'onchain-computed'
    AND (ts.extras->>'provenance') IS DISTINCT FROM 'first_party' AS onchain_enriched,
  CASE WHEN pg_catalog.jsonb_typeof(ts.extras->'onchain_win_rate') = 'number'
    THEN (ts.extras->'onchain_win_rate')::numeric
  END AS chain_win_rate,
  -- okx profile publications replace extras wholesale and always write these
  -- keys; board and on-chain writers only merge other keys.
  ts.extras ?| ARRAY[
    '_arena_profile_publication_epoch_ms',
    'win_rate_distribution',
    'txs_buy',
    'unrealized_pnl',
    'native_balance_usd'
  ] AS exchange_profile_written,
  CASE WHEN pg_catalog.jsonb_typeof(ts.extras #> '{all_time,win_rate}') = 'number'
    THEN (ts.extras #> '{all_time,win_rate}')::numeric
  END AS exchange_all_time_win_rate,
  CASE WHEN ts.total_positions > 0
         AND ts.win_positions BETWEEN 0 AND ts.total_positions
    THEN 100.0 * ts.win_positions / ts.total_positions
  END AS window_ratio_pct,
  -- The board-history probe is evaluated only for rows whose classification
  -- can depend on it (see the header): every later predicate that reads
  -- seen_as_native_headline also requires one of these two conditions, so the
  -- flag's value on any other row is never consulted.
  CASE
    WHEN (
      s.slug IN ('okx_web3_solana', 'binance_web3_bsc')
      AND ts.timeframe = 90
      AND (ts.extras->>'onchain_derivation') = 'onchain-computed'
      AND (ts.extras->>'provenance') IS DISTINCT FROM 'first_party'
    ) OR (
      s.slug = 'btcc_futures'
      AND pg_catalog.abs(
        ts.win_rate
        - CASE WHEN ts.total_positions > 0
                 AND ts.win_positions BETWEEN 0 AND ts.total_positions
            THEN 100.0 * ts.win_positions / ts.total_positions
          END
      ) <= 0.005
    )
    THEN EXISTS (
      SELECT 1
      FROM arena.leaderboard_entries AS e
      JOIN arena.leaderboard_snapshots AS snapshot ON snapshot.id = e.snapshot_id
      WHERE e.trader_id = ts.trader_id
        AND e.timeframe = ts.timeframe
        AND NOT snapshot.is_derived
        AND e.headline_win_rate = ts.win_rate
    )
    ELSE false
  END AS seen_as_native_headline
FROM arena.trader_stats AS ts
JOIN arena.traders AS t ON t.id = ts.trader_id
JOIN arena.sources AS s ON s.id = t.source_id
WHERE s.slug IN ('okx_web3_solana', 'binance_web3_bsc', 'btcc_futures')
  AND ts.win_rate IS NOT NULL;

INSERT INTO formal_win_rate_cleanup_candidates
SELECT
  'onchain_formal_fill'::text AS cleanup_class,
  r.trader_id,
  r.timeframe,
  r.win_rate AS previous_win_rate,
  NULL::numeric AS restored_win_rate,
  NULL::numeric AS derived_window_win_rate
FROM formal_win_rate_rows AS r
WHERE r.slug IN ('okx_web3_solana', 'binance_web3_bsc')
  AND r.timeframe = 90
  AND r.onchain_enriched
  AND r.win_rate = r.chain_win_rate
  AND NOT r.exchange_profile_written
  AND NOT r.seen_as_native_headline
UNION ALL
SELECT
  'btcc_derived_window_ratio'::text,
  r.trader_id,
  r.timeframe,
  r.win_rate,
  r.exchange_all_time_win_rate,
  pg_catalog.round(r.window_ratio_pct, 2)
FROM formal_win_rate_rows AS r
WHERE r.slug = 'btcc_futures'
  AND pg_catalog.abs(r.win_rate - r.window_ratio_pct) <= 0.005
  AND r.exchange_all_time_win_rate BETWEEN 0 AND 100
  AND r.exchange_all_time_win_rate <> r.win_rate
  AND NOT r.seen_as_native_headline;

DO $cleanup$
DECLARE
  v_onchain bigint;
  v_btcc bigint;
  v_updated bigint;
  v_gap_refreshed bigint;
  v_gap_profiled bigint;
  v_gap_btcc bigint;
BEGIN
  SELECT
    pg_catalog.count(*) FILTER (WHERE cleanup_class = 'onchain_formal_fill'),
    pg_catalog.count(*) FILTER (WHERE cleanup_class = 'btcc_derived_window_ratio')
  INTO v_onchain, v_btcc
  FROM formal_win_rate_cleanup_candidates;

  IF v_onchain + v_btcc > 20000 THEN
    RAISE EXCEPTION
      'formal win-rate cleanup refused: % candidates exceeds safety cap 20000', v_onchain + v_btcc;
  END IF;

  UPDATE arena.trader_stats AS ts
  SET
    win_rate = NULL,
    extras = ts.extras || pg_catalog.jsonb_build_object(
      'onchain_typed_win_rate_quarantine',
      pg_catalog.jsonb_build_object(
        'value', c.previous_win_rate,
        'at', pg_catalog.statement_timestamp(),
        'reason', 'onchain_derived_value_in_formal_column',
        'migration', '20261113150757'
      )
    )
  FROM formal_win_rate_cleanup_candidates AS c
  WHERE c.cleanup_class = 'onchain_formal_fill'
    AND ts.trader_id = c.trader_id
    AND ts.timeframe = c.timeframe
    AND ts.win_rate = c.previous_win_rate;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> v_onchain THEN
    RAISE EXCEPTION 'on-chain cleanup updated % rows, expected %', v_updated, v_onchain;
  END IF;

  -- Derived-ratio keys are added only when absent (existing keys win), then
  -- the archive marker is merged last.
  UPDATE arena.trader_stats AS ts
  SET
    win_rate = c.restored_win_rate,
    extras = pg_catalog.jsonb_build_object(
        'derived_window_win_rate_pct', c.derived_window_win_rate,
        'derived_window_win_rate_basis', 'totalWinTradeNum/totalTradeNum (Arena-derived)'
      )
      || ts.extras
      || pg_catalog.jsonb_build_object(
        'formal_win_rate_cleanup',
        pg_catalog.jsonb_build_object(
          'previous_value', c.previous_win_rate,
          'restored_from', 'extras.all_time.win_rate',
          'at', pg_catalog.statement_timestamp(),
          'reason', 'arena_derived_ratio_replaced_by_exchange_value',
          'migration', '20261113150757'
        )
      )
  FROM formal_win_rate_cleanup_candidates AS c
  WHERE c.cleanup_class = 'btcc_derived_window_ratio'
    AND ts.trader_id = c.trader_id
    AND ts.timeframe = c.timeframe
    AND ts.win_rate = c.previous_win_rate;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> v_btcc THEN
    RAISE EXCEPTION 'btcc cleanup updated % rows, expected %', v_updated, v_btcc;
  END IF;

  -- Unprovable remainder: counted for the owner, never mutated.
  SELECT
    pg_catalog.count(*) FILTER (
      WHERE r.slug IN ('okx_web3_solana', 'binance_web3_bsc')
        AND r.timeframe = 90
        AND r.onchain_enriched
        AND r.win_rate IS DISTINCT FROM r.chain_win_rate
        AND NOT r.exchange_profile_written
        AND NOT r.seen_as_native_headline
    ),
    pg_catalog.count(*) FILTER (
      WHERE r.slug = 'okx_web3_solana'
        AND r.timeframe = 90
        AND r.onchain_enriched
        AND r.win_rate = r.chain_win_rate
        AND r.exchange_profile_written
        AND NOT r.seen_as_native_headline
    ),
    pg_catalog.count(*) FILTER (
      WHERE r.slug = 'btcc_futures'
        AND pg_catalog.abs(r.win_rate - r.window_ratio_pct) <= 0.005
        AND r.exchange_all_time_win_rate IS NULL
        AND NOT r.seen_as_native_headline
    )
  INTO v_gap_refreshed, v_gap_profiled, v_gap_btcc
  FROM formal_win_rate_rows AS r;

  RAISE NOTICE
    'formal win-rate cleanup: onchain nulled=%, btcc restored=%; unprovable left untouched: web3 refreshed=%, okx profiled=%, btcc without all_time=%',
    v_onchain, v_btcc, v_gap_refreshed, v_gap_profiled, v_gap_btcc;
END
$cleanup$;

COMMIT;
