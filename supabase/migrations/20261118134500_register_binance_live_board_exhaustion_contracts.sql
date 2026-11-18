-- Migration: 20261118134500_register_binance_live_board_exhaustion_contracts.sql
-- Description: Register binance_futures and binance_spot as live boards in
--   arena.leaderboard_exhaustion_contracts (the reviewed copy of
--   BINANCE_FUTURES_/BINANCE_SPOT_LEADERBOARD_EXHAUSTION in
--   lib/ingest/adapters/binance/index.ts).
--
-- Why: both boards change while they are paged, so neither the total mode nor
--   a frozen-board exhaustion proof can ever hold for them (20261118114230).
--   Their capture now reads to the short or empty final page and is proven
--   complete by bounded drift: the total each page reports, the distinct rows
--   against the last total and the duplicate rows each stay within 1% of the
--   last reported total (max_drift_bps 100), and never above max_duplicate_rows
--   (500 rows for futures, 100 for spot: 1% of a board about four times
--   today's ~13,200 and ~2,470 traders).
--
--   The registry is append-only: these declarations cannot be changed later,
--   which is why the allowance is a share of the board and not a row count.
--
-- POSTDEPLOY, after 20261118114230 (which makes this declaration valid). The
-- worker release that captures binance in this mode must be deployed after
-- this file: until then a binance capture is refused as it was before.
--
-- A missing or re-adaptered source, an existing registration for either source
-- (including a replay) or a database without 20261118114230 refuses the whole
-- migration.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

LOCK TABLE arena.sources IN SHARE MODE;
LOCK TABLE arena.leaderboard_exhaustion_contracts IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMPORARY TABLE binance_live_board_seed (
  source_slug text PRIMARY KEY,
  declaration jsonb NOT NULL
) ON COMMIT DROP;

INSERT INTO binance_live_board_seed VALUES
  ('binance_futures',
   '{"completeness_mode": "exhausted", "list_path": ["data", "list"], "row_key_path": ["leadPortfolioId"], "end_signal": {"kind": "short_page"}, "board_version": {"kind": "reported_total_drift", "path": ["data", "total"], "max_drift_bps": 100}, "max_duplicate_rows": 500}'),
  ('binance_spot',
   '{"completeness_mode": "exhausted", "list_path": ["data", "list"], "row_key_path": ["leadPortfolioId"], "end_signal": {"kind": "short_page"}, "board_version": {"kind": "reported_total_drift", "path": ["data", "total"], "max_drift_bps": 100}, "max_duplicate_rows": 100}');

DO $preflight$
DECLARE
  v_bad text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM binance_live_board_seed AS seed
     WHERE NOT arena.leaderboard_exhaustion_declaration_valid(seed.declaration)
  ) THEN
    RAISE EXCEPTION 'binance live board registration requires the reported_total_drift proof (20261118114230)';
  END IF;

  SELECT pg_catalog.string_agg(seed.source_slug, ', ' ORDER BY seed.source_slug)
    INTO v_bad
    FROM binance_live_board_seed AS seed
   WHERE NOT EXISTS (
     SELECT 1
       FROM arena.sources AS source_row
      WHERE source_row.slug = seed.source_slug
        AND source_row.adapter_slug = 'binance'
        AND source_row.page_size IS NOT NULL
   );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'binance live board registration source drift: %', v_bad;
  END IF;

  SELECT pg_catalog.string_agg(seed.source_slug, ', ' ORDER BY seed.source_slug)
    INTO v_bad
    FROM binance_live_board_seed AS seed
    JOIN arena.sources AS source_row ON source_row.slug = seed.source_slug
    JOIN arena.leaderboard_exhaustion_contracts AS contract
      ON contract.source_id = source_row.id;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'binance live board registration already exists for: %', v_bad;
  END IF;
END
$preflight$;

INSERT INTO arena.leaderboard_exhaustion_contracts (
  source_id, completeness_contract, declaration
)
SELECT source_row.id,
       'arena.ingest.leaderboard-exhaustion-completeness@1',
       seed.declaration
  FROM binance_live_board_seed AS seed
  JOIN arena.sources AS source_row ON source_row.slug = seed.source_slug
 ORDER BY source_row.id;

DO $postflight$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
      FROM binance_live_board_seed AS seed
      JOIN arena.sources AS source_row ON source_row.slug = seed.source_slug
      JOIN arena.leaderboard_exhaustion_contracts AS contract
        ON contract.source_id = source_row.id
       AND contract.declaration = seed.declaration
  ) <> 2 THEN
    RAISE EXCEPTION 'binance live board registration postflight failed';
  END IF;
END
$postflight$;

COMMIT;
