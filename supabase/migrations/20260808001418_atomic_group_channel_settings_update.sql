-- Channel settings updates must be authorized under the same lock that
-- serializes role changes.
--
-- PATCH /api/channels/[channelId] read the actor's channel_members role, then
-- issued a separate UPDATE on chat_channels through the service-role client
-- (which bypasses RLS). A demotion committed between the two statements let a
-- just-demoted member still rename, re-avatar, or re-describe the channel. It
-- was the last check-then-act write on the channel surface; add/remove and
-- dissolve already route through atomic RPCs.
--
-- The advisory key here is deliberately the SAME membership key the other
-- channel RPCs take, so a concurrent promotion/demotion either commits before
-- the role is read or waits behind this transaction.

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.chat_channels') IS NULL
    OR to_regclass('public.channel_members') IS NULL
  THEN
    RAISE EXCEPTION 'group channel settings prerequisites are missing';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.update_group_channel_atomic(
  p_channel_id uuid,
  p_actor_id uuid,
  p_updates jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_actor_role text;
  v_channel public.chat_channels%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_channel_id IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'channel and actor are required';
  END IF;

  IF p_updates IS NULL OR pg_catalog.jsonb_typeof(p_updates) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'updates object is required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'channel-membership:channel:' || p_channel_id::text,
      0
    )
  );

  -- Read the role under both the advisory lock and a tuple lock: the advisory
  -- key orders us against the other channel RPCs, the tuple lock against any
  -- direct write to this membership row.
  SELECT members.role
    INTO v_actor_role
  FROM public.channel_members AS members
  WHERE members.channel_id = p_channel_id
    AND members.user_id = p_actor_id
  FOR UPDATE;

  IF v_actor_role IS NULL OR v_actor_role NOT IN ('owner', 'admin') THEN
    RETURN pg_catalog.jsonb_build_object('status', 'forbidden');
  END IF;

  -- Key presence, not NULL-ness, decides what changes: the caller clears
  -- description by sending an explicit null, and omits keys it is not touching.
  UPDATE public.chat_channels AS channels
     SET name = CASE
                  WHEN pg_catalog.jsonb_exists(p_updates, 'name')
                    THEN p_updates ->> 'name'
                  ELSE channels.name
                END,
         avatar_url = CASE
                        WHEN pg_catalog.jsonb_exists(p_updates, 'avatar_url')
                          THEN p_updates ->> 'avatar_url'
                        ELSE channels.avatar_url
                      END,
         description = CASE
                         WHEN pg_catalog.jsonb_exists(p_updates, 'description')
                           THEN p_updates ->> 'description'
                         ELSE channels.description
                       END,
         updated_at = pg_catalog.now()
   WHERE channels.id = p_channel_id
  RETURNING channels.* INTO v_channel;

  IF v_channel.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'updated',
    'channel', pg_catalog.to_jsonb(v_channel)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.update_group_channel_atomic(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_group_channel_atomic(uuid, uuid, jsonb) TO service_role;

COMMIT;
