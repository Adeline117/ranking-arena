#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for the channel/membership base-table ACL and
# the service-only direct-message permission function. It owns an isolated
# temporary cluster and never connects to an application database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716112100_channel_membership_server_boundary.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/channel-membership-boundary-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55479
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -200 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd <<'SQL'
-- initdb uses the local OS account as its bootstrap superuser. Add the
-- production Supabase function-owner role explicitly.
CREATE ROLE postgres SUPERUSER NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
-- Deliberately omit BYPASSRLS: later service CRUD must be authorized by the
-- migration's explicit service policies rather than by a role attribute.
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;

CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE
AS $function$
  SELECT coalesce(
    nullif(
      pg_catalog.current_setting('request.jwt.claim.role', true),
      ''
    ),
    nullif(
      pg_catalog.current_setting('request.jwt.claims', true),
      ''
    )::jsonb ->> 'role'
  )::text
$function$;
CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $function$
  SELECT nullif(
    pg_catalog.current_setting('request.jwt.claim.sub', true),
    ''
  )::uuid
$function$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

CREATE TABLE public.chat_channels (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  name text,
  type text NOT NULL DEFAULT 'direct',
  created_by uuid,
  avatar_url text,
  description text,
  conversation_id uuid,
  last_message_at timestamptz DEFAULT pg_catalog.now(),
  last_message_preview text,
  created_at timestamptz DEFAULT pg_catalog.now(),
  updated_at timestamptz DEFAULT pg_catalog.now()
);

-- Start with the route-facing nickname column missing. The first migration
-- attempt must fail before changing any policy, ACL, or function definition.
CREATE TABLE public.channel_members (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  channel_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member',
  is_muted boolean DEFAULT false,
  is_pinned boolean DEFAULT false,
  cleared_before timestamptz,
  joined_at timestamptz DEFAULT pg_catalog.now(),
  UNIQUE (channel_id, user_id)
);
CREATE INDEX channel_members_user_idx
  ON public.channel_members(user_id);
CREATE INDEX channel_members_channel_idx
  ON public.channel_members(channel_id);

CREATE TABLE public.channel_messages (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  channel_id uuid NOT NULL,
  sender_id uuid NOT NULL,
  content text NOT NULL DEFAULT '',
  media_url text,
  media_type text,
  media_name text,
  created_at timestamptz DEFAULT pg_catalog.now(),
  reply_to_id uuid
);
CREATE INDEX channel_messages_channel_idx
  ON public.channel_messages(channel_id, created_at DESC);

CREATE TABLE public.channel_message_reactions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  message_id uuid NOT NULL,
  user_id uuid NOT NULL,
  emoji text NOT NULL,
  created_at timestamptz DEFAULT pg_catalog.now()
);
CREATE INDEX channel_message_reactions_message_idx
  ON public.channel_message_reactions(message_id);

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  dm_permission text,
  deleted_at timestamptz,
  banned_at timestamptz
);

CREATE TABLE public.blocked_users (
  blocker_id uuid NOT NULL,
  blocked_id uuid NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX blocked_users_reverse_idx
  ON public.blocked_users(blocked_id);

CREATE TABLE public.user_follows (
  follower_id uuid NOT NULL,
  following_id uuid NOT NULL,
  UNIQUE (follower_id, following_id)
);

CREATE TABLE public.direct_messages (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  sender_id uuid NOT NULL,
  receiver_id uuid NOT NULL
);
-- The required (sender_id, receiver_id) index is intentionally absent for the
-- second preflight rollback proof.

ALTER TABLE public.chat_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_message_reactions ENABLE ROW LEVEL SECURITY;

-- Reproduce broad historical Supabase table defaults, independent column ACLs,
-- old public policies, and the unsafe direct-call RPC surface.
GRANT ALL PRIVILEGES ON TABLE public.chat_channels, public.channel_members
  TO PUBLIC, anon, authenticated, service_role;
GRANT SELECT (name, created_by), UPDATE (name, created_by)
  ON TABLE public.chat_channels
  TO PUBLIC, anon, authenticated, service_role;
GRANT SELECT (user_id, role), UPDATE (role)
  ON TABLE public.channel_members
  TO PUBLIC, anon, authenticated, service_role;
GRANT ALL PRIVILEGES
  ON TABLE public.channel_messages, public.channel_message_reactions
  TO PUBLIC, anon, authenticated, service_role;
GRANT SELECT (channel_id, sender_id), INSERT (channel_id, sender_id)
  ON TABLE public.channel_messages
  TO PUBLIC, anon, authenticated, service_role;
GRANT SELECT (message_id, user_id), DELETE
  ON TABLE public.channel_message_reactions
  TO PUBLIC, anon, authenticated, service_role;

CREATE POLICY "Users can view channels they are members of"
  ON public.chat_channels FOR SELECT TO public USING (true);
CREATE POLICY "Users can create channels"
  ON public.chat_channels FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Channel owners can update"
  ON public.chat_channels FOR UPDATE TO public USING (true);
CREATE POLICY "Members can view channel members"
  ON public.channel_members FOR SELECT TO public USING (true);
CREATE POLICY "Channel admins manage members"
  ON public.channel_members FOR ALL TO public
  USING (true) WITH CHECK (true);
CREATE POLICY "Members can view channel messages"
  ON public.channel_messages FOR SELECT TO public USING (true);
CREATE POLICY "Members can send messages"
  ON public.channel_messages FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Channel members can read reactions"
  ON public.channel_message_reactions FOR SELECT TO public USING (true);
CREATE POLICY "Channel members can add their own reaction"
  ON public.channel_message_reactions FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Users can remove their own channel reaction"
  ON public.channel_message_reactions FOR DELETE TO public USING (true);

CREATE FUNCTION public.check_dm_permission(
  p_sender_id uuid,
  p_receiver_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  RETURN pg_catalog.jsonb_build_object(
    'legacy_probe', true,
    'sender', p_sender_id,
    'receiver', p_receiver_id
  );
END
$function$;
GRANT EXECUTE ON FUNCTION public.check_dm_permission(uuid, uuid)
  TO PUBLIC, anon, authenticated, service_role;
SQL

# Missing-column preflight must roll the entire migration back.
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/missing-column.log" 2>&1; then
  echo "channel boundary unexpectedly passed with a missing route column" >&2
  exit 1
fi
if ! grep -q 'channel boundary has missing or incompatible columns' \
  "$TMP_ROOT/missing-column.log"; then
  cat "$TMP_ROOT/missing-column.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $rollback_proof$
BEGIN
  IF NOT pg_catalog.has_table_privilege(
       'authenticated',
       'public.chat_channels',
       'SELECT'
     ) OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_policy
       WHERE polrelid IN (
         'public.chat_channels'::regclass,
         'public.channel_members'::regclass
       )
     ) <> 5 OR NOT pg_catalog.has_function_privilege(
       'anon',
       'public.check_dm_permission(uuid,uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'missing-column preflight did not roll back cleanly';
  END IF;
END
$rollback_proof$;

ALTER TABLE public.channel_members ADD COLUMN nickname text;
SQL

# Missing-index preflight must also fail before closing any old surface.
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/missing-index.log" 2>&1; then
  echo "channel boundary unexpectedly passed without the DM pair index" >&2
  exit 1
fi
if ! grep -q 'channel boundary requires valid supporting indexes' \
  "$TMP_ROOT/missing-index.log"; then
  cat "$TMP_ROOT/missing-index.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $rollback_proof$
BEGIN
  IF NOT pg_catalog.has_table_privilege(
       'authenticated',
       'public.channel_members',
       'UPDATE'
     ) OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_policy
       WHERE polrelid IN (
         'public.chat_channels'::regclass,
         'public.channel_members'::regclass
       )
     ) <> 5 OR NOT pg_catalog.has_function_privilege(
       'authenticated',
       'public.check_dm_permission(uuid,uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'missing-index preflight did not roll back cleanly';
  END IF;
END
$rollback_proof$;

CREATE INDEX direct_messages_sender_receiver_idx
  ON public.direct_messages(sender_id, receiver_id);
SQL

# First application closes historical policy, ACL, and RPC paths.
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $first_replay_proof$
BEGIN
  IF (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_policy
       WHERE polrelid IN (
         'public.chat_channels'::regclass,
         'public.channel_members'::regclass
       )
     ) <> 2 OR pg_catalog.has_function_privilege(
       'authenticated',
       'public.check_dm_permission(uuid,uuid)',
       'EXECUTE'
     ) OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_policy
       WHERE polrelid IN (
         'public.channel_messages'::regclass,
         'public.channel_message_reactions'::regclass
       )
     ) <> 4 OR NOT pg_catalog.has_function_privilege(
       'authenticated',
       'public.is_current_user_channel_member(uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'first replay did not converge the boundary';
  END IF;
END
$first_replay_proof$;

-- Add post-deployment columns plus unknown table/column ACL, policy, and RPC
-- drift. The second application must discover and remove all of it.
ALTER TABLE public.chat_channels ADD COLUMN dashboard_secret text;
ALTER TABLE public.channel_members ADD COLUMN dashboard_note text;
ALTER TABLE public.channel_messages ADD COLUMN dashboard_payload text;
ALTER TABLE public.channel_message_reactions ADD COLUMN dashboard_tag text;
GRANT SELECT ON TABLE public.chat_channels TO anon;
GRANT UPDATE ON TABLE public.channel_members TO authenticated;
GRANT INSERT ON TABLE public.channel_messages TO authenticated;
GRANT DELETE ON TABLE public.channel_message_reactions TO anon;
GRANT SELECT (dashboard_secret) ON TABLE public.chat_channels
  TO PUBLIC, authenticated;
GRANT UPDATE (dashboard_note) ON TABLE public.channel_members
  TO PUBLIC, anon;
GRANT INSERT (dashboard_payload) ON TABLE public.channel_messages
  TO PUBLIC, authenticated;
GRANT UPDATE (dashboard_tag) ON TABLE public.channel_message_reactions
  TO PUBLIC, anon;
CREATE POLICY "Unknown dashboard channel drift"
  ON public.chat_channels FOR ALL TO public
  USING (true) WITH CHECK (true);
CREATE POLICY "Unknown dashboard member drift"
  ON public.channel_members FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
CREATE POLICY "Unknown dashboard message drift"
  ON public.channel_messages FOR INSERT TO authenticated
  WITH CHECK (true);
CREATE POLICY "Unknown dashboard reaction drift"
  ON public.channel_message_reactions FOR DELETE TO public
  USING (true);

CREATE OR REPLACE FUNCTION public.is_current_user_channel_member(
  p_channel_id uuid
) RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  RETURN true;
END
$function$;
GRANT EXECUTE ON FUNCTION public.is_current_user_channel_member(uuid)
  TO PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.check_dm_permission(
  p_sender_id uuid,
  p_receiver_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  RETURN pg_catalog.jsonb_build_object(
    'drift_probe', true,
    'sender', p_sender_id,
    'receiver', p_receiver_id
  );
END
$function$;
GRANT EXECUTE ON FUNCTION public.check_dm_permission(uuid, uuid)
  TO PUBLIC, anon, authenticated;
SQL

# Second application proves idempotency and drift convergence.
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
CREATE FUNCTION public.assert_insufficient_privilege(
  p_sql text,
  p_label text
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION
    WHEN insufficient_privilege THEN
      RETURN;
  END;

  RAISE EXCEPTION '% unexpectedly succeeded', p_label;
END
$function$;
GRANT EXECUTE ON FUNCTION public.assert_insufficient_privilege(text, text)
  TO anon, authenticated, service_role;

-- pg_get_expr() omits schema qualification for objects visible through the
-- caller's search path. Match the migration's locked search path so this
-- independent catalog proof compares one deterministic canonical expression.
SET search_path = pg_catalog, pg_temp;

DO $catalog_proof$
DECLARE
  v_relation regclass;
  v_relation_name text;
  v_role name;
  v_privilege text;
  v_column name;
  v_expected_policy name;
  v_expected_read_policy name;
  v_expected_read_expression text;
  v_expected_service_policy name;
  v_service_role_oid oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role'
  );
BEGIN
  IF (
    SELECT rolbypassrls
    FROM pg_catalog.pg_roles
    WHERE rolname = 'service_role'
  ) THEN
    RAISE EXCEPTION 'fixture service role unexpectedly bypasses RLS';
  END IF;

  FOREACH v_relation_name IN ARRAY ARRAY[
    'chat_channels',
    'channel_members'
  ]::text[]
  LOOP
    v_relation := pg_catalog.to_regclass(
      pg_catalog.format('public.%I', v_relation_name)
    );
    v_expected_policy := CASE v_relation_name
      WHEN 'chat_channels' THEN 'Service role manages chat channels'
      ELSE 'Service role manages channel members'
    END;

    IF NOT (
      SELECT relrowsecurity
      FROM pg_catalog.pg_class
      WHERE oid = v_relation
    ) THEN
      RAISE EXCEPTION 'RLS is disabled on %', v_relation_name;
    END IF;

    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']::name[]
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER'
      ]::text[]
      LOOP
        IF pg_catalog.has_table_privilege(
          v_role,
          v_relation,
          v_privilege
        ) THEN
          RAISE EXCEPTION
            'browser table privilege remains: % % %',
            v_relation_name,
            v_role,
            v_privilege;
        END IF;
      END LOOP;

      FOR v_column IN
        SELECT attname
        FROM pg_catalog.pg_attribute
        WHERE attrelid = v_relation
          AND attnum > 0
          AND NOT attisdropped
      LOOP
        FOREACH v_privilege IN ARRAY ARRAY[
          'SELECT',
          'INSERT',
          'UPDATE',
          'REFERENCES'
        ]::text[]
        LOOP
          IF pg_catalog.has_column_privilege(
            v_role,
            v_relation,
            v_column,
            v_privilege
          ) THEN
            RAISE EXCEPTION
              'browser column privilege remains: % % % %',
              v_relation_name,
              v_role,
              v_column,
              v_privilege;
          END IF;
        END LOOP;
      END LOOP;
    END LOOP;

    FOREACH v_privilege IN ARRAY ARRAY[
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE'
    ]::text[]
    LOOP
      IF NOT pg_catalog.has_table_privilege(
        'service_role',
        v_relation,
        v_privilege
      ) THEN
        RAISE EXCEPTION
          'service CRUD privilege missing: % %',
          v_relation_name,
          v_privilege;
      END IF;
    END LOOP;

    FOREACH v_privilege IN ARRAY ARRAY[
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege(
        'service_role',
        v_relation,
        v_privilege
      ) THEN
        RAISE EXCEPTION
          'service excess privilege remains: % %',
          v_relation_name,
          v_privilege;
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
        AND acl_entry.grantee = 0::oid
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl_entry.grantee = 0::oid
    ) THEN
      RAISE EXCEPTION 'PUBLIC ACL remains on %', v_relation_name;
    END IF;

    IF (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_policy
      WHERE polrelid = v_relation
    ) <> 1 OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy
      WHERE polrelid = v_relation
        AND polname = v_expected_policy
        AND polcmd = '*'
        AND polroles = ARRAY[v_service_role_oid]::oid[]
        AND pg_catalog.pg_get_expr(polqual, polrelid) = 'true'
        AND pg_catalog.pg_get_expr(polwithcheck, polrelid) = 'true'
    ) THEN
      RAISE EXCEPTION 'canonical policy mismatch on %', v_relation_name;
    END IF;
  END LOOP;

  FOREACH v_relation_name IN ARRAY ARRAY[
    'channel_messages',
    'channel_message_reactions'
  ]::text[]
  LOOP
    v_relation := pg_catalog.to_regclass(
      pg_catalog.format('public.%I', v_relation_name)
    );
    v_expected_read_policy := CASE v_relation_name
      WHEN 'channel_messages' THEN 'Authenticated members read channel messages'
      ELSE 'Authenticated members read channel message reactions'
    END;
    v_expected_read_expression := CASE v_relation_name
      WHEN 'channel_messages' THEN
        'public.is_current_user_channel_member(channel_id)'
      ELSE
        '(EXISTS ( SELECT 1 FROM public.channel_messages parent_message '
          || 'WHERE ((parent_message.id = channel_message_reactions.message_id) '
          || 'AND public.is_current_user_channel_member(parent_message.channel_id))))'
    END;
    v_expected_service_policy := CASE v_relation_name
      WHEN 'channel_messages' THEN 'Service role manages channel messages'
      ELSE 'Service role manages channel message reactions'
    END;

    FOREACH v_privilege IN ARRAY ARRAY[
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege(
        'anon',
        v_relation,
        v_privilege
      ) OR pg_catalog.has_table_privilege(
        'authenticated',
        v_relation,
        v_privilege
      ) IS DISTINCT FROM (v_privilege = 'SELECT') THEN
        RAISE EXCEPTION
          'dependent browser privilege mismatch: % %',
          v_relation_name,
          v_privilege;
      END IF;
    END LOOP;

    FOREACH v_privilege IN ARRAY ARRAY[
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE'
    ]::text[]
    LOOP
      IF NOT pg_catalog.has_table_privilege(
        'service_role',
        v_relation,
        v_privilege
      ) THEN
        RAISE EXCEPTION
          'dependent service CRUD missing: % %',
          v_relation_name,
          v_privilege;
      END IF;
    END LOOP;

    FOREACH v_privilege IN ARRAY ARRAY[
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege(
        'service_role',
        v_relation,
        v_privilege
      ) THEN
        RAISE EXCEPTION
          'dependent service excess privilege: % %',
          v_relation_name,
          v_privilege;
      END IF;
    END LOOP;

    IF (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_policy
      WHERE polrelid = v_relation
    ) <> 2 OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy
      WHERE polrelid = v_relation
        AND polname = v_expected_read_policy
        AND polcmd = 'r'
        AND polroles = ARRAY[
          (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticated')
        ]::oid[]
        AND pg_catalog.regexp_replace(
          pg_catalog.pg_get_expr(polqual, polrelid),
          '[[:space:]]+',
          ' ',
          'g'
        ) = v_expected_read_expression
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy
      WHERE polrelid = v_relation
        AND polname = v_expected_service_policy
        AND polcmd = '*'
        AND polroles = ARRAY[v_service_role_oid]::oid[]
        AND pg_catalog.pg_get_expr(polqual, polrelid) = 'true'
        AND pg_catalog.pg_get_expr(polwithcheck, polrelid) = 'true'
    ) THEN
      RAISE EXCEPTION
        'dependent canonical policy mismatch on %',
        v_relation_name;
    END IF;
  END LOOP;

  IF pg_catalog.has_function_privilege(
    'anon',
    'public.is_current_user_channel_member(uuid)',
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'authenticated',
    'public.is_current_user_channel_member(uuid)',
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.is_current_user_channel_member(uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'membership function EXECUTE boundary mismatch';
  END IF;

  IF (
    SELECT pg_catalog.strpos(procedure.prosrc, 'auth.uid()') = 0
      OR pg_catalog.strpos(procedure.prosrc, 'p_user') > 0
      OR pg_catalog.strpos(procedure.prosrc, 'public.user_profiles') = 0
      OR pg_catalog.strpos(procedure.prosrc, 'actor_profile.deleted_at IS NULL') = 0
      OR pg_catalog.strpos(procedure.prosrc, 'actor_profile.banned_at IS NULL') = 0
      OR NOT procedure.prosecdef
      OR procedure.provolatile <> 's'
      OR procedure.proconfig IS DISTINCT FROM
        ARRAY['search_path=pg_catalog, pg_temp']::text[]
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid =
      'public.is_current_user_channel_member(uuid)'::regprocedure
  ) THEN
    RAISE EXCEPTION 'membership function body/catalog did not converge';
  END IF;

  IF pg_catalog.has_function_privilege(
    'anon',
    'public.check_dm_permission(uuid,uuid)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    'public.check_dm_permission(uuid,uuid)',
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.check_dm_permission(uuid,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'DM function EXECUTE boundary mismatch';
  END IF;

  IF (
    SELECT pg_catalog.strpos(procedure.prosrc, 'auth.role()') = 0
      OR pg_catalog.strpos(procedure.prosrc, '''all''') = 0
      OR pg_catalog.strpos(procedure.prosrc, '''everyone''') > 0
      OR pg_catalog.strpos(procedure.prosrc, 'sender_profile') = 0
      OR pg_catalog.strpos(procedure.prosrc, '''SENDER_UNAVAILABLE''') = 0
      OR NOT procedure.prosecdef
      OR procedure.proconfig IS DISTINCT FROM
        ARRAY['search_path=pg_catalog, pg_temp']::text[]
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid =
      'public.check_dm_permission(uuid,uuid)'::regprocedure
  ) THEN
    RAISE EXCEPTION 'DM function body/catalog did not converge';
  END IF;
END
$catalog_proof$;

-- Populate deterministic DM privacy scenarios as the database owner. The
-- service RPC reads these through SECURITY DEFINER; browser roles get neither
-- dependent-table visibility nor direct function execution.
INSERT INTO public.user_profiles (
  id, dm_permission, deleted_at, banned_at
) VALUES
  ('10000000-0000-0000-0000-000000000001', 'all', NULL, NULL),
  ('20000000-0000-0000-0000-000000000002', 'all', NULL, NULL),
  ('30000000-0000-0000-0000-000000000003', 'none', NULL, NULL),
  ('40000000-0000-0000-0000-000000000004', 'mutual', NULL, NULL),
  ('50000000-0000-0000-0000-000000000005', 'mutual', NULL, NULL),
  ('60000000-0000-0000-0000-000000000006', 'mutual', NULL, NULL),
  ('70000000-0000-0000-0000-000000000007', 'mutual', NULL, NULL),
  ('80000000-0000-0000-0000-000000000008', 'all', pg_catalog.now(), NULL),
  ('90000000-0000-0000-0000-000000000009', 'all', NULL, pg_catalog.now()),
  ('a0000000-0000-0000-0000-00000000000a', 'all', NULL, NULL),
  ('b0000000-0000-0000-0000-00000000000b', 'all', NULL, NULL),
  ('c0000000-0000-0000-0000-00000000000c', NULL, NULL, NULL),
  ('d1000000-0000-0000-0000-0000000000d1', 'all', pg_catalog.now(), NULL),
  ('d2000000-0000-0000-0000-0000000000d2', 'all', NULL, pg_catalog.now());

-- "none" remains disabled even when follows are mutual.
INSERT INTO public.user_follows(follower_id, following_id) VALUES
  ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003'),
  ('30000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000007'),
  ('70000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000001');

INSERT INTO public.blocked_users(blocker_id, blocked_id) VALUES
  ('10000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a'),
  ('b0000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-000000000001');

-- Three outbound messages exercise the exact limit. The reply and mutual
-- scenarios deliberately also have three outbound messages, proving that the
-- established higher-priority exemptions still win.
INSERT INTO public.direct_messages(sender_id, receiver_id)
SELECT '10000000-0000-0000-0000-000000000001', receiver_id
FROM (
  VALUES
    ('20000000-0000-0000-0000-000000000002'::uuid),
    ('50000000-0000-0000-0000-000000000005'::uuid),
    ('60000000-0000-0000-0000-000000000006'::uuid),
    ('70000000-0000-0000-0000-000000000007'::uuid)
) AS receiver(receiver_id)
CROSS JOIN pg_catalog.generate_series(1, 3);
INSERT INTO public.direct_messages(sender_id, receiver_id) VALUES
  ('60000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001');
SQL

# Browser roles cannot read or write either base table. anon also cannot forge
# p_sender_id to probe another user's private graph through the RPC.
psql_cmd <<'SQL'
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT public.assert_insufficient_privilege(
  'SELECT * FROM public.chat_channels',
  'authenticated channel read'
);
SELECT public.assert_insufficient_privilege(
  $statement$
    INSERT INTO public.chat_channels(id, name, type)
    VALUES ('d0000000-0000-0000-0000-000000000001', 'forged', 'group')
  $statement$,
  'authenticated channel insert'
);
SELECT public.assert_insufficient_privilege(
  'UPDATE public.chat_channels SET name = ''forged''',
  'authenticated channel update'
);
SELECT public.assert_insufficient_privilege(
  'DELETE FROM public.chat_channels',
  'authenticated channel delete'
);
SELECT public.assert_insufficient_privilege(
  'SELECT * FROM public.channel_members',
  'authenticated membership read'
);
SELECT public.assert_insufficient_privilege(
  $statement$
    INSERT INTO public.channel_members(channel_id, user_id, role)
    VALUES (
      'd0000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001',
      'owner'
    )
  $statement$,
  'authenticated membership insert'
);
SELECT public.assert_insufficient_privilege(
  $statement$
    INSERT INTO public.channel_messages(
      id, channel_id, sender_id, content
    ) VALUES (
      'e0000000-0000-0000-0000-000000000001',
      'd0000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001',
      'forged browser message'
    )
  $statement$,
  'authenticated direct message insert'
);
SELECT public.assert_insufficient_privilege(
  $statement$
    INSERT INTO public.channel_message_reactions(
      id, message_id, user_id, emoji
    ) VALUES (
      'f0000000-0000-0000-0000-000000000001',
      'e0000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001',
      'x'
    )
  $statement$,
  'authenticated direct reaction insert'
);
SELECT public.assert_insufficient_privilege(
  'TRUNCATE TABLE public.channel_members',
  'authenticated membership truncate'
);
RESET ROLE;

SET ROLE anon;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'anon', false);
SELECT public.assert_insufficient_privilege(
  'SELECT * FROM public.chat_channels',
  'anonymous channel read'
);
SELECT public.assert_insufficient_privilege(
  'SELECT * FROM public.channel_messages',
  'anonymous channel message read'
);
SELECT public.assert_insufficient_privilege(
  'SELECT public.is_current_user_channel_member(''d0000000-0000-0000-0000-000000000001'')',
  'anonymous membership probe'
);
SELECT public.assert_insufficient_privilege(
  $statement$
    SELECT public.check_dm_permission(
      '70000000-0000-0000-0000-000000000007',
      '20000000-0000-0000-0000-000000000002'
    )
  $statement$,
  'anonymous forged-sender DM probe'
);
RESET ROLE;

-- Even a future accidental EXECUTE grant is stopped by auth.role().
GRANT EXECUTE ON FUNCTION public.check_dm_permission(uuid, uuid)
  TO authenticated;
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT public.assert_insufficient_privilege(
  $statement$
    SELECT public.check_dm_permission(
      '70000000-0000-0000-0000-000000000007',
      '20000000-0000-0000-0000-000000000002'
    )
  $statement$,
  'authenticated internal role gate'
);
RESET ROLE;
REVOKE EXECUTE ON FUNCTION public.check_dm_permission(uuid, uuid)
  FROM authenticated;

-- The membership predicate has its own role gate if an EXECUTE ACL drifts.
GRANT EXECUTE ON FUNCTION public.is_current_user_channel_member(uuid)
  TO anon;
SET ROLE anon;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'anon', false);
SELECT public.assert_insufficient_privilege(
  'SELECT public.is_current_user_channel_member(''d0000000-0000-0000-0000-000000000001'')',
  'anonymous internal membership role gate'
);
RESET ROLE;
REVOKE EXECUTE ON FUNCTION public.is_current_user_channel_member(uuid)
  FROM anon;
SQL

# service_role has base-table CRUD (without BYPASSRLS), no TRUNCATE, and the
# canonical DM response semantics.
psql_cmd <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);

INSERT INTO public.chat_channels(id, name, type, created_by) VALUES
  ('d0000000-0000-0000-0000-000000000001', 'service group', 'group', '10000000-0000-0000-0000-000000000001'),
  ('d0000000-0000-0000-0000-000000000002', 'delete me', 'group', '10000000-0000-0000-0000-000000000001');
UPDATE public.chat_channels
SET description = 'updated by service'
WHERE id = 'd0000000-0000-0000-0000-000000000001';
SELECT id FROM public.chat_channels
WHERE id = 'd0000000-0000-0000-0000-000000000001';
DELETE FROM public.chat_channels
WHERE id = 'd0000000-0000-0000-0000-000000000002';

INSERT INTO public.channel_members(channel_id, user_id, role) VALUES
  ('d0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'owner'),
  ('d0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', 'member');
UPDATE public.channel_members
SET nickname = 'service update'
WHERE channel_id = 'd0000000-0000-0000-0000-000000000001'
  AND user_id = '10000000-0000-0000-0000-000000000001';
SELECT user_id FROM public.channel_members
WHERE channel_id = 'd0000000-0000-0000-0000-000000000001';
DELETE FROM public.channel_members
WHERE channel_id = 'd0000000-0000-0000-0000-000000000001'
  AND user_id = '20000000-0000-0000-0000-000000000002';

INSERT INTO public.channel_messages(
  id, channel_id, sender_id, content
) VALUES
  (
    'e0000000-0000-0000-0000-000000000001',
    'd0000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'member-visible message'
  ),
  (
    'e0000000-0000-0000-0000-000000000002',
    'd0000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'delete me'
  );
UPDATE public.channel_messages
SET content = 'service-updated member-visible message'
WHERE id = 'e0000000-0000-0000-0000-000000000001';
SELECT id FROM public.channel_messages
WHERE id = 'e0000000-0000-0000-0000-000000000001';
DELETE FROM public.channel_messages
WHERE id = 'e0000000-0000-0000-0000-000000000002';

INSERT INTO public.channel_message_reactions(
  id, message_id, user_id, emoji
) VALUES
  (
    'f0000000-0000-0000-0000-000000000001',
    'e0000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'x'
  ),
  (
    'f0000000-0000-0000-0000-000000000002',
    'e0000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'y'
  );
UPDATE public.channel_message_reactions
SET emoji = 'member-visible-reaction'
WHERE id = 'f0000000-0000-0000-0000-000000000001';
SELECT id FROM public.channel_message_reactions
WHERE id = 'f0000000-0000-0000-0000-000000000001';
DELETE FROM public.channel_message_reactions
WHERE id = 'f0000000-0000-0000-0000-000000000002';

SELECT public.assert_insufficient_privilege(
  'TRUNCATE TABLE public.chat_channels',
  'service channel truncate'
);
SELECT public.assert_insufficient_privilege(
  'TRUNCATE TABLE public.channel_members',
  'service membership truncate'
);
SELECT public.assert_insufficient_privilege(
  'TRUNCATE TABLE public.channel_messages',
  'service channel message truncate'
);
SELECT public.assert_insufficient_privilege(
  'TRUNCATE TABLE public.channel_message_reactions',
  'service channel reaction truncate'
);

DO $dm_semantics$
DECLARE
  v_sender constant uuid := '10000000-0000-0000-0000-000000000001';
  v_result jsonb;
BEGIN
  v_result := public.check_dm_permission(
    'd3000000-0000-0000-0000-0000000000d3',
    'd0000000-0000-0000-0000-00000000000d'
  );
  IF v_result IS DISTINCT FROM
    '{"allowed": false, "reason": "SENDER_UNAVAILABLE"}'::jsonb THEN
    RAISE EXCEPTION 'missing sender fail-first contract failed: %', v_result;
  END IF;

  v_result := public.check_dm_permission(
    'd1000000-0000-0000-0000-0000000000d1',
    '20000000-0000-0000-0000-000000000002'
  );
  IF v_result IS DISTINCT FROM
    '{"allowed": false, "reason": "SENDER_UNAVAILABLE"}'::jsonb THEN
    RAISE EXCEPTION 'deleted sender contract failed: %', v_result;
  END IF;

  v_result := public.check_dm_permission(
    'd2000000-0000-0000-0000-0000000000d2',
    '20000000-0000-0000-0000-000000000002'
  );
  IF v_result IS DISTINCT FROM
    '{"allowed": false, "reason": "SENDER_UNAVAILABLE"}'::jsonb THEN
    RAISE EXCEPTION 'banned sender contract failed: %', v_result;
  END IF;

  v_result := public.check_dm_permission(
    v_sender,
    'd0000000-0000-0000-0000-00000000000d'
  );
  IF v_result IS DISTINCT FROM
    '{"allowed": false, "reason": "USER_NOT_FOUND"}'::jsonb THEN
    RAISE EXCEPTION 'missing receiver contract failed: %', v_result;
  END IF;

  v_result := public.check_dm_permission(
    v_sender,
    '80000000-0000-0000-0000-000000000008'
  );
  IF v_result IS DISTINCT FROM
    '{"allowed": false, "reason": "USER_NOT_FOUND"}'::jsonb THEN
    RAISE EXCEPTION 'deleted receiver contract failed: %', v_result;
  END IF;

  v_result := public.check_dm_permission(
    v_sender,
    '90000000-0000-0000-0000-000000000009'
  );
  IF v_result IS DISTINCT FROM
    '{"allowed": false, "reason": "USER_NOT_FOUND"}'::jsonb THEN
    RAISE EXCEPTION 'banned receiver contract failed: %', v_result;
  END IF;

  v_result := public.check_dm_permission(
    v_sender,
    'a0000000-0000-0000-0000-00000000000a'
  );
  IF v_result IS DISTINCT FROM
    '{"allowed": false, "reason": "BLOCKED"}'::jsonb THEN
    RAISE EXCEPTION 'sender-to-receiver block contract failed: %', v_result;
  END IF;

  v_result := public.check_dm_permission(
    v_sender,
    'b0000000-0000-0000-0000-00000000000b'
  );
  IF v_result IS DISTINCT FROM
    '{"allowed": false, "reason": "BLOCKED"}'::jsonb THEN
    RAISE EXCEPTION 'receiver-to-sender block contract failed: %', v_result;
  END IF;

  v_result := public.check_dm_permission(
    v_sender,
    '30000000-0000-0000-0000-000000000003'
  );
  IF v_result IS DISTINCT FROM
    '{"allowed": false, "reason": "DM_DISABLED"}'::jsonb THEN
    RAISE EXCEPTION 'none privacy contract failed: %', v_result;
  END IF;

  v_result := public.check_dm_permission(
    v_sender,
    'c0000000-0000-0000-0000-00000000000c'
  );
  IF v_result IS DISTINCT FROM
    '{"allowed": false, "reason": "DM_DISABLED"}'::jsonb THEN
    RAISE EXCEPTION 'NULL privacy fail-closed contract failed: %', v_result;
  END IF;

  v_result := public.check_dm_permission(
    v_sender,
    '20000000-0000-0000-0000-000000000002'
  );
  IF v_result IS DISTINCT FROM '{"allowed": true}'::jsonb THEN
    RAISE EXCEPTION 'all privacy contract failed: %', v_result;
  END IF;

  v_result := public.check_dm_permission(
    v_sender,
    '40000000-0000-0000-0000-000000000004'
  );
  IF v_result IS DISTINCT FROM
    '{"allowed": true, "sent_count": 0, "reason": null}'::jsonb THEN
    RAISE EXCEPTION 'under-limit response contract failed: %', v_result;
  END IF;

  v_result := public.check_dm_permission(
    v_sender,
    '50000000-0000-0000-0000-000000000005'
  );
  IF v_result IS DISTINCT FROM
    '{"allowed": false, "sent_count": 3, "reason": "LIMIT_REACHED"}'::jsonb THEN
    RAISE EXCEPTION 'three-message limit contract failed: %', v_result;
  END IF;

  v_result := public.check_dm_permission(
    v_sender,
    '60000000-0000-0000-0000-000000000006'
  );
  IF v_result IS DISTINCT FROM
    '{"allowed": true, "receiver_replied": true}'::jsonb THEN
    RAISE EXCEPTION 'receiver reply exemption failed: %', v_result;
  END IF;

  v_result := public.check_dm_permission(
    v_sender,
    '70000000-0000-0000-0000-000000000007'
  );
  IF v_result IS DISTINCT FROM
    '{"allowed": true, "is_mutual": true}'::jsonb THEN
    RAISE EXCEPTION 'mutual follow exemption failed: %', v_result;
  END IF;

  BEGIN
    PERFORM public.check_dm_permission(
      NULL,
      '20000000-0000-0000-0000-000000000002'
    );
    RAISE EXCEPTION 'NULL sender unexpectedly succeeded';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN NULL;
  END;

  BEGIN
    PERFORM public.check_dm_permission(v_sender, v_sender);
    RAISE EXCEPTION 'self DM unexpectedly succeeded';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN NULL;
  END;
END
$dm_semantics$;

RESET ROLE;
SQL

# PostgreSQL SELECT RLS is the authorization decision Realtime applies to each
# change. A live member can see message/reaction rows, a non-member cannot, and
# deleting the membership immediately removes that visibility.
psql_cmd <<'SQL'
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  '10000000-0000-0000-0000-000000000001',
  false
);
DO $member_realtime_read$
BEGIN
  IF NOT public.is_current_user_channel_member(
       'd0000000-0000-0000-0000-000000000001'
     ) OR (
       SELECT pg_catalog.count(*)
       FROM public.channel_messages
     ) <> 1 OR (
       SELECT pg_catalog.count(*)
       FROM public.channel_message_reactions
     ) <> 1 THEN
    RAISE EXCEPTION 'member Realtime SELECT contract failed';
  END IF;
END
$member_realtime_read$;
RESET ROLE;

-- Membership alone must not preserve Realtime visibility for an inactive
-- account. Banning and soft-deleting the profile each take effect on the next
-- SELECT, while restoring the same profile restores access without touching
-- the channel_members row.
UPDATE public.user_profiles
SET banned_at = pg_catalog.clock_timestamp()
WHERE id = '10000000-0000-0000-0000-000000000001';

SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  '10000000-0000-0000-0000-000000000001',
  false
);
DO $banned_member_realtime_read$
BEGIN
  IF public.is_current_user_channel_member(
       'd0000000-0000-0000-0000-000000000001'
     ) OR EXISTS (
       SELECT 1 FROM public.channel_messages
     ) OR EXISTS (
       SELECT 1 FROM public.channel_message_reactions
     ) THEN
    RAISE EXCEPTION 'banned member retained Realtime SELECT access';
  END IF;
END
$banned_member_realtime_read$;
RESET ROLE;

UPDATE public.user_profiles
SET banned_at = NULL
WHERE id = '10000000-0000-0000-0000-000000000001';

SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  '10000000-0000-0000-0000-000000000001',
  false
);
DO $restored_after_ban_realtime_read$
BEGIN
  IF NOT public.is_current_user_channel_member(
       'd0000000-0000-0000-0000-000000000001'
     ) OR (
       SELECT pg_catalog.count(*) FROM public.channel_messages
     ) <> 1 OR (
       SELECT pg_catalog.count(*) FROM public.channel_message_reactions
     ) <> 1 THEN
    RAISE EXCEPTION 'member visibility did not recover after ban removal';
  END IF;
END
$restored_after_ban_realtime_read$;
RESET ROLE;

UPDATE public.user_profiles
SET deleted_at = pg_catalog.clock_timestamp()
WHERE id = '10000000-0000-0000-0000-000000000001';

SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  '10000000-0000-0000-0000-000000000001',
  false
);
DO $deleted_member_realtime_read$
BEGIN
  IF public.is_current_user_channel_member(
       'd0000000-0000-0000-0000-000000000001'
     ) OR EXISTS (
       SELECT 1 FROM public.channel_messages
     ) OR EXISTS (
       SELECT 1 FROM public.channel_message_reactions
     ) THEN
    RAISE EXCEPTION 'deleted member retained Realtime SELECT access';
  END IF;
END
$deleted_member_realtime_read$;
RESET ROLE;

UPDATE public.user_profiles
SET deleted_at = NULL
WHERE id = '10000000-0000-0000-0000-000000000001';

SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  '10000000-0000-0000-0000-000000000001',
  false
);
DO $restored_after_delete_realtime_read$
BEGIN
  IF NOT public.is_current_user_channel_member(
       'd0000000-0000-0000-0000-000000000001'
     ) OR (
       SELECT pg_catalog.count(*) FROM public.channel_messages
     ) <> 1 OR (
       SELECT pg_catalog.count(*) FROM public.channel_message_reactions
     ) <> 1 THEN
    RAISE EXCEPTION 'member visibility did not recover after profile restore';
  END IF;
END
$restored_after_delete_realtime_read$;
RESET ROLE;

SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  '20000000-0000-0000-0000-000000000002',
  false
);
DO $nonmember_realtime_read$
BEGIN
  IF public.is_current_user_channel_member(
       'd0000000-0000-0000-0000-000000000001'
     ) OR EXISTS (
       SELECT 1 FROM public.channel_messages
     ) OR EXISTS (
       SELECT 1 FROM public.channel_message_reactions
     ) THEN
    RAISE EXCEPTION 'non-member saw a Realtime-protected row';
  END IF;
END
$nonmember_realtime_read$;
RESET ROLE;

-- Add the second user through the service boundary, proving visibility begins
-- only when the live membership row exists.
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
INSERT INTO public.channel_members(channel_id, user_id, role) VALUES (
  'd0000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000002',
  'member'
);
RESET ROLE;

SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  '20000000-0000-0000-0000-000000000002',
  false
);
DO $new_member_realtime_read$
BEGIN
  IF NOT public.is_current_user_channel_member(
       'd0000000-0000-0000-0000-000000000001'
     ) OR (
       SELECT pg_catalog.count(*) FROM public.channel_messages
     ) <> 1 OR (
       SELECT pg_catalog.count(*) FROM public.channel_message_reactions
     ) <> 1 THEN
    RAISE EXCEPTION 'new member did not receive Realtime SELECT access';
  END IF;
END
$new_member_realtime_read$;
RESET ROLE;

SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DELETE FROM public.channel_members
WHERE channel_id = 'd0000000-0000-0000-0000-000000000001'
  AND user_id = '20000000-0000-0000-0000-000000000002';
RESET ROLE;

SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  '20000000-0000-0000-0000-000000000002',
  false
);
DO $removed_member_realtime_read$
BEGIN
  IF public.is_current_user_channel_member(
       'd0000000-0000-0000-0000-000000000001'
     ) OR EXISTS (
       SELECT 1 FROM public.channel_messages
     ) OR EXISTS (
       SELECT 1 FROM public.channel_message_reactions
     ) THEN
    RAISE EXCEPTION 'removed member retained Realtime SELECT access';
  END IF;
END
$removed_member_realtime_read$;
RESET ROLE;
SQL

echo "channel membership server boundary PG17 proof passed"
