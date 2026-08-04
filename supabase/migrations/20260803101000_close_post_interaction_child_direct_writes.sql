-- Migration: 20260803101000_close_post_interaction_child_direct_writes.sql
-- Created: 2026-08-03T10:10:00Z
-- Description: Close browser raw writes and cross-user identity reads on
--   post interaction child tables. Authenticated clients retain only their own
--   rows for hydration; browser mutations stay behind postgres-owned
--   SECURITY DEFINER RPCs. Existing service-role maintenance ACLs are outside
--   this browser-boundary slice. Unsupported legacy emoji
--   rows are preserved in a server-only quarantine before validated allowlist
--   constraints are installed.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.post-interaction-child:close-direct-writes:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'post interaction child boundary migration lock is busy';
  END IF;
END
$migration_lock$;

DO $preflight$
DECLARE
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_missing_roles text[];
  v_table text;
  v_relation regclass;
  v_column record;
  v_key record;
  v_attribute record;
  v_auth_user_id_attnum smallint;
  v_signature text;
  v_function regprocedure;
  v_expected_role text;
BEGIN
  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY[
      'anon',
      'authenticated',
      'authenticator',
      'service_role',
      'postgres'
    ]::text[]
  ) AS required_role
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = required_role
  );

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION
      'post interaction child boundary roles are missing: %',
      v_missing_roles;
  END IF;

  IF NOT COALESCE(
    (
      SELECT role_row.rolbypassrls
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.rolname = 'service_role'
    ),
    false
  ) THEN
    RAISE EXCEPTION
      'service_role must retain BYPASSRLS for server aggregate reads';
  END IF;
  IF COALESCE(
    (
      SELECT role_row.rolsuper
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.rolname = 'service_role'
    ),
    false
  ) THEN
    RAISE EXCEPTION
      'service_role must remain NOSUPERUSER despite its scoped BYPASSRLS authority';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname IN ('anon', 'authenticated', 'authenticator')
      AND (role_row.rolbypassrls OR role_row.rolsuper)
  ) THEN
    RAISE EXCEPTION
      'browser roles must remain NOSUPERUSER NOBYPASSRLS for own-only interaction reads';
  END IF;

  IF pg_catalog.to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'canonical auth.uid() authority must deploy first';
  END IF;
  IF pg_catalog.to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'canonical auth.users identity relation must deploy first';
  END IF;

  SELECT attribute.attnum
  INTO v_auth_user_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'auth.users'::pg_catalog.regclass
    AND attribute.attname = 'id'
    AND attribute.atttypid = 'uuid'::pg_catalog.regtype
    AND attribute.attnotnull
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'canonical auth.users.id must be uuid NOT NULL';
  END IF;

  -- These relations are active runtime dependencies. The two legacy/dormant
  -- relations below are optional: absence is already a closed attack surface,
  -- while presence is converged by the same policy and ACL loop.
  FOREACH v_table IN ARRAY ARRAY[
    'post_likes',
    'post_votes',
    'post_bookmarks',
    'post_emoji_reactions',
    'poll_votes'
  ]::text[]
  LOOP
    v_relation := pg_catalog.to_regclass('public.' || v_table);
    IF v_relation IS NULL THEN
      RAISE EXCEPTION
        'required post interaction child relation is missing: public.%',
        v_table;
    END IF;
  END LOOP;

  FOREACH v_table IN ARRAY ARRAY[
    'post_likes',
    'post_votes',
    'post_bookmarks',
    'post_reactions',
    'post_emoji_reactions',
    'comment_emoji_reactions',
    'poll_votes'
  ]::text[]
  LOOP
    v_relation := pg_catalog.to_regclass('public.' || v_table);
    CONTINUE WHEN v_relation IS NULL;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
        AND relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND NOT relation.relispartition
        AND relation.relowner = v_postgres_oid
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_inherits AS inheritance
      WHERE inheritance.inhrelid = v_relation
         OR inheritance.inhparent = v_relation
    ) THEN
      RAISE EXCEPTION
        'post interaction child boundary requires canonical permanent relation: public.%',
        v_table;
    END IF;

    SELECT attribute.attnum, attribute.atttypid, attribute.attnotnull
    INTO v_attribute
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation
      AND attribute.attname = 'user_id'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    IF NOT FOUND
       OR v_attribute.atttypid <> 'uuid'::pg_catalog.regtype
       OR NOT v_attribute.attnotnull
    THEN
      RAISE EXCEPTION
        'public.%.user_id must be uuid NOT NULL',
        v_table;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = v_relation
        AND constraint_row.contype = 'f'
        AND constraint_row.convalidated
        AND constraint_row.confrelid = 'auth.users'::pg_catalog.regclass
        AND constraint_row.confdeltype = 'c'
        AND constraint_row.conkey =
          ARRAY[v_attribute.attnum::smallint]::smallint[]
        AND constraint_row.confkey =
          ARRAY[v_auth_user_id_attnum]::smallint[]
    ) THEN
      RAISE EXCEPTION
        'public.%.user_id requires a validated auth.users(id) ON DELETE CASCADE foreign key',
        v_table;
    END IF;
  END LOOP;

  FOR v_column IN
    SELECT *
    FROM (
      VALUES
        ('post_likes', 'post_id', 'uuid'::pg_catalog.regtype, true),
        ('post_votes', 'post_id', 'uuid'::pg_catalog.regtype, true),
        ('post_bookmarks', 'post_id', 'uuid'::pg_catalog.regtype, true),
        ('post_reactions', 'post_id', 'uuid'::pg_catalog.regtype, true),
        ('post_emoji_reactions', 'id', 'uuid'::pg_catalog.regtype, true),
        ('post_emoji_reactions', 'post_id', 'uuid'::pg_catalog.regtype, true),
        ('post_emoji_reactions', 'emoji', 'text'::pg_catalog.regtype, true),
        ('comment_emoji_reactions', 'id', 'uuid'::pg_catalog.regtype, true),
        ('comment_emoji_reactions', 'comment_id', 'uuid'::pg_catalog.regtype, true),
        ('comment_emoji_reactions', 'emoji', 'text'::pg_catalog.regtype, true),
        ('poll_votes', 'poll_id', 'uuid'::pg_catalog.regtype, true),
        ('poll_votes', 'option_index', 'integer'::pg_catalog.regtype, true)
    ) AS required_column(table_name, column_name, type_oid, required_not_null)
  LOOP
    v_relation := pg_catalog.to_regclass('public.' || v_column.table_name);
    CONTINUE WHEN v_relation IS NULL;

    SELECT attribute.atttypid, attribute.attnotnull
    INTO v_attribute
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation
      AND attribute.attname = v_column.column_name
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    IF NOT FOUND
       OR v_attribute.atttypid <> v_column.type_oid
       OR (v_column.required_not_null AND NOT v_attribute.attnotnull)
    THEN
      RAISE EXCEPTION
        'public.%.% has an incompatible interaction-boundary shape',
        v_column.table_name,
        v_column.column_name;
    END IF;
  END LOOP;

  FOR v_key IN
    SELECT *
    FROM (
      VALUES
        ('post_likes', ARRAY['post_id', 'user_id']::text[]),
        ('post_votes', ARRAY['post_id', 'user_id']::text[]),
        ('post_bookmarks', ARRAY['post_id', 'user_id']::text[]),
        ('post_reactions', ARRAY['post_id', 'user_id']::text[]),
        (
          'post_emoji_reactions',
          ARRAY['emoji', 'post_id', 'user_id']::text[]
        ),
        (
          'comment_emoji_reactions',
          ARRAY['comment_id', 'emoji', 'user_id']::text[]
        ),
        (
          'poll_votes',
          ARRAY['option_index', 'poll_id', 'user_id']::text[]
        )
    ) AS required_key(table_name, sorted_key_columns)
  LOOP
    v_relation := pg_catalog.to_regclass('public.' || v_key.table_name);
    CONTINUE WHEN v_relation IS NULL;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_index AS index_row
      WHERE index_row.indrelid = v_relation
        AND index_row.indisunique
        AND index_row.indisvalid
        AND index_row.indisready
        AND index_row.indpred IS NULL
        AND index_row.indexprs IS NULL
        AND index_row.indnkeyatts =
          pg_catalog.cardinality(v_key.sorted_key_columns)
        AND (
          SELECT pg_catalog.array_agg(
            attribute.attname::text ORDER BY attribute.attname
          )
          FROM pg_catalog.unnest(index_row.indkey)
            WITH ORDINALITY AS key_column(attnum, ordinality)
          JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = index_row.indrelid
           AND attribute.attnum = key_column.attnum
          WHERE key_column.ordinality <= index_row.indnkeyatts
        ) = v_key.sorted_key_columns
    ) THEN
      RAISE EXCEPTION
        'public.% requires a valid exact UNIQUE key on %',
        v_key.table_name,
        v_key.sorted_key_columns;
    END IF;
  END LOOP;

  -- The closure relies on owner execution, not caller table privileges. Block
  -- rollout if a prior migration changed any currently controlled writer into
  -- an invoker function or moved it away from the canonical postgres owner.
  FOREACH v_signature IN ARRAY ARRAY[
    'public.toggle_post_reaction(uuid,uuid,text)',
    'public.toggle_post_vote_atomic(uuid,uuid,text)',
    'public.toggle_post_bookmark_atomic(uuid,uuid,uuid)',
    'public.toggle_post_emoji_reaction_atomic(uuid,uuid,text)',
    'public.cast_post_poll_vote_atomic(uuid,uuid,integer[])',
    'public.cast_post_poll_vote_expected_atomic(uuid,uuid,uuid,integer[])',
    'public.save_post_bookmark_to_folder_atomic(uuid,uuid)',
    'public.remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)'
  ]::text[]
  LOOP
    v_function := pg_catalog.to_regprocedure(v_signature);
    IF v_function IS NULL OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_function
        AND function_row.prokind = 'f'
        AND function_row.proowner = v_postgres_oid
        AND function_row.prosecdef
        AND COALESCE(
          function_row.proconfig,
          ARRAY[]::text[]
        ) @> ARRAY['search_path=pg_catalog, pg_temp']::text[]
    ) THEN
      RAISE EXCEPTION
        'controlled post interaction writer authority/search_path is invalid: %',
        v_signature;
    END IF;

    v_expected_role := CASE
      WHEN v_signature IN (
        'public.save_post_bookmark_to_folder_atomic(uuid,uuid)',
        'public.remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)'
      ) THEN 'authenticated'
      ELSE 'service_role'
    END;

    IF NOT pg_catalog.has_function_privilege(
         v_expected_role,
         v_function,
         'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
       OR pg_catalog.has_function_privilege(
         'authenticator', v_function, 'EXECUTE'
       )
       OR (
         v_expected_role = 'service_role'
         AND pg_catalog.has_function_privilege(
           'authenticated', v_function, 'EXECUTE'
         )
       )
       OR (
         v_expected_role = 'authenticated'
         AND pg_catalog.has_function_privilege(
           'service_role', v_function, 'EXECUTE'
         )
       )
    THEN
      RAISE EXCEPTION
        'controlled post interaction writer execute ACL is invalid for %: %',
        v_expected_role,
        v_signature;
    END IF;
  END LOOP;

  v_relation := pg_catalog.to_regclass(
    'public.interaction_emoji_reaction_quarantine'
  );
  IF v_relation IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
        AND relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND NOT relation.relispartition
        AND relation.relowner = v_postgres_oid
    ) THEN
      RAISE EXCEPTION 'existing interaction emoji quarantine relation is incompatible';
    END IF;

    FOR v_column IN
      SELECT *
      FROM (
        VALUES
          ('source_table', 'text'::pg_catalog.regtype, true),
          ('source_id', 'uuid'::pg_catalog.regtype, true),
          ('user_id', 'uuid'::pg_catalog.regtype, true),
          ('payload_fingerprint', 'text'::pg_catalog.regtype, true),
          ('payload', 'jsonb'::pg_catalog.regtype, true),
          ('quarantined_at', 'timestamptz'::pg_catalog.regtype, true),
          ('reason', 'text'::pg_catalog.regtype, true)
      ) AS required_column(column_name, type_oid, required_not_null)
    LOOP
      SELECT attribute.atttypid, attribute.attnotnull
      INTO v_attribute
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = v_relation
        AND attribute.attname = v_column.column_name
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped;

      IF NOT FOUND
         OR v_attribute.atttypid <> v_column.type_oid
         OR (v_column.required_not_null AND NOT v_attribute.attnotnull)
      THEN
        RAISE EXCEPTION
          'existing interaction emoji quarantine column is incompatible: %',
          v_column.column_name;
      END IF;
    END LOOP;
  END IF;
END
$preflight$;

-- Keep DDL, policy convergence, and legacy-emoji quarantine atomic with
-- respect to identity deletion and source-table writes. Account deletion
-- locks auth.users before cascading into interaction children, so take the
-- same parent-to-child order before creating the quarantine foreign key.
DO $lock_relations$
DECLARE
  v_table text;
BEGIN
  LOCK TABLE auth.users IN SHARE ROW EXCLUSIVE MODE;

  FOREACH v_table IN ARRAY ARRAY[
    'comment_emoji_reactions',
    'poll_votes',
    'post_bookmarks',
    'post_emoji_reactions',
    'post_likes',
    'post_reactions',
    'post_votes'
  ]::text[]
  LOOP
    IF pg_catalog.to_regclass('public.' || v_table) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'LOCK TABLE public.%I IN SHARE ROW EXCLUSIVE MODE',
        v_table
      );
    END IF;
  END LOOP;
END
$lock_relations$;

CREATE TABLE IF NOT EXISTS public.interaction_emoji_reaction_quarantine (
  source_table text NOT NULL,
  source_id uuid NOT NULL,
  user_id uuid NOT NULL,
  payload_fingerprint text NOT NULL,
  payload jsonb NOT NULL,
  quarantined_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  reason text NOT NULL,
  CONSTRAINT interaction_emoji_reaction_quarantine_pkey
    PRIMARY KEY (source_table, source_id, payload_fingerprint),
  CONSTRAINT interaction_emoji_reaction_quarantine_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT interaction_emoji_reaction_quarantine_source_check
    CHECK (source_table IN ('post_emoji_reactions', 'comment_emoji_reactions')),
  CONSTRAINT interaction_emoji_reaction_quarantine_reason_check
    CHECK (reason = 'unsupported_emoji'),
  CONSTRAINT interaction_emoji_reaction_quarantine_fingerprint_check
    CHECK (payload_fingerprint ~ '^[0-9a-f]{32}$')
);

ALTER TABLE public.interaction_emoji_reaction_quarantine OWNER TO postgres;
ALTER TABLE public.interaction_emoji_reaction_quarantine
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interaction_emoji_reaction_quarantine
  NO FORCE ROW LEVEL SECURITY;

DO $close_quarantine$
DECLARE
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_policy record;
  v_attribute record;
  v_role text;
  v_grantee text;
BEGIN
  FOR v_policy IN
    SELECT policy_row.polname
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid =
      'public.interaction_emoji_reaction_quarantine'::pg_catalog.regclass
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.interaction_emoji_reaction_quarantine',
      v_policy.polname
    );
  END LOOP;

  -- Remove every direct non-owner grantee, not only the known browser roles.
  -- This also closes an inherited grant such as leaked_role -> authenticated.
  FOR v_role IN
    SELECT DISTINCT CASE
      WHEN grant_row.grantee = 0 THEN 'PUBLIC'
      ELSE role_row.rolname
    END
    FROM (
      SELECT acl_entry.grantee
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_entry
      WHERE relation.oid =
        'public.interaction_emoji_reaction_quarantine'::pg_catalog.regclass

      UNION

      SELECT acl_entry.grantee
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      WHERE attribute.attrelid =
        'public.interaction_emoji_reaction_quarantine'::pg_catalog.regclass
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ) AS grant_row
    LEFT JOIN pg_catalog.pg_roles AS role_row
      ON role_row.oid = grant_row.grantee
    WHERE grant_row.grantee = 0
       OR grant_row.grantee <> v_postgres_oid
  LOOP
    v_grantee := CASE
      WHEN v_role = 'PUBLIC' THEN 'PUBLIC'
      ELSE pg_catalog.format('%I', v_role)
    END;

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES
         ON TABLE public.interaction_emoji_reaction_quarantine FROM %s',
      v_grantee
    );

    -- A table-level REVOKE does not clear historical per-column grants.
    FOR v_attribute IN
      SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid =
        'public.interaction_emoji_reaction_quarantine'::pg_catalog.regclass
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY attribute.attnum
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I)
           ON TABLE public.interaction_emoji_reaction_quarantine FROM %s',
        v_attribute.attname,
        v_attribute.attname,
        v_attribute.attname,
        v_attribute.attname,
        v_grantee
      );
    END LOOP;
  END LOOP;
END
$close_quarantine$;
GRANT SELECT
  ON TABLE public.interaction_emoji_reaction_quarantine
  TO service_role;

DO $quarantine_unsupported_emoji$
DECLARE
  v_allowed text[] := ARRAY[
    '👍', '🔥', '💎', '🚀', '❤️', '👀',
    '🎯', '💰', '📈', '📉', '🤔', '😂'
  ]::text[];
  v_table text;
  v_constraint text;
  v_invalid bigint;
  v_quarantined bigint;
  v_deleted bigint;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'post_emoji_reactions',
    'comment_emoji_reactions'
  ]::text[]
  LOOP
    CONTINUE WHEN pg_catalog.to_regclass('public.' || v_table) IS NULL;

    EXECUTE pg_catalog.format(
      'SELECT pg_catalog.count(*)
       FROM public.%I AS reaction
       WHERE reaction.emoji IS NULL
          OR NOT (reaction.emoji = ANY ($1))',
      v_table
    )
    INTO v_invalid
    USING v_allowed;

    EXECUTE pg_catalog.format(
      'INSERT INTO public.interaction_emoji_reaction_quarantine
         (source_table, source_id, user_id, payload_fingerprint, payload,
          quarantined_at, reason)
       SELECT %L, reaction.id, reaction.user_id,
              pg_catalog.md5(pg_catalog.to_jsonb(reaction)::text),
              pg_catalog.to_jsonb(reaction),
              pg_catalog.statement_timestamp(), %L
       FROM public.%I AS reaction
       WHERE reaction.emoji IS NULL
          OR NOT (reaction.emoji = ANY ($1))
       ON CONFLICT (source_table, source_id, payload_fingerprint)
       DO UPDATE SET
         user_id = EXCLUDED.user_id,
         payload = EXCLUDED.payload,
         reason = EXCLUDED.reason
       WHERE public.interaction_emoji_reaction_quarantine.payload =
         EXCLUDED.payload',
      v_table,
      'unsupported_emoji',
      v_table
    ) USING v_allowed;
    GET DIAGNOSTICS v_quarantined = ROW_COUNT;

    EXECUTE pg_catalog.format(
      'DELETE FROM public.%I AS reaction
       WHERE (
         reaction.emoji IS NULL
         OR NOT (reaction.emoji = ANY ($1))
       )
         AND EXISTS (
           SELECT 1
           FROM public.interaction_emoji_reaction_quarantine AS evidence
           WHERE evidence.source_table = %L
             AND evidence.source_id = reaction.id
             AND evidence.payload_fingerprint =
               pg_catalog.md5(pg_catalog.to_jsonb(reaction)::text)
             AND evidence.payload = pg_catalog.to_jsonb(reaction)
             AND evidence.user_id = reaction.user_id
             AND evidence.reason = %L
         )',
      v_table,
      v_table,
      'unsupported_emoji'
    ) USING v_allowed;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    IF v_deleted IS DISTINCT FROM v_invalid THEN
      RAISE EXCEPTION
        'unsupported emoji quarantine/delete mismatch for public.%: expected %, deleted %',
        v_table,
        v_invalid,
        v_deleted;
    END IF;

    IF v_deleted > 0 THEN
      RAISE NOTICE
        'quarantined % unsupported rows from public.% (% inserted/reconciled evidence rows)',
        v_deleted,
        v_table,
        v_quarantined;
    END IF;

    v_constraint := v_table || '_emoji_allowlist_check';
    EXECUTE pg_catalog.format(
      'ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I',
      v_table,
      v_constraint
    );
    EXECUTE pg_catalog.format(
      'ALTER TABLE public.%I
         ADD CONSTRAINT %I CHECK (emoji = ANY (%L::text[]))',
      v_table,
      v_constraint,
      v_allowed
    );
  END LOOP;
END
$quarantine_unsupported_emoji$;

-- Drop every historical policy, including unknown FOR ALL drift. Recreate one
-- deliberately narrow read policy per extant source table. Aggregates remain
-- service reads; authenticated clients can hydrate only their own raw state.
DO $converge_interaction_boundaries$
DECLARE
  v_table text;
  v_relation regclass;
  v_policy record;
  v_attribute record;
  v_role text;
  v_grantee text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'post_likes',
    'post_votes',
    'post_bookmarks',
    'post_reactions',
    'post_emoji_reactions',
    'comment_emoji_reactions',
    'poll_votes'
  ]::text[]
  LOOP
    v_relation := pg_catalog.to_regclass('public.' || v_table);
    CONTINUE WHEN v_relation IS NULL;

    EXECUTE pg_catalog.format(
      'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
      v_table
    );
    -- Owner-executed SECURITY DEFINER RPCs must keep bypassing RLS. Browser
    -- callers still cross both table ACL and the authenticated SELECT policy.
    EXECUTE pg_catalog.format(
      'ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY',
      v_table
    );

    FOR v_policy IN
      SELECT policy_row.polname
      FROM pg_catalog.pg_policy AS policy_row
      WHERE policy_row.polrelid = v_relation
    LOOP
      EXECUTE pg_catalog.format(
        'DROP POLICY %I ON public.%I',
        v_policy.polname,
        v_table
      );
    END LOOP;

    EXECUTE pg_catalog.format(
      'CREATE POLICY %I
         ON public.%I
         AS PERMISSIVE
         FOR SELECT
         TO authenticated
         USING ((SELECT auth.uid()) = user_id)',
      v_table || '_select_own_canonical',
      v_table
    );

    FOREACH v_role IN ARRAY ARRAY[
      'PUBLIC',
      'anon',
      'authenticated',
      'authenticator'
    ]::text[]
    LOOP
      v_grantee := CASE
        WHEN v_role = 'PUBLIC' THEN 'PUBLIC'
        ELSE pg_catalog.format('%I', v_role)
      END;

      EXECUTE pg_catalog.format(
        'REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
           ON TABLE public.%I FROM %s',
        v_table,
        v_grantee
      );

      -- Table-level REVOKE does not remove historical column grants.
      FOR v_attribute IN
        SELECT attribute.attname
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = v_relation
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
        ORDER BY attribute.attnum
      LOOP
        EXECUTE pg_catalog.format(
          'REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I)
             ON TABLE public.%I FROM %s',
          v_attribute.attname,
          v_attribute.attname,
          v_attribute.attname,
          v_attribute.attname,
          v_table,
          v_grantee
        );
      END LOOP;
    END LOOP;

    EXECUTE pg_catalog.format(
      'GRANT SELECT ON TABLE public.%I TO authenticated, service_role',
      v_table
    );
  END LOOP;
END
$converge_interaction_boundaries$;

DO $postflight$
DECLARE
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_authenticated_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'authenticated'
  );
  v_service_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_table text;
  v_relation regclass;
  v_policy_name text;
  v_policy record;
  v_role text;
  v_attribute record;
  v_key record;
  v_constraint_name text;
  v_constraint_definition text;
  v_quarantine_constraint record;
  v_auth_user_id_attnum smallint;
  v_quarantine_user_id_attnum smallint;
  v_invalid bigint;
  v_signature text;
  v_function regprocedure;
  v_expected_role text;
BEGIN
  IF NOT COALESCE(
    (
      SELECT role_row.rolbypassrls
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.rolname = 'service_role'
    ),
    false
  ) THEN
    RAISE EXCEPTION 'service_role BYPASSRLS drifted after closure';
  END IF;
  IF COALESCE(
    (
      SELECT role_row.rolsuper
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.rolname = 'service_role'
    ),
    false
  ) THEN
    RAISE EXCEPTION 'service_role SUPERUSER drifted after closure';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname IN ('anon', 'authenticated', 'authenticator')
      AND (role_row.rolbypassrls OR role_row.rolsuper)
  ) THEN
    RAISE EXCEPTION 'browser role SUPERUSER/BYPASSRLS drifted after closure';
  END IF;

  FOREACH v_table IN ARRAY ARRAY[
    'post_likes',
    'post_votes',
    'post_bookmarks',
    'post_reactions',
    'post_emoji_reactions',
    'comment_emoji_reactions',
    'poll_votes'
  ]::text[]
  LOOP
    v_relation := pg_catalog.to_regclass('public.' || v_table);
    CONTINUE WHEN v_relation IS NULL;
    v_policy_name := v_table || '_select_own_canonical';

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
        AND relation.relrowsecurity
        AND NOT relation.relforcerowsecurity
    ) OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_policy AS policy_row
      WHERE policy_row.polrelid = v_relation
    ) <> 1 THEN
      RAISE EXCEPTION
        'public.% RLS or policy cardinality failed to converge',
        v_table;
    END IF;

    SELECT policy_row.polcmd,
           policy_row.polpermissive,
           policy_row.polroles,
           pg_catalog.pg_get_expr(
             policy_row.polqual,
             policy_row.polrelid,
             true
           ) AS qualifier,
           policy_row.polwithcheck
    INTO STRICT v_policy
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid = v_relation
      AND policy_row.polname = v_policy_name;

    IF v_policy.polcmd IS DISTINCT FROM 'r'
       OR NOT v_policy.polpermissive
       OR v_policy.polroles IS DISTINCT FROM ARRAY[v_authenticated_oid]::oid[]
       OR v_policy.polwithcheck IS NOT NULL
       OR v_policy.qualifier IS DISTINCT FROM
         '(( SELECT auth.uid() AS uid)) = user_id'
    THEN
      RAISE EXCEPTION 'public.% own-only SELECT policy drifted', v_table;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_entry
      WHERE relation.oid = v_relation
        AND acl_entry.grantee = 0
        AND acl_entry.privilege_type IN (
          'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
          'REFERENCES', 'TRIGGER'
        )
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl_entry.grantee = 0
        AND acl_entry.privilege_type IN (
          'SELECT', 'INSERT', 'UPDATE', 'REFERENCES'
        )
    ) THEN
      RAISE EXCEPTION 'public.% remains exposed to PUBLIC ACLs', v_table;
    END IF;

    FOREACH v_role IN ARRAY ARRAY[
      'anon',
      'authenticated',
      'authenticator'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege(v_role, v_relation, 'INSERT')
         OR pg_catalog.has_table_privilege(v_role, v_relation, 'UPDATE')
         OR pg_catalog.has_table_privilege(v_role, v_relation, 'DELETE')
         OR pg_catalog.has_table_privilege(v_role, v_relation, 'TRUNCATE')
         OR pg_catalog.has_table_privilege(v_role, v_relation, 'REFERENCES')
         OR pg_catalog.has_table_privilege(v_role, v_relation, 'TRIGGER')
      THEN
        RAISE EXCEPTION
          'public.% raw mutation remains exposed to role %',
          v_table,
          v_role;
      END IF;

      FOR v_attribute IN
        SELECT attribute.attname
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = v_relation
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      LOOP
        IF pg_catalog.has_column_privilege(
             v_role, v_relation, v_attribute.attname, 'INSERT'
           )
           OR pg_catalog.has_column_privilege(
             v_role, v_relation, v_attribute.attname, 'UPDATE'
           )
           OR pg_catalog.has_column_privilege(
             v_role, v_relation, v_attribute.attname, 'REFERENCES'
           )
        THEN
          RAISE EXCEPTION
            'public.%.% raw column mutation remains exposed to role %',
            v_table,
            v_attribute.attname,
            v_role;
        END IF;
      END LOOP;
    END LOOP;

    IF NOT pg_catalog.has_table_privilege(
         'authenticated', v_relation, 'SELECT'
       )
       OR pg_catalog.has_table_privilege('anon', v_relation, 'SELECT')
       OR pg_catalog.has_table_privilege('authenticator', v_relation, 'SELECT')
       OR NOT pg_catalog.has_table_privilege(
         'service_role', v_relation, 'SELECT'
       )
    THEN
      RAISE EXCEPTION 'public.% SELECT privilege convergence is invalid', v_table;
    END IF;
  END LOOP;

  -- Re-attest the idempotency keys after all table/policy/ACL convergence.
  -- Controlled writers rely on these exact keys to serialize one actor's
  -- state; a partial, expression, invalid, or wider unique index is not enough.
  FOR v_key IN
    SELECT *
    FROM (
      VALUES
        ('post_likes', ARRAY['post_id', 'user_id']::text[]),
        ('post_votes', ARRAY['post_id', 'user_id']::text[]),
        ('post_bookmarks', ARRAY['post_id', 'user_id']::text[]),
        ('post_reactions', ARRAY['post_id', 'user_id']::text[]),
        (
          'post_emoji_reactions',
          ARRAY['emoji', 'post_id', 'user_id']::text[]
        ),
        (
          'comment_emoji_reactions',
          ARRAY['comment_id', 'emoji', 'user_id']::text[]
        ),
        (
          'poll_votes',
          ARRAY['option_index', 'poll_id', 'user_id']::text[]
        )
    ) AS required_key(table_name, sorted_key_columns)
  LOOP
    v_relation := pg_catalog.to_regclass('public.' || v_key.table_name);
    CONTINUE WHEN v_relation IS NULL;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_index AS index_row
      WHERE index_row.indrelid = v_relation
        AND index_row.indisunique
        AND index_row.indisvalid
        AND index_row.indisready
        AND index_row.indpred IS NULL
        AND index_row.indexprs IS NULL
        AND index_row.indnkeyatts =
          pg_catalog.cardinality(v_key.sorted_key_columns)
        AND (
          SELECT pg_catalog.array_agg(
            attribute.attname::text ORDER BY attribute.attname
          )
          FROM pg_catalog.unnest(index_row.indkey)
            WITH ORDINALITY AS key_column(attnum, ordinality)
          JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = index_row.indrelid
           AND attribute.attnum = key_column.attnum
          WHERE key_column.ordinality <= index_row.indnkeyatts
        ) = v_key.sorted_key_columns
    ) THEN
      RAISE EXCEPTION
        'public.% exact UNIQUE key drifted after closure: %',
        v_key.table_name,
        v_key.sorted_key_columns;
    END IF;
  END LOOP;

  FOREACH v_table IN ARRAY ARRAY[
    'post_emoji_reactions',
    'comment_emoji_reactions'
  ]::text[]
  LOOP
    v_relation := pg_catalog.to_regclass('public.' || v_table);
    CONTINUE WHEN v_relation IS NULL;
    v_constraint_name := v_table || '_emoji_allowlist_check';

    SELECT pg_catalog.pg_get_expr(
             constraint_row.conbin,
             constraint_row.conrelid,
             true
           )
    INTO v_constraint_definition
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_relation
      AND constraint_row.conname = v_constraint_name
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated;

    IF NOT FOUND OR v_constraint_definition IS DISTINCT FROM
      'emoji = ANY (''{👍,🔥,💎,🚀,❤️,👀,🎯,💰,📈,📉,🤔,😂}''::text[])'
    THEN
      RAISE EXCEPTION 'public.% emoji allowlist constraint is invalid', v_table;
    END IF;

    EXECUTE pg_catalog.format(
      'SELECT pg_catalog.count(*)
       FROM public.%I AS reaction
       WHERE reaction.emoji IS NULL
          OR NOT (reaction.emoji = ANY ($1))',
      v_table
    )
    INTO v_invalid
    USING ARRAY[
      '👍', '🔥', '💎', '🚀', '❤️', '👀',
      '🎯', '💰', '📈', '📉', '🤔', '😂'
    ]::text[];
    IF v_invalid <> 0 THEN
      RAISE EXCEPTION 'public.% still contains unsupported emoji', v_table;
    END IF;
  END LOOP;

  v_relation :=
    'public.interaction_emoji_reaction_quarantine'::pg_catalog.regclass;

  SELECT attribute.attnum
  INTO STRICT v_auth_user_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'auth.users'::pg_catalog.regclass
    AND attribute.attname = 'id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT attribute.attnum
  INTO STRICT v_quarantine_user_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = v_relation
    AND attribute.attname = 'user_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation
      AND relation.relowner = v_postgres_oid
      AND relation.relrowsecurity
      AND NOT relation.relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_relation
      AND constraint_row.conname =
        'interaction_emoji_reaction_quarantine_pkey'
      AND constraint_row.contype = 'p'
      AND pg_catalog.strpos(
        pg_catalog.pg_get_constraintdef(constraint_row.oid, true),
        '(source_table, source_id, payload_fingerprint)'
      ) > 0
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_relation
      AND constraint_row.conname =
        'interaction_emoji_reaction_quarantine_user_id_fkey'
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'auth.users'::pg_catalog.regclass
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.convalidated
      AND constraint_row.conkey =
        ARRAY[v_quarantine_user_id_attnum]::smallint[]
      AND constraint_row.confkey =
        ARRAY[v_auth_user_id_attnum]::smallint[]
  ) OR EXISTS (
    SELECT 1
    FROM public.interaction_emoji_reaction_quarantine AS evidence
    WHERE evidence.payload_fingerprint IS DISTINCT FROM
      pg_catalog.md5(evidence.payload::text)
       OR evidence.source_id::text IS DISTINCT FROM evidence.payload->>'id'
       OR evidence.user_id::text IS DISTINCT FROM evidence.payload->>'user_id'
       OR evidence.reason IS DISTINCT FROM 'unsupported_emoji'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid = v_relation
  ) THEN
    RAISE EXCEPTION 'interaction emoji quarantine authority is invalid';
  END IF;

  FOR v_quarantine_constraint IN
    SELECT *
    FROM (
      VALUES
        (
          'interaction_emoji_reaction_quarantine_source_check',
          'source_table = ANY (ARRAY[''post_emoji_reactions''::text, ''comment_emoji_reactions''::text])'
        ),
        (
          'interaction_emoji_reaction_quarantine_reason_check',
          'reason = ''unsupported_emoji''::text'
        ),
        (
          'interaction_emoji_reaction_quarantine_fingerprint_check',
          'payload_fingerprint ~ ''^[0-9a-f]{32}$''::text'
        )
    ) AS required_constraint(constraint_name, expected_expression)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = v_relation
        AND constraint_row.conname =
          v_quarantine_constraint.constraint_name
        AND constraint_row.contype = 'c'
        AND constraint_row.convalidated
        AND pg_catalog.pg_get_expr(
          constraint_row.conbin,
          constraint_row.conrelid,
          true
        ) = v_quarantine_constraint.expected_expression
    ) THEN
      RAISE EXCEPTION
        'interaction emoji quarantine check constraint drifted: %',
        v_quarantine_constraint.constraint_name;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = v_relation
      AND (
        acl_entry.grantee NOT IN (v_postgres_oid, v_service_oid)
        OR (
          acl_entry.grantee = v_service_oid
          AND acl_entry.privilege_type <> 'SELECT'
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = v_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION
      'interaction emoji quarantine has a noncanonical direct table/column ACL';
  END IF;

  FOREACH v_role IN ARRAY ARRAY[
    'anon',
    'authenticated',
    'authenticator',
    'service_role'
  ]::text[]
  LOOP
    IF pg_catalog.has_table_privilege(v_role, v_relation, 'INSERT')
       OR pg_catalog.has_table_privilege(v_role, v_relation, 'UPDATE')
       OR pg_catalog.has_table_privilege(v_role, v_relation, 'DELETE')
       OR pg_catalog.has_table_privilege(v_role, v_relation, 'TRUNCATE')
       OR pg_catalog.has_table_privilege(v_role, v_relation, 'REFERENCES')
       OR pg_catalog.has_table_privilege(v_role, v_relation, 'TRIGGER')
       OR (
         v_role <> 'service_role'
         AND pg_catalog.has_table_privilege(v_role, v_relation, 'SELECT')
       )
       OR (
         v_role = 'service_role'
         AND NOT pg_catalog.has_table_privilege(v_role, v_relation, 'SELECT')
       )
    THEN
      RAISE EXCEPTION
        'interaction emoji quarantine table ACL drifted for role %',
        v_role;
    END IF;

    FOR v_attribute IN
      SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    LOOP
      IF pg_catalog.has_column_privilege(
           v_role, v_relation, v_attribute.attname, 'INSERT'
         )
         OR pg_catalog.has_column_privilege(
           v_role, v_relation, v_attribute.attname, 'UPDATE'
         )
         OR pg_catalog.has_column_privilege(
           v_role, v_relation, v_attribute.attname, 'REFERENCES'
         )
         OR (
           v_role <> 'service_role'
           AND pg_catalog.has_column_privilege(
             v_role, v_relation, v_attribute.attname, 'SELECT'
           )
         )
      THEN
        RAISE EXCEPTION
          'interaction emoji quarantine column %.% ACL drifted for role %',
          'interaction_emoji_reaction_quarantine',
          v_attribute.attname,
          v_role;
      END IF;
    END LOOP;
  END LOOP;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.toggle_post_reaction(uuid,uuid,text)',
    'public.toggle_post_vote_atomic(uuid,uuid,text)',
    'public.toggle_post_bookmark_atomic(uuid,uuid,uuid)',
    'public.toggle_post_emoji_reaction_atomic(uuid,uuid,text)',
    'public.cast_post_poll_vote_atomic(uuid,uuid,integer[])',
    'public.cast_post_poll_vote_expected_atomic(uuid,uuid,uuid,integer[])',
    'public.save_post_bookmark_to_folder_atomic(uuid,uuid)',
    'public.remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)'
  ]::text[]
  LOOP
    v_function := pg_catalog.to_regprocedure(v_signature);
    IF v_function IS NULL OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_function
        AND function_row.proowner = v_postgres_oid
        AND function_row.prosecdef
        AND COALESCE(
          function_row.proconfig,
          ARRAY[]::text[]
        ) @> ARRAY['search_path=pg_catalog, pg_temp']::text[]
    ) THEN
      RAISE EXCEPTION 'controlled writer authority drifted after closure: %', v_signature;
    END IF;

    v_expected_role := CASE
      WHEN v_signature IN (
        'public.save_post_bookmark_to_folder_atomic(uuid,uuid)',
        'public.remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)'
      ) THEN 'authenticated'
      ELSE 'service_role'
    END;

    IF NOT pg_catalog.has_function_privilege(
         v_expected_role,
         v_function,
         'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
       OR pg_catalog.has_function_privilege(
         'authenticator', v_function, 'EXECUTE'
       )
       OR (
         v_expected_role = 'service_role'
         AND pg_catalog.has_function_privilege(
           'authenticated', v_function, 'EXECUTE'
         )
       )
       OR (
         v_expected_role = 'authenticated'
         AND pg_catalog.has_function_privilege(
           'service_role', v_function, 'EXECUTE'
         )
       )
    THEN
      RAISE EXCEPTION 'controlled writer execute ACL drifted after closure: %',
        v_signature;
    END IF;
  END LOOP;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
