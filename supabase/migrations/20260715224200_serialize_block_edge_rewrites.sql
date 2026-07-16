-- The original block-edge trigger serialized INSERT/DELETE and the NEW pair
-- of an UPDATE. If blocker_id/blocked_id were rewritten, an interaction could
-- authorize against the OLD pair while that relationship was being removed.
-- Lock every affected unordered pair in deterministic text order.

BEGIN;

CREATE OR REPLACE FUNCTION public.serialize_post_audience_block_edge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_pairs text[] := ARRAY[]::text[];
  v_pair text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE')
     AND OLD.blocker_id IS NOT NULL
     AND OLD.blocked_id IS NOT NULL
  THEN
    v_pairs := array_append(
      v_pairs,
      LEAST(OLD.blocker_id::text, OLD.blocked_id::text)
        || ':' || GREATEST(OLD.blocker_id::text, OLD.blocked_id::text)
    );
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE')
     AND NEW.blocker_id IS NOT NULL
     AND NEW.blocked_id IS NOT NULL
  THEN
    v_pairs := array_append(
      v_pairs,
      LEAST(NEW.blocker_id::text, NEW.blocked_id::text)
        || ':' || GREATEST(NEW.blocker_id::text, NEW.blocked_id::text)
    );
  END IF;

  FOR v_pair IN
    SELECT DISTINCT affected_pair
    FROM unnest(v_pairs) AS affected(affected_pair)
    ORDER BY affected_pair
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('post-audience:block:' || v_pair, 0)
    );
  END LOOP;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

REVOKE ALL ON FUNCTION public.serialize_post_audience_block_edge()
  FROM PUBLIC, anon, authenticated, service_role;

-- Recreate the trigger so catalog drift cannot leave an older event mask or
-- a same-name trigger pointing at a different function OID.
DROP TRIGGER IF EXISTS trg_serialize_post_audience_block_edge ON public.blocked_users;
CREATE TRIGGER trg_serialize_post_audience_block_edge
BEFORE INSERT OR DELETE OR UPDATE OF blocker_id, blocked_id
ON public.blocked_users
FOR EACH ROW
EXECUTE FUNCTION public.serialize_post_audience_block_edge();

COMMENT ON FUNCTION public.serialize_post_audience_block_edge() IS
  'Serializes block INSERT/DELETE and both OLD+NEW unordered actor pairs on endpoint-changing UPDATE against post interaction authorization.';

NOTIFY pgrst, 'reload schema';

COMMIT;
