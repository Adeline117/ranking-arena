-- Keep follow activity logs on the exact exchange account.
--
-- The existing trigger resolves a handle by raw trader_id with LIMIT 1, so two
-- exchanges reusing the same id can record the wrong trader. Preserve target_id
-- compatibility while adding source and a stable composite identity to metadata.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('public.trader_follows') IS NULL
     OR pg_catalog.to_regclass('public.trader_sources') IS NULL
     OR pg_catalog.to_regclass('public.user_activities') IS NULL THEN
    RAISE EXCEPTION 'trader follow activity dependencies are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.trader_follows'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_log_trader_follow_activity'
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'trg_log_trader_follow_activity is missing';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.log_trader_follow_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_trader_handle text;
BEGIN
  BEGIN
    -- A NULL source is ambiguous legacy data. Log it without a guessed handle.
    IF NEW.source IS NOT NULL AND pg_catalog.btrim(NEW.source) <> '' THEN
      SELECT source_row.handle
      INTO v_trader_handle
      FROM public.trader_sources AS source_row
      WHERE source_row.source = NEW.source
        AND (
          source_row.source_trader_id = NEW.trader_id
          OR (source_row.source || ':' || source_row.source_trader_id)
               = NEW.trader_id
        )
      LIMIT 1;
    END IF;

    INSERT INTO public.user_activities (
      user_id,
      activity_type,
      target_type,
      target_id,
      metadata
    )
    VALUES (
      NEW.user_id,
      'follow_trader',
      'trader',
      NEW.trader_id::text,
      pg_catalog.jsonb_build_object(
        'trader_handle', COALESCE(v_trader_handle, ''),
        'source', NEW.source,
        'identity_key', pg_catalog.jsonb_build_array(NEW.trader_id, NEW.source)
      )
    );
  EXCEPTION WHEN OTHERS THEN
    -- Activity logging is best-effort: never block the follow itself.
    RAISE WARNING 'log_trader_follow_activity failed: %', SQLERRM;
  END;
  RETURN NEW;
END
$function$;

DO $postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid =
      'public.log_trader_follow_activity()'::pg_catalog.regprocedure
      AND procedure.prosecdef
      AND procedure.proconfig @> ARRAY[
        'search_path=pg_catalog, public, pg_temp'
      ]::text[]
  ) THEN
    RAISE EXCEPTION 'source-scoped follow activity function postflight failed';
  END IF;
END
$postflight$;

COMMIT;
