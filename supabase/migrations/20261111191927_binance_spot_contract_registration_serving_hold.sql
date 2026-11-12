-- Launch-sequence hold for Binance Spot contract registration. Launch slot:
-- immediately before 20260722053000_binance_spot_metric_source_contract.sql,
-- with 20261111191928_binance_spot_contract_registration_serving_restore.sql
-- immediately after it.
--
-- 20260722053000 registers provenance-only metric source contracts and refuses
-- a source that is publicly serving. In the 2026-10-30 production backup
-- binance_spot is active/serving, and the owner decided on 2026-11-11 to keep
-- it on the leaderboard. 20260722055000 requires 053's exact immutable ledger
-- body, so 053 is applied unchanged: this migration moves binance_spot to
-- shadow for that one step and marks it, and the restore migration returns it
-- to serving. The contracts never feed public ranking (rerank, the public
-- ranked leaderboard, and the freshness gate do not read them).
--
-- Only an active/serving binance_spot with no contracts yet is held; any other
-- state is left alone so the original 053 preflight decides.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

LOCK TABLE arena.sources IN SHARE ROW EXCLUSIVE MODE;

DO $hold$
DECLARE
  v_updated integer;
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.metric_source_contracts') IS NULL THEN
    RAISE EXCEPTION 'Binance Spot serving hold requires arena.sources and metric_source_contracts';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM supabase_migrations.schema_migrations AS ledger
    WHERE ledger.version = '20260722053000'
       OR ledger.name = 'binance_spot_metric_source_contract'
  ) THEN
    RAISE EXCEPTION 'Binance Spot serving hold must run before 20260722053000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'arena.sources'::pg_catalog.regclass
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Binance Spot serving hold requires arena.sources without mutation triggers';
  END IF;

  UPDATE arena.sources AS source
  SET
    serving_mode = 'shadow',
    meta = source.meta || pg_catalog.jsonb_build_object(
      'launch_contract_registration_hold', '20260722053000'
    )
  WHERE source.slug = 'binance_spot'
    AND source.status = 'active'
    AND source.serving_mode = 'serving'
    AND pg_catalog.jsonb_typeof(source.meta) = 'object'
    AND NOT source.meta ? 'launch_contract_registration_hold'
    AND NOT EXISTS (
      SELECT 1
      FROM arena.metric_source_contracts AS contract
      WHERE contract.source_id = source.id
    );

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated > 1 THEN
    RAISE EXCEPTION 'Binance Spot serving hold matched % rows', v_updated;
  END IF;
END
$hold$;

COMMIT;
