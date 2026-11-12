-- Launch-sequence restore after Binance Spot contract registration. Launch
-- slot: immediately after 20260722053000_binance_spot_metric_source_contract.sql
-- (and before 20260722054000/055000). Pairs with
-- 20261111191927_binance_spot_contract_registration_serving_hold.sql.
--
-- Returns binance_spot to serving only if the hold marked it and 053 has
-- committed its exact ledger row, then removes the marker. Without the marker
-- this is a no-op, so replay is safe.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

LOCK TABLE arena.sources IN SHARE ROW EXCLUSIVE MODE;

DO $restore$
DECLARE
  v_updated integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM arena.sources AS source
    WHERE source.slug = 'binance_spot'
      AND source.meta->>'launch_contract_registration_hold' = '20260722053000'
  ) THEN
    RETURN;
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM supabase_migrations.schema_migrations AS ledger
    WHERE ledger.version = '20260722053000'
      AND ledger.name = 'binance_spot_metric_source_contract'
  ) <> 1 THEN
    RAISE EXCEPTION 'Binance Spot serving restore requires the committed 20260722053000 ledger row';
  END IF;

  UPDATE arena.sources AS source
  SET
    serving_mode = 'serving',
    meta = source.meta - 'launch_contract_registration_hold'
  WHERE source.slug = 'binance_spot'
    AND source.status = 'active'
    AND source.serving_mode = 'shadow'
    AND source.meta->>'launch_contract_registration_hold' = '20260722053000';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'Binance Spot serving restore updated % rows', v_updated;
  END IF;
END
$restore$;

COMMIT;
