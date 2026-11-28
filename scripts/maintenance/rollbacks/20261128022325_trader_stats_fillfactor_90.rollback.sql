-- Rollback of 20261128022325_trader_stats_fillfactor_90.sql.
-- Restores the default fillfactor (100) of arena.trader_stats: reloptions empty,
-- as before the migration. Runs only when reloptions are exactly
-- {fillfactor=90} (or already empty, a no-op). Not a migration: applied by
-- hand only inside an owner-approved window. Does not rewrite the table; pages
-- already written keep their free space until they are filled again.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
DECLARE
  v_options text[];
BEGIN
  SELECT c.reloptions INTO v_options
    FROM pg_catalog.pg_class AS c
   WHERE c.oid = 'arena.trader_stats'::regclass;
  IF v_options IS NOT NULL
     AND v_options IS DISTINCT FROM ARRAY['fillfactor=90']::text[] THEN
    RAISE EXCEPTION 'arena.trader_stats has storage parameters % that 20261128022325 did not set; refusing', v_options;
  END IF;
END
$preflight$;

ALTER TABLE arena.trader_stats RESET (fillfactor);

DO $postflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS c
     WHERE c.oid = 'arena.trader_stats'::regclass AND c.reloptions IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'arena.trader_stats still has storage parameters';
  END IF;
END
$postflight$;

COMMIT;
