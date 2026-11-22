-- Migration: 20261120190124_register_bybit_mt5_live_board_exhaustion_contract.sql
-- Description: Register bybit_mt5 as a live board in
--   arena.leaderboard_exhaustion_contracts (the reviewed copy of
--   BYBIT_MT5_LEADERBOARD_EXHAUSTION in lib/ingest/adapters/bybit-mt5/index.ts).
--
-- Why: the board is ~32,600 traders in fixed pages of 16 (the server ignores
--   pageSize), about 2,040 requests and 107 minutes per window. Members join
--   and leave while it is paged, so the reported total moves by a few rows
--   and a row or two repeats (measured 2026-11-18/19: totals 32603-32615,
--   1-5 duplicate rows), and the total mode refused every capture. Its
--   capture now reads to the short or empty final page and is proven complete
--   by bounded drift (20261118114230): the total each page reports, the
--   distinct rows against the last total and the duplicate rows each stay
--   within 0.1% of the last reported total (max_drift_bps 10, about 32 rows),
--   and never above max_duplicate_rows (100).
--
--   The allowance is the most rows a capture judged complete may be missing.
--   The registry is append-only, so the declaration cannot be changed later:
--   it is a share of the board, with a tight absolute cap.
--
-- POSTDEPLOY, after 20261118114230 (which makes this declaration valid). The
-- worker release that captures bybit_mt5 in this mode must be deployed before
-- or with this file: until both are in place its capture is refused as it
-- was before.
--
-- A missing or re-adaptered source, an existing registration (including a
-- replay) or a database without 20261118114230 refuses the whole migration.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

LOCK TABLE arena.sources IN SHARE MODE;
LOCK TABLE arena.leaderboard_exhaustion_contracts IN SHARE ROW EXCLUSIVE MODE;

-- Session-local seed (pg_temp); it disappears with the applying session.
CREATE TEMPORARY TABLE bybit_mt5_live_board_seed (
  source_slug text PRIMARY KEY,
  declaration jsonb NOT NULL
);

INSERT INTO bybit_mt5_live_board_seed VALUES
  ('bybit_mt5',
   '{"completeness_mode": "exhausted", "list_path": ["result", "providerDetailsList"], "row_key_path": ["providerMark"], "end_signal": {"kind": "short_page"}, "board_version": {"kind": "reported_total_drift", "path": ["result", "totalCount"], "max_drift_bps": 10}, "max_duplicate_rows": 100}');

DO $preflight$
DECLARE
  v_bad text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM bybit_mt5_live_board_seed AS seed
     WHERE NOT arena.leaderboard_exhaustion_declaration_valid(seed.declaration)
  ) THEN
    RAISE EXCEPTION 'bybit_mt5 live board registration requires the reported_total_drift proof (20261118114230)';
  END IF;

  SELECT pg_catalog.string_agg(seed.source_slug, ', ' ORDER BY seed.source_slug)
    INTO v_bad
    FROM bybit_mt5_live_board_seed AS seed
   WHERE NOT EXISTS (
     SELECT 1
       FROM arena.sources AS source_row
      WHERE source_row.slug = seed.source_slug
        AND source_row.adapter_slug = 'bybit_mt5'
        AND source_row.page_size IS NOT NULL
   );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'bybit_mt5 live board registration source drift: %', v_bad;
  END IF;

  SELECT pg_catalog.string_agg(seed.source_slug, ', ' ORDER BY seed.source_slug)
    INTO v_bad
    FROM bybit_mt5_live_board_seed AS seed
    JOIN arena.sources AS source_row ON source_row.slug = seed.source_slug
    JOIN arena.leaderboard_exhaustion_contracts AS contract
      ON contract.source_id = source_row.id;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'bybit_mt5 live board registration already exists for: %', v_bad;
  END IF;
END
$preflight$;

INSERT INTO arena.leaderboard_exhaustion_contracts (
  source_id, completeness_contract, declaration
)
SELECT source_row.id,
       'arena.ingest.leaderboard-exhaustion-completeness@1',
       seed.declaration
  FROM bybit_mt5_live_board_seed AS seed
  JOIN arena.sources AS source_row ON source_row.slug = seed.source_slug
 ORDER BY source_row.id;

DO $postflight$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
      FROM bybit_mt5_live_board_seed AS seed
      JOIN arena.sources AS source_row ON source_row.slug = seed.source_slug
      JOIN arena.leaderboard_exhaustion_contracts AS contract
        ON contract.source_id = source_row.id
       AND contract.declaration = seed.declaration
  ) <> 1 THEN
    RAISE EXCEPTION 'bybit_mt5 live board registration postflight failed';
  END IF;
END
$postflight$;

COMMIT;
