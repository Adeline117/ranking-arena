-- P1-4: Nightly reconcile for handle/avatar consistency across trader_sources and trader_profiles.

CREATE TABLE IF NOT EXISTS public.trader_reconcile_audit (
  id bigserial PRIMARY KEY,
  run_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  source_trader_id text NOT NULL,
  field text NOT NULL,
  old_value text,
  new_value text
);

CREATE OR REPLACE FUNCTION public.reconcile_handle_avatar_nightly()
RETURNS TABLE(updated_profiles bigint, updated_sources bigint) AS $$
DECLARE
  v_profiles bigint := 0;
  v_sources bigint := 0;
BEGIN
  -- Prefer non-empty handle/avatar from trader_sources to backfill trader_profiles.
  UPDATE public.trader_profiles tp
  SET
    display_name = COALESCE(NULLIF(tp.display_name, ''), NULLIF(ts.handle, ''), tp.display_name),
    avatar_url = COALESCE(NULLIF(tp.avatar_url, ''), NULLIF(ts.avatar_url, ''), tp.avatar_url)
  FROM public.trader_sources ts
  WHERE tp.platform = ts.source
    AND tp.trader_key = ts.source_trader_id
    AND (
      (COALESCE(NULLIF(tp.display_name, ''), '') = '' AND COALESCE(NULLIF(ts.handle, ''), '') <> '')
      OR
      (COALESCE(NULLIF(tp.avatar_url, ''), '') = '' AND COALESCE(NULLIF(ts.avatar_url, ''), '') <> '')
    );

  GET DIAGNOSTICS v_profiles = ROW_COUNT;

  -- Backfill trader_sources from trader_profiles when source side is empty.
  UPDATE public.trader_sources ts
  SET
    handle = COALESCE(NULLIF(ts.handle, ''), NULLIF(tp.display_name, ''), ts.handle),
    avatar_url = COALESCE(NULLIF(ts.avatar_url, ''), NULLIF(tp.avatar_url, ''), ts.avatar_url)
  FROM public.trader_profiles tp
  WHERE tp.platform = ts.source
    AND tp.trader_key = ts.source_trader_id
    AND (
      (COALESCE(NULLIF(ts.handle, ''), '') = '' AND COALESCE(NULLIF(tp.display_name, ''), '') <> '')
      OR
      (COALESCE(NULLIF(ts.avatar_url, ''), '') = '' AND COALESCE(NULLIF(tp.avatar_url, ''), '') <> '')
    );

  GET DIAGNOSTICS v_sources = ROW_COUNT;

  updated_profiles := v_profiles;
  updated_sources := v_sources;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;
