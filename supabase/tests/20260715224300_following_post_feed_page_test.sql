-- Transactional contract test for the service-only Following feed page.

BEGIN;

DO $$
DECLARE
  v_viewer uuid := '12430000-0000-4000-8000-000000000001';
  v_followed uuid := '12430000-0000-4000-8000-000000000002';
  v_blocked_by_viewer uuid := '12430000-0000-4000-8000-000000000003';
  v_blocks_viewer uuid := '12430000-0000-4000-8000-000000000004';
  v_unfollowed uuid := '12430000-0000-4000-8000-000000000005';
  v_root_author uuid := '12430000-0000-4000-8000-000000000006';
BEGIN
  INSERT INTO auth.users (id, aud, role, created_at, updated_at)
  VALUES
    (v_viewer, 'authenticated', 'authenticated', now(), now()),
    (v_followed, 'authenticated', 'authenticated', now(), now()),
    (v_blocked_by_viewer, 'authenticated', 'authenticated', now(), now()),
    (v_blocks_viewer, 'authenticated', 'authenticated', now(), now()),
    (v_unfollowed, 'authenticated', 'authenticated', now(), now()),
    (v_root_author, 'authenticated', 'authenticated', now(), now());

  INSERT INTO public.users (id, nickname)
  VALUES
    (v_viewer, 'following-viewer'),
    (v_followed, 'following-author'),
    (v_blocked_by_viewer, 'following-blocked-by-viewer'),
    (v_blocks_viewer, 'following-blocks-viewer'),
    (v_unfollowed, 'following-unfollowed'),
    (v_root_author, 'following-root-author')
  ON CONFLICT (id) DO UPDATE SET nickname = EXCLUDED.nickname;

  INSERT INTO public.user_profiles (id, handle, banned_at, deleted_at)
  VALUES
    (v_viewer, 'following-viewer', NULL, NULL),
    (v_followed, 'following-author', NULL, NULL),
    (v_blocked_by_viewer, 'following-blocked-by-viewer', NULL, NULL),
    (v_blocks_viewer, 'following-blocks-viewer', NULL, NULL),
    (v_unfollowed, 'following-unfollowed', NULL, NULL),
    (v_root_author, 'following-root-author', NULL, NULL)
  ON CONFLICT (id) DO UPDATE
  SET
    handle = EXCLUDED.handle,
    banned_at = NULL,
    deleted_at = NULL;

  INSERT INTO public.user_follows (follower_id, following_id)
  VALUES
    (v_viewer, v_followed),
    (v_viewer, v_blocked_by_viewer),
    (v_viewer, v_blocks_viewer);

  INSERT INTO public.blocked_users (blocker_id, blocked_id)
  VALUES
    (v_viewer, v_blocked_by_viewer),
    (v_blocks_viewer, v_viewer);

  INSERT INTO public.groups (id, name, name_en, created_by, visibility)
  VALUES
    (
      '22430000-0000-4000-8000-000000000001',
      'following-open',
      'following-open',
      v_followed,
      'open'
    ),
    (
      '22430000-0000-4000-8000-000000000002',
      'following-apply-hidden',
      'following-apply-hidden',
      v_followed,
      'apply'
    ),
    (
      '22430000-0000-4000-8000-000000000003',
      'following-apply-member',
      'following-apply-member',
      v_followed,
      'apply'
    ),
    (
      '22430000-0000-4000-8000-000000000004',
      'following-apply-banned',
      'following-apply-banned',
      v_followed,
      'apply'
    );

  INSERT INTO public.group_members (group_id, user_id, role)
  VALUES
    ('22430000-0000-4000-8000-000000000003', v_viewer, 'member'),
    ('22430000-0000-4000-8000-000000000004', v_viewer, 'member');

  INSERT INTO public.group_bans (group_id, user_id, banned_by)
  VALUES ('22430000-0000-4000-8000-000000000004', v_viewer, v_followed);

  -- Root rows are inserted before their wrappers. Neither root author is
  -- followed, so roots cannot independently enter the Following candidate set.
  INSERT INTO public.posts (
    id, title, content, author_id, author_handle, visibility, status,
    original_post_id, poll_enabled, created_at, language, deleted_at
  ) VALUES
    (
      '32430000-0000-4000-8000-000000000020', 'readable root', '', v_root_author,
      'following-root-author', 'public', 'active', NULL, false,
      '2026-07-15 11:00:00+00', 'zh', NULL
    ),
    (
      '32430000-0000-4000-8000-000000000021', 'later hidden root', '', v_root_author,
      'following-root-author', 'public', 'active', NULL, false,
      '2026-07-15 11:01:00+00', 'zh', NULL
    ),
    (
      '32430000-0000-4000-8000-000000000022', 'later deleted root', '', v_root_author,
      'following-root-author', 'public', 'active', NULL, false,
      '2026-07-15 11:02:00+00', 'zh', NULL
    ),
    (
      '32430000-0000-4000-8000-000000000023', 'blocked-author root', '',
      v_blocked_by_viewer, 'following-blocked-by-viewer', 'public', 'active', NULL, false,
      '2026-07-15 11:03:00+00', 'zh', NULL
    );

  INSERT INTO public.posts (
    id, title, content, author_id, author_handle, group_id, visibility, status,
    original_post_id, poll_enabled, created_at, language, deleted_at
  ) VALUES
    (
      '32430000-0000-4000-8000-000000000001', 'public followed', '', v_followed,
      'following-author', NULL, 'public', 'active', NULL, false,
      '2026-07-15 12:10:00+00', 'zh', NULL
    ),
    (
      '32430000-0000-4000-8000-000000000002', 'followers followed', '', v_followed,
      'following-author', NULL, 'followers', 'active', NULL, false,
      '2026-07-15 12:09:00+00', 'zh', NULL
    ),
    (
      '32430000-0000-4000-8000-000000000003', 'open group followed', '', v_followed,
      'following-author', '22430000-0000-4000-8000-000000000001', 'public', 'active',
      NULL, false, '2026-07-15 12:08:00+00', 'en', NULL
    ),
    (
      '32430000-0000-4000-8000-000000000004', 'member group followed', '', v_followed,
      'following-author', '22430000-0000-4000-8000-000000000003', 'group', 'active',
      NULL, false, '2026-07-15 12:07:00+00', 'zh', NULL
    ),
    (
      '32430000-0000-4000-8000-000000000005', 'locked followed', '', v_followed,
      'following-author', NULL, 'public', 'locked', NULL, false,
      '2026-07-15 12:06:00+00', 'zh', NULL
    ),
    (
      '32430000-0000-4000-8000-000000000006', 'readable wrapper', '', v_followed,
      'following-author', NULL, 'public', 'active',
      '32430000-0000-4000-8000-000000000020', false,
      '2026-07-15 12:05:00+00', 'zh', NULL
    ),
    (
      '32430000-0000-4000-8000-000000000007', 'hidden apply group', '', v_followed,
      'following-author', '22430000-0000-4000-8000-000000000002', 'group', 'active',
      NULL, false, '2026-07-15 12:20:00+00', 'zh', NULL
    ),
    (
      '32430000-0000-4000-8000-000000000008', 'banned apply group', '', v_followed,
      'following-author', '22430000-0000-4000-8000-000000000004', 'group', 'active',
      NULL, false, '2026-07-15 12:19:00+00', 'zh', NULL
    ),
    (
      '32430000-0000-4000-8000-000000000009', 'blocked by viewer', '',
      v_blocked_by_viewer, 'following-blocked-by-viewer', NULL, 'public', 'active',
      NULL, false, '2026-07-15 12:18:00+00', 'zh', NULL
    ),
    (
      '32430000-0000-4000-8000-000000000010', 'blocks viewer', '', v_blocks_viewer,
      'following-blocks-viewer', NULL, 'public', 'active', NULL, false,
      '2026-07-15 12:17:00+00', 'zh', NULL
    ),
    (
      '32430000-0000-4000-8000-000000000011', 'soft deleted', '', v_followed,
      'following-author', NULL, 'public', 'active', NULL, false,
      '2026-07-15 12:16:00+00', 'zh', '2026-07-15 12:16:30+00'
    ),
    (
      '32430000-0000-4000-8000-000000000012', 'deleted status', '', v_followed,
      'following-author', NULL, 'public', 'deleted', NULL, false,
      '2026-07-15 12:15:00+00', 'zh', '2026-07-15 12:15:30+00'
    ),
    (
      '32430000-0000-4000-8000-000000000013', 'unfollowed', '', v_unfollowed,
      'following-unfollowed', NULL, 'public', 'active', NULL, false,
      '2026-07-15 12:14:00+00', 'zh', NULL
    ),
    (
      '32430000-0000-4000-8000-000000000014', 'hidden-root wrapper', '', v_followed,
      'following-author', NULL, 'public', 'active',
      '32430000-0000-4000-8000-000000000021', false,
      '2026-07-15 12:13:00+00', 'zh', NULL
    ),
    (
      '32430000-0000-4000-8000-000000000015', 'deleted-root wrapper', '', v_followed,
      'following-author', NULL, 'public', 'active',
      '32430000-0000-4000-8000-000000000022', false,
      '2026-07-15 12:12:00+00', 'zh', NULL
    ),
    (
      '32430000-0000-4000-8000-000000000016', 'blocked-root wrapper', '', v_followed,
      'following-author', NULL, 'public', 'active',
      '32430000-0000-4000-8000-000000000023', false,
      '2026-07-15 12:11:00+00', 'zh', NULL
    );

  -- Reposts are canonical at creation. Exercise the read-time root gate by
  -- changing authorization facts after the wrappers already exist.
  UPDATE public.posts
  SET visibility = 'followers'
  WHERE id = '32430000-0000-4000-8000-000000000021';

  UPDATE public.posts
  SET status = 'deleted', deleted_at = '2026-07-15 12:21:00+00'
  WHERE id = '32430000-0000-4000-8000-000000000022';

  UPDATE public.posts
  SET is_sensitive = true, content_warning = 'root warning'
  WHERE id = '32430000-0000-4000-8000-000000000020';
END
$$;

DO $$
BEGIN
  IF has_function_privilege(
    'anon',
    'public.get_following_posts_page(uuid,integer,timestamptz,uuid,uuid,uuid[],text,text)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.get_following_posts_page(uuid,integer,timestamptz,uuid,uuid,uuid[],text,text)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.get_following_posts_page(uuid,integer,timestamptz,uuid,uuid,uuid[],text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Following page execute ACL drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS legacy_function
    JOIN pg_catalog.pg_namespace AS legacy_schema
      ON legacy_schema.oid = legacy_function.pronamespace
    CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) AS api_role(name)
    WHERE legacy_schema.nspname = 'public'
      AND legacy_function.proname = 'get_following_feed'
      AND pg_catalog.has_function_privilege(
        api_role.name,
        legacy_function.oid,
        'EXECUTE'
      )
  ) THEN
    RAISE EXCEPTION 'A legacy Following overload remains callable by an API role';
  END IF;
END
$$;

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);

DO $$
DECLARE
  v_viewer uuid := '12430000-0000-4000-8000-000000000001';
  v_page_1 jsonb;
  v_page_2 jsonb;
  v_page_3 jsonb;
  v_all jsonb;
  v_cursor jsonb;
  v_expected jsonb := jsonb_build_array(
    '32430000-0000-4000-8000-000000000001',
    '32430000-0000-4000-8000-000000000002',
    '32430000-0000-4000-8000-000000000003',
    '32430000-0000-4000-8000-000000000004',
    '32430000-0000-4000-8000-000000000005',
    '32430000-0000-4000-8000-000000000006'
  );
BEGIN
  v_all := public.get_following_posts_page(v_viewer, 100);

  IF (v_all->>'following_count')::integer <> 3
     OR (v_all->>'has_more')::boolean
     OR v_all->'next_cursor' IS DISTINCT FROM 'null'::jsonb
     OR (
       SELECT jsonb_agg(post_row->'id' ORDER BY post_ordinal)
       FROM jsonb_array_elements(v_all->'posts') WITH ORDINALITY AS result(post_row, post_ordinal)
     ) IS DISTINCT FROM v_expected
  THEN
    RAISE EXCEPTION 'Following privacy/order projection drifted: %', v_all;
  END IF;

  IF (v_all->'posts'->0) ?| ARRAY[
    'deleted_by',
    'delete_reason',
    'report_count',
    'impression_count',
    'click_count',
    'search_hit_count',
    'locked_reason'
  ] THEN
    RAISE EXCEPTION 'Following projection exposed an internal field';
  END IF;

  IF v_all->'posts'->5->'original_post'->>'id'
       IS DISTINCT FROM '32430000-0000-4000-8000-000000000020'
     OR (v_all->'posts'->5->>'is_sensitive')::boolean IS NOT TRUE
     OR v_all->'posts'->5->>'content_warning' IS DISTINCT FROM 'root warning'
  THEN
    RAISE EXCEPTION 'Readable ordinary root or its sensitive-content gate was not projected';
  END IF;

  v_page_1 := public.get_following_posts_page(v_viewer, 2);
  v_cursor := v_page_1->'next_cursor';
  v_page_2 := public.get_following_posts_page(
    v_viewer,
    2,
    (v_cursor->>'created_at')::timestamptz,
    (v_cursor->>'id')::uuid
  );
  v_cursor := v_page_2->'next_cursor';
  v_page_3 := public.get_following_posts_page(
    v_viewer,
    2,
    (v_cursor->>'created_at')::timestamptz,
    (v_cursor->>'id')::uuid
  );

  IF NOT (v_page_1->>'has_more')::boolean
     OR NOT (v_page_2->>'has_more')::boolean
     OR (v_page_3->>'has_more')::boolean
     OR v_page_3->'next_cursor' IS DISTINCT FROM 'null'::jsonb
     OR (
       SELECT jsonb_agg(post_id ORDER BY page_number, post_ordinal)
       FROM (
         SELECT
           page_number,
           post_ordinal,
           post_row->'id' AS post_id
         FROM (
           VALUES (1, v_page_1), (2, v_page_2), (3, v_page_3)
         ) AS pages(page_number, payload)
         CROSS JOIN LATERAL jsonb_array_elements(payload->'posts')
           WITH ORDINALITY AS result(post_row, post_ordinal)
       ) AS paged_ids
     ) IS DISTINCT FROM v_expected
  THEN
    RAISE EXCEPTION 'Following keyset pagination had a gap, duplicate, or phantom next page';
  END IF;

  IF (
    public.get_following_posts_page(
      v_viewer,
      100,
      NULL,
      NULL,
      '22430000-0000-4000-8000-000000000001',
      ARRAY['22430000-0000-4000-8000-000000000003']::uuid[]
    )->'posts'->0->>'id'
  ) IS DISTINCT FROM '32430000-0000-4000-8000-000000000003'
  THEN
    RAISE EXCEPTION 'Following single-group precedence drifted';
  END IF;

  IF jsonb_array_length(
    public.get_following_posts_page(
      v_viewer,
      100,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      'en'
    )->'posts'
  ) <> 1 THEN
    RAISE EXCEPTION 'Following language filter drifted';
  END IF;

  BEGIN
    PERFORM public.get_following_posts_page(v_viewer, 0);
    RAISE EXCEPTION 'zero page limit was accepted';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN NULL;
  END;

  BEGIN
    PERFORM public.get_following_posts_page(
      v_viewer,
      20,
      '2026-07-15 12:00:00+00',
      NULL
    );
    RAISE EXCEPTION 'half cursor was accepted';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN NULL;
  END;
END
$$;

RESET ROLE;
SELECT set_config('request.jwt.claim.role', '', true);

-- Even a database owner cannot use the explicit-viewer function without the
-- service JWT role claim. This guards accidental direct use in new code paths.
DO $$
BEGIN
  BEGIN
    PERFORM public.get_following_posts_page(
      '12430000-0000-4000-8000-000000000001',
      20
    );
    RAISE EXCEPTION 'non-service owner call was accepted';
  EXCEPTION
    WHEN SQLSTATE '42501' THEN NULL;
  END;
END
$$;

UPDATE public.user_profiles
SET banned_at = now()
WHERE id = '12430000-0000-4000-8000-000000000001';

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);

DO $$
DECLARE
  v_page jsonb;
BEGIN
  v_page := public.get_following_posts_page(
    '12430000-0000-4000-8000-000000000001',
    20
  );
  IF jsonb_array_length(v_page->'posts') <> 0
     OR (v_page->>'following_count')::integer <> 0
  THEN
    RAISE EXCEPTION 'inactive viewer retained a private Following audience';
  END IF;
END
$$;

RESET ROLE;

ROLLBACK;
