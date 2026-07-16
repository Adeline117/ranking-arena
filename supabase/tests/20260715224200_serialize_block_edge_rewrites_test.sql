-- An endpoint-changing block UPDATE must hold both the removed and introduced
-- unordered actor-pair locks until commit.

BEGIN;

DO $$
DECLARE
  v_a uuid := '12420000-0000-4000-8000-000000000001';
  v_b uuid := '12420000-0000-4000-8000-000000000002';
  v_c uuid := '12420000-0000-4000-8000-000000000003';
  v_d uuid := '12420000-0000-4000-8000-000000000004';
  v_before integer;
  v_after integer;
BEGIN
  INSERT INTO auth.users (id, aud, role, created_at, updated_at)
  VALUES
    (v_a, 'authenticated', 'authenticated', now(), now()),
    (v_b, 'authenticated', 'authenticated', now(), now()),
    (v_c, 'authenticated', 'authenticated', now(), now()),
    (v_d, 'authenticated', 'authenticated', now(), now());

  INSERT INTO public.users (id, nickname)
  VALUES (v_a, 'block-a'), (v_b, 'block-b'), (v_c, 'block-c'), (v_d, 'block-d')
  ON CONFLICT (id) DO UPDATE SET nickname = EXCLUDED.nickname;

  -- Seed without acquiring the transaction advisory lock being measured.
  ALTER TABLE public.blocked_users
    DISABLE TRIGGER trg_serialize_post_audience_block_edge;
  INSERT INTO public.blocked_users (blocker_id, blocked_id)
  VALUES (v_a, v_b);
  ALTER TABLE public.blocked_users
    ENABLE TRIGGER trg_serialize_post_audience_block_edge;

  SELECT count(*) INTO v_before
  FROM pg_catalog.pg_locks
  WHERE pid = pg_catalog.pg_backend_pid()
    AND locktype = 'advisory'
    AND mode = 'ExclusiveLock';

  UPDATE public.blocked_users
  SET blocker_id = v_c, blocked_id = v_d
  WHERE blocker_id = v_a AND blocked_id = v_b;

  SELECT count(*) INTO v_after
  FROM pg_catalog.pg_locks
  WHERE pid = pg_catalog.pg_backend_pid()
    AND locktype = 'advisory'
    AND mode = 'ExclusiveLock';

  IF v_after - v_before <> 2 THEN
    RAISE EXCEPTION
      'endpoint rewrite held % new advisory locks instead of OLD+NEW pair',
      v_after - v_before;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    JOIN pg_catalog.pg_proc AS trigger_function
      ON trigger_function.oid = trigger_row.tgfoid
    WHERE trigger_row.tgrelid = 'public.blocked_users'::regclass
      AND trigger_row.tgname = 'trg_serialize_post_audience_block_edge'
      AND NOT trigger_row.tgisinternal
      AND trigger_function.oid = 'public.serialize_post_audience_block_edge()'::regprocedure
      AND trigger_row.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'block serialization trigger catalog contract drifted';
  END IF;

  IF has_function_privilege(
    'service_role',
    'public.serialize_post_audience_block_edge()',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.serialize_post_audience_block_edge()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'trigger-only block serializer is callable by an API role';
  END IF;
END
$$;

ROLLBACK;
