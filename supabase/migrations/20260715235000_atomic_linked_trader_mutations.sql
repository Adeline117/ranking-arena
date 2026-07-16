-- Keep the linked-trader primary row, profile projection, and linked count in
-- one transaction. The previous API cleared the current primary before it had
-- proved that the requested target belonged to the user, and unlink performed
-- several independently-failable writes.

BEGIN;

LOCK TABLE public.user_linked_traders IN SHARE ROW EXCLUSIVE MODE;

-- Repair historical zero/multi-primary drift deterministically before adding
-- the invariant. Every user with at least one linked trader gets exactly one
-- primary row.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY user_id
      ORDER BY is_primary DESC NULLS LAST, display_order ASC NULLS LAST,
               created_at ASC NULLS LAST, id ASC
    ) AS primary_rank
  FROM public.user_linked_traders
)
UPDATE public.user_linked_traders AS linked
SET is_primary = ranked.primary_rank = 1,
    updated_at = pg_catalog.now()
FROM ranked
WHERE linked.id = ranked.id
  AND linked.is_primary IS DISTINCT FROM (ranked.primary_rank = 1);

CREATE UNIQUE INDEX IF NOT EXISTS user_linked_traders_one_primary_per_user
  ON public.user_linked_traders (user_id)
  WHERE is_primary IS TRUE;

-- Repair the denormalized profile projection for users represented in the
-- junction table. Profiles without junction rows may still use legacy claim
-- data, so this migration intentionally does not clear those rows globally.
WITH linked_projection AS (
  SELECT
    primary_link.user_id,
    primary_link.trader_id,
    primary_link.source,
    counts.linked_count
  FROM public.user_linked_traders AS primary_link
  JOIN (
    SELECT user_id, pg_catalog.count(*)::integer AS linked_count
    FROM public.user_linked_traders
    GROUP BY user_id
  ) AS counts USING (user_id)
  WHERE primary_link.is_primary IS TRUE
)
UPDATE public.user_profiles AS profile
SET is_verified_trader = true,
    verified_trader_id = projection.trader_id,
    verified_trader_source = projection.source,
    linked_trader_count = projection.linked_count,
    updated_at = pg_catalog.now()
FROM linked_projection AS projection
WHERE profile.id = projection.user_id;

CREATE OR REPLACE FUNCTION public.set_primary_linked_trader(
  p_user_id uuid,
  p_link_id uuid
)
RETURNS public.user_linked_traders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_target public.user_linked_traders%ROWTYPE;
  v_linked_count integer;
BEGIN
  IF p_user_id IS NULL OR p_link_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'user id and linked trader id are required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('linked-trader:' || p_user_id::text, 0)
  );

  -- Ownership is proved under lock before any row is changed.
  SELECT linked.*
  INTO v_target
  FROM public.user_linked_traders AS linked
  WHERE linked.id = p_link_id
    AND linked.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'linked trader not found';
  END IF;

  UPDATE public.user_linked_traders AS linked
  SET is_primary = false,
      updated_at = pg_catalog.now()
  WHERE linked.user_id = p_user_id
    AND linked.id <> p_link_id
    AND linked.is_primary IS TRUE;

  UPDATE public.user_linked_traders AS linked
  SET is_primary = true,
      updated_at = pg_catalog.now()
  WHERE linked.id = p_link_id
    AND linked.user_id = p_user_id
    AND linked.is_primary IS DISTINCT FROM true;

  SELECT linked.*
  INTO STRICT v_target
  FROM public.user_linked_traders AS linked
  WHERE linked.id = p_link_id
    AND linked.user_id = p_user_id;

  SELECT pg_catalog.count(*)::integer
  INTO v_linked_count
  FROM public.user_linked_traders AS linked
  WHERE linked.user_id = p_user_id;

  UPDATE public.user_profiles
  SET is_verified_trader = true,
      verified_trader_id = v_target.trader_id,
      verified_trader_source = v_target.source,
      linked_trader_count = v_linked_count,
      updated_at = pg_catalog.now()
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'user profile not found';
  END IF;

  RETURN v_target;
END;
$$;

CREATE OR REPLACE FUNCTION public.unlink_linked_trader(
  p_user_id uuid,
  p_link_id uuid
)
RETURNS TABLE (
  remaining_count integer,
  removed_trader_id text,
  removed_source text,
  promoted_link_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_existing public.user_linked_traders%ROWTYPE;
  v_primary public.user_linked_traders%ROWTYPE;
  v_remaining_count integer;
  v_promoted_link_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_link_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'user id and linked trader id are required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('linked-trader:' || p_user_id::text, 0)
  );

  SELECT linked.*
  INTO v_existing
  FROM public.user_linked_traders AS linked
  WHERE linked.id = p_link_id
    AND linked.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'linked trader not found';
  END IF;

  DELETE FROM public.user_linked_traders AS linked
  WHERE linked.id = p_link_id
    AND linked.user_id = p_user_id;

  SELECT pg_catalog.count(*)::integer
  INTO v_remaining_count
  FROM public.user_linked_traders AS linked
  WHERE linked.user_id = p_user_id;

  IF v_remaining_count = 0 THEN
    UPDATE public.user_profiles
    SET is_verified_trader = false,
        verified_trader_id = NULL,
        verified_trader_source = NULL,
        linked_trader_count = 0,
        updated_at = pg_catalog.now()
    WHERE id = p_user_id;
  ELSE
    SELECT linked.*
    INTO v_primary
    FROM public.user_linked_traders AS linked
    WHERE linked.user_id = p_user_id
      AND linked.is_primary IS TRUE
    ORDER BY linked.display_order ASC NULLS LAST,
             linked.created_at ASC NULLS LAST,
             linked.id ASC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
      SELECT linked.*
      INTO STRICT v_primary
      FROM public.user_linked_traders AS linked
      WHERE linked.user_id = p_user_id
      ORDER BY linked.display_order ASC NULLS LAST,
               linked.created_at ASC NULLS LAST,
               linked.id ASC
      LIMIT 1
      FOR UPDATE;

      UPDATE public.user_linked_traders
      SET is_primary = true,
          updated_at = pg_catalog.now()
      WHERE id = v_primary.id;

      v_promoted_link_id := v_primary.id;
    END IF;

    UPDATE public.user_profiles
    SET is_verified_trader = true,
        verified_trader_id = v_primary.trader_id,
        verified_trader_source = v_primary.source,
        linked_trader_count = v_remaining_count,
        updated_at = pg_catalog.now()
    WHERE id = p_user_id;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'user profile not found';
  END IF;

  RETURN QUERY
  SELECT
    v_remaining_count,
    v_existing.trader_id,
    v_existing.source,
    v_promoted_link_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_primary_linked_trader(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unlink_linked_trader(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_primary_linked_trader(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.unlink_linked_trader(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.set_primary_linked_trader(uuid, uuid) IS
  'Service-only atomic primary switch after locked ownership validation.';
COMMENT ON FUNCTION public.unlink_linked_trader(uuid, uuid) IS
  'Service-only atomic unlink, primary promotion, and profile projection update.';

NOTIFY pgrst, 'reload schema';

COMMIT;
