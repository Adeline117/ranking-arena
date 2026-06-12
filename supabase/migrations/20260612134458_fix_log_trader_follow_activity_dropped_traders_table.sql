-- Fix: POST /api/follow 500s on every follow.
--
-- Root cause: AFTER INSERT trigger `trg_log_trader_follow_activity` on
-- public.trader_follows calls log_trader_follow_activity(), which did
-- `SELECT handle FROM traders WHERE id = NEW.trader_id`. The legacy `traders`
-- table was dropped in the schema cleanup, so every INSERT into
-- trader_follows failed with 42P01 "relation \"traders\" does not exist".
--
-- Fix:
--   1. Resolve the trader handle from `trader_sources` instead (best effort;
--      trader_follows.trader_id stores the source trader key, sometimes
--      prefixed "source:source_trader_id").
--   2. Guard the activity log with an EXCEPTION handler so schema drift in
--      the (non-critical) activity log can never block follows again.

CREATE OR REPLACE FUNCTION public.log_trader_follow_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trader_handle text;
BEGIN
  BEGIN
    SELECT handle INTO v_trader_handle
    FROM trader_sources
    WHERE source_trader_id = NEW.trader_id
       OR (source || ':' || source_trader_id) = NEW.trader_id
    LIMIT 1;

    INSERT INTO user_activities (user_id, activity_type, target_type, target_id, metadata)
    VALUES (
      NEW.user_id,
      'follow_trader',
      'trader',
      NEW.trader_id::text,
      jsonb_build_object('trader_handle', COALESCE(v_trader_handle, ''))
    );
  EXCEPTION WHEN OTHERS THEN
    -- Activity logging is best-effort: never block the follow itself.
    RAISE WARNING 'log_trader_follow_activity failed: %', SQLERRM;
  END;
  RETURN NEW;
END;
$function$;
