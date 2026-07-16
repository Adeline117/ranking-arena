-- Transactional contract test for the explicit-actor post interaction gate.

BEGIN;

DO $$
DECLARE
  v_author uuid := '12400000-0000-4000-8000-000000000001';
  v_root_author uuid := '12400000-0000-4000-8000-000000000002';
  v_viewer uuid := '12400000-0000-4000-8000-000000000003';
  v_member uuid := '12400000-0000-4000-8000-000000000004';
  v_group uuid := '22400000-0000-4000-8000-000000000001';
BEGIN
  INSERT INTO auth.users (id, aud, role, created_at, updated_at)
  VALUES
    (v_author, 'authenticated', 'authenticated', now(), now()),
    (v_root_author, 'authenticated', 'authenticated', now(), now()),
    (v_viewer, 'authenticated', 'authenticated', now(), now()),
    (v_member, 'authenticated', 'authenticated', now(), now());

  INSERT INTO public.users (id, nickname)
  VALUES
    (v_author, 'interaction-author'),
    (v_root_author, 'interaction-root-author'),
    (v_viewer, 'interaction-viewer'),
    (v_member, 'interaction-member')
  ON CONFLICT (id) DO UPDATE SET nickname = EXCLUDED.nickname;

  UPDATE public.user_profiles
  SET banned_at = NULL, deleted_at = NULL
  WHERE id IN (v_author, v_root_author, v_viewer, v_member);

  INSERT INTO public.groups (id, name, created_by, visibility)
  VALUES (v_group, 'interaction-apply-group', v_author, 'apply');
  INSERT INTO public.group_members (group_id, user_id, role)
  VALUES (v_group, v_member, 'member');

  INSERT INTO public.posts (
    id, title, content, author_id, author_handle, visibility, status, group_id,
    original_post_id, poll_enabled
  ) VALUES
    (
      '32400000-0000-4000-8000-000000000001', 'public', '', v_author,
      'interaction-author', 'public', 'active', NULL, NULL, false
    ),
    (
      '32400000-0000-4000-8000-000000000002', 'followers', '', v_author,
      'interaction-author', 'followers', 'active', NULL, NULL, false
    ),
    (
      '32400000-0000-4000-8000-000000000003', 'group', '', v_author,
      'interaction-author', 'group', 'active', v_group, NULL, false
    ),
    (
      '32400000-0000-4000-8000-000000000004', 'root', '', v_root_author,
      'interaction-root-author', 'public', 'active', NULL, NULL, false
    ),
    (
      '32400000-0000-4000-8000-000000000005', 'wrapper', '', v_author,
      'interaction-author', 'public', 'active', NULL,
      '32400000-0000-4000-8000-000000000004', false
    );
END
$$;

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);

DO $$
BEGIN
  IF NOT public.can_service_actor_read_post(
    '32400000-0000-4000-8000-000000000001',
    '12400000-0000-4000-8000-000000000003'
  ) THEN
    RAISE EXCEPTION 'service actor could not read an active public post';
  END IF;

  IF public.can_service_actor_read_post(
    '32400000-0000-4000-8000-000000000002',
    '12400000-0000-4000-8000-000000000003'
  ) THEN
    RAISE EXCEPTION 'non-follower read a follower post';
  END IF;

  IF public.can_service_actor_read_post(
    '32400000-0000-4000-8000-000000000003',
    '12400000-0000-4000-8000-000000000003'
  ) OR NOT public.can_service_actor_read_post(
    '32400000-0000-4000-8000-000000000003',
    '12400000-0000-4000-8000-000000000004'
  ) THEN
    RAISE EXCEPTION 'apply-group membership boundary drifted';
  END IF;

  IF NOT public.can_service_actor_read_post(
    '32400000-0000-4000-8000-000000000005',
    '12400000-0000-4000-8000-000000000003'
  ) THEN
    RAISE EXCEPTION 'readable wrapper/root pair was hidden';
  END IF;
END
$$;

RESET ROLE;
SELECT set_config('request.jwt.claim.role', '', true);

INSERT INTO public.blocked_users (blocker_id, blocked_id)
VALUES (
  '12400000-0000-4000-8000-000000000001',
  '12400000-0000-4000-8000-000000000003'
);

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
BEGIN
  IF public.can_service_actor_read_post(
    '32400000-0000-4000-8000-000000000001',
    '12400000-0000-4000-8000-000000000003'
  ) THEN
    RAISE EXCEPTION 'bidirectional block did not hide a public post';
  END IF;
END
$$;
RESET ROLE;
SELECT set_config('request.jwt.claim.role', '', true);

DELETE FROM public.blocked_users
WHERE blocker_id = '12400000-0000-4000-8000-000000000001'
  AND blocked_id = '12400000-0000-4000-8000-000000000003';

UPDATE public.posts
SET visibility = 'followers'
WHERE id = '32400000-0000-4000-8000-000000000004';

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
BEGIN
  IF public.can_service_actor_read_post(
    '32400000-0000-4000-8000-000000000005',
    '12400000-0000-4000-8000-000000000003'
  ) THEN
    RAISE EXCEPTION 'wrapper outlived its root audience';
  END IF;
END
$$;
RESET ROLE;
SELECT set_config('request.jwt.claim.role', '', true);

-- The posts restrictive policy must make the same root decision for direct
-- PostgREST/JWT reads, without relying on the service route.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '12400000-0000-4000-8000-000000000003', true);
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.posts
    WHERE id = '32400000-0000-4000-8000-000000000005'
  ) THEN
    RAISE EXCEPTION 'direct posts policy exposed wrapper with hidden root';
  END IF;

  IF has_function_privilege(
    'authenticated',
    'public.can_service_actor_read_post(uuid,uuid)',
    'EXECUTE'
  ) OR has_function_privilege(
    'service_role',
    'public.can_actor_read_post_fields(uuid,uuid,uuid,text,public.post_status,timestamptz)',
    'EXECUTE'
  ) OR has_function_privilege(
    'service_role',
    'public.lock_actor_can_interact_with_post(uuid,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'explicit-actor internals are callable by an API role';
  END IF;
END
$$;
RESET ROLE;

-- Owners/internal RPCs can take the transaction lock and receive the same
-- current decision. Child mutation RPCs call this private primitive.
DO $$
BEGIN
  IF NOT public.lock_actor_can_interact_with_post(
    '32400000-0000-4000-8000-000000000001',
    '12400000-0000-4000-8000-000000000003'
  ) OR public.lock_actor_can_interact_with_post(
    '32400000-0000-4000-8000-000000000002',
    '12400000-0000-4000-8000-000000000003'
  ) THEN
    RAISE EXCEPTION 'transaction interaction gate drifted from canonical read';
  END IF;
END
$$;

ROLLBACK;
