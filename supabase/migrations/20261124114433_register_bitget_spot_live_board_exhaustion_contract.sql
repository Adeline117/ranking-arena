-- Migration: 20261124114433_register_bitget_spot_live_board_exhaustion_contract.sql
-- Description: Register bitget_spot as a live board in
--   arena.leaderboard_exhaustion_contracts (the reviewed copy of
--   BITGET_SPOT_LEADERBOARD_EXHAUSTION in lib/ingest/adapters/bitget/index.ts).
--
-- Why: the board is ~5,400 traders in 181 pages of 30, about eight minutes
--   per window at the paced request budget. Ranks move while it is paged, so
--   a trader crossing the cursor is read twice and another slides past
--   unread. The total mode (accepted rows = data.maxShowSizes, no duplicate
--   row) therefore refused every capture: production 2026-11 reported 5,414,
--   observed 5,414 and accepted 5,410-5,412 with 2-4 duplicate rows, and the
--   source's publication witness expired. A public probe on 2026-11-24
--   (eight full reads over 7/30/90 days at the paced interval) found a real
--   short final page (page 181, 15 rows) followed by an empty page on every
--   read, a reported total that moved by 0-1, and 1-6 rows read twice with
--   as many missing. Its capture now reads to the short or empty final page
--   and is proven complete by bounded drift (20261118114230): the total each
--   page reports, the distinct rows against the last total and the duplicate
--   rows each stay within 0.35% of the last reported total (max_drift_bps 35,
--   18 rows at 5,415, three times the largest measured drift), and never
--   above max_duplicate_rows (20).
--
--   The allowance is the most rows a capture judged complete may be missing.
--   The registry is append-only, so the declaration cannot be changed later:
--   it is a share of the board, with a tight absolute cap.
--
--   bitget_cfd and bitget_futures share the adapter and are not registered:
--   their captures stay in the total mode.
--
-- POSTDEPLOY, after 20261118114230 (which makes this declaration valid). The
-- worker release that captures bitget_spot in this mode must be deployed
-- before or with this file: until both are in place its capture is refused as
-- it was before.
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
CREATE TEMPORARY TABLE bitget_spot_live_board_seed (
  source_slug text PRIMARY KEY,
  declaration jsonb NOT NULL
);

INSERT INTO bitget_spot_live_board_seed VALUES
  ('bitget_spot',
   '{"completeness_mode": "exhausted", "list_path": ["data", "rows"], "row_key_path": ["traderUid"], "end_signal": {"kind": "short_page"}, "board_version": {"kind": "reported_total_drift", "path": ["data", "maxShowSizes"], "max_drift_bps": 35}, "max_duplicate_rows": 20}');

DO $preflight$
DECLARE
  v_bad text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM bitget_spot_live_board_seed AS seed
     WHERE NOT arena.leaderboard_exhaustion_declaration_valid(seed.declaration)
  ) THEN
    RAISE EXCEPTION 'bitget_spot live board registration requires the reported_total_drift proof (20261118114230)';
  END IF;

  SELECT pg_catalog.string_agg(seed.source_slug, ', ' ORDER BY seed.source_slug)
    INTO v_bad
    FROM bitget_spot_live_board_seed AS seed
   WHERE NOT EXISTS (
     SELECT 1
       FROM arena.sources AS source_row
      WHERE source_row.slug = seed.source_slug
        AND source_row.adapter_slug = 'bitget'
        AND source_row.page_size IS NOT NULL
   );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'bitget_spot live board registration source drift: %', v_bad;
  END IF;

  SELECT pg_catalog.string_agg(seed.source_slug, ', ' ORDER BY seed.source_slug)
    INTO v_bad
    FROM bitget_spot_live_board_seed AS seed
    JOIN arena.sources AS source_row ON source_row.slug = seed.source_slug
    JOIN arena.leaderboard_exhaustion_contracts AS contract
      ON contract.source_id = source_row.id;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'bitget_spot live board registration already exists for: %', v_bad;
  END IF;
END
$preflight$;

INSERT INTO arena.leaderboard_exhaustion_contracts (
  source_id, completeness_contract, declaration
)
SELECT source_row.id,
       'arena.ingest.leaderboard-exhaustion-completeness@1',
       seed.declaration
  FROM bitget_spot_live_board_seed AS seed
  JOIN arena.sources AS source_row ON source_row.slug = seed.source_slug
 ORDER BY source_row.id;

DO $postflight$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
      FROM bitget_spot_live_board_seed AS seed
      JOIN arena.sources AS source_row ON source_row.slug = seed.source_slug
      JOIN arena.leaderboard_exhaustion_contracts AS contract
        ON contract.source_id = source_row.id
       AND contract.declaration = seed.declaration
  ) <> 1 THEN
    RAISE EXCEPTION 'bitget_spot live board registration postflight failed';
  END IF;
END
$postflight$;

COMMIT;
