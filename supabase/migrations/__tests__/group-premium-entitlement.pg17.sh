#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for current premium-group entitlement.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716176100_group_premium_entitlement.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/group-premium-entitlement-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55577
mkdir -p "$SOCKET_DIR" "$LOG_DIR"

cleanup() {
  local exit_status=$?
  if ((exit_status != 0)) && [[ -f "$LOG_DIR/postgres.log" ]]; then
    tail -200 "$LOG_DIR/postgres.log" >&2 || true
  fi
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

expect_failure() {
  local sql="$1"
  local label="$2"
  if psql_cmd -Atqc "$sql" >/dev/null 2>&1; then
    echo "Expected failure: $label" >&2
    return 1
  fi
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_DIR/postgres.log" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE cli_login_postgres LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE hostile_role NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT service_role TO authenticator WITH INHERIT FALSE, SET TRUE;
GRANT postgres TO cli_login_postgres WITH INHERIT FALSE, SET TRUE;

CREATE SCHEMA auth;
CREATE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid
$function$;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')
$function$;
GRANT USAGE ON SCHEMA auth TO PUBLIC;
GRANT USAGE ON SCHEMA public
  TO anon, authenticated, service_role, hostile_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO PUBLIC;

CREATE TYPE public.member_role AS ENUM ('owner', 'admin', 'member');
CREATE TYPE public.group_visibility AS ENUM ('open', 'apply');
CREATE TYPE public.post_status AS ENUM ('active', 'locked', 'deleted');

CREATE TABLE public.groups (
  id uuid PRIMARY KEY,
  created_by uuid NOT NULL,
  is_premium_only boolean NOT NULL DEFAULT false,
  visibility public.group_visibility NOT NULL DEFAULT 'open',
  dissolved_at timestamptz
);
ALTER TABLE public.groups OWNER TO postgres;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false,
  ban_expires_at timestamptz,
  subscription_tier text,
  pro_expires_at timestamptz
);
ALTER TABLE public.user_profiles OWNER TO postgres;

CREATE TABLE public.subscriptions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  tier text,
  plan text,
  status text NOT NULL,
  current_period_end timestamptz
);
ALTER TABLE public.subscriptions OWNER TO postgres;

CREATE TABLE public.group_subscriptions (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL,
  user_id uuid NOT NULL,
  status text NOT NULL,
  expires_at timestamptz NOT NULL
);
ALTER TABLE public.group_subscriptions OWNER TO postgres;

CREATE TABLE public.group_members (
  group_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role public.member_role NOT NULL,
  muted_until timestamptz,
  PRIMARY KEY (group_id, user_id)
);
ALTER TABLE public.group_members OWNER TO postgres;

CREATE TABLE public.group_bans (
  group_id uuid NOT NULL,
  user_id uuid NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
ALTER TABLE public.group_bans OWNER TO postgres;
CREATE TABLE public.group_join_requests (id uuid);
ALTER TABLE public.group_join_requests OWNER TO postgres;
CREATE TABLE public.group_invites (id uuid);
ALTER TABLE public.group_invites OWNER TO postgres;
CREATE TABLE public.group_invite_redemptions (id uuid);
ALTER TABLE public.group_invite_redemptions OWNER TO postgres;
CREATE TABLE public.group_audit_log (id uuid);
ALTER TABLE public.group_audit_log OWNER TO postgres;
CREATE TABLE public.blocked_users (
  blocker_id uuid NOT NULL,
  blocked_id uuid NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
ALTER TABLE public.blocked_users OWNER TO postgres;
CREATE TABLE public.user_follows (
  follower_id uuid NOT NULL,
  following_id uuid NOT NULL,
  PRIMARY KEY (follower_id, following_id)
);
ALTER TABLE public.user_follows OWNER TO postgres;

CREATE TABLE public.posts (
  id uuid PRIMARY KEY,
  group_id uuid,
  author_id uuid NOT NULL,
  title text,
  content text,
  poll_enabled boolean NOT NULL DEFAULT false,
  images text[],
  is_sensitive boolean NOT NULL DEFAULT false,
  content_warning text,
  original_post_id uuid REFERENCES public.posts(id),
  visibility text NOT NULL DEFAULT 'public',
  status public.post_status NOT NULL DEFAULT 'active',
  deleted_at timestamptz,
  view_count integer NOT NULL DEFAULT 0
);
ALTER TABLE public.posts OWNER TO postgres;
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.posts TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.posts TO service_role;
CREATE POLICY posts_fixture_read
  ON public.posts FOR SELECT TO PUBLIC USING (true);
CREATE POLICY posts_fixture_insert
  ON public.posts FOR INSERT TO authenticated
  WITH CHECK (author_id = (SELECT auth.uid()));
CREATE POLICY posts_fixture_update
  ON public.posts FOR UPDATE TO authenticated
  USING (author_id = (SELECT auth.uid()))
  WITH CHECK (author_id = (SELECT auth.uid()));
CREATE POLICY posts_fixture_delete
  ON public.posts FOR DELETE TO authenticated
  USING (author_id = (SELECT auth.uid()));
CREATE POLICY posts_fixture_service
  ON public.posts FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE FUNCTION public.guard_post_authorization_identity()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'public'
     OR TG_TABLE_NAME IS DISTINCT FROM 'posts'
     OR TG_OP IS DISTINCT FROM 'UPDATE'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'post authorization identity guard is misattached';
  END IF;

  IF NEW.author_id IS DISTINCT FROM OLD.author_id
     OR NEW.original_post_id IS DISTINCT FROM OLD.original_post_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'post author and repost root identity are immutable';
  END IF;

  RETURN NEW;
END
$function$;
ALTER FUNCTION public.guard_post_authorization_identity() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_post_authorization_identity() FROM PUBLIC;

CREATE TRIGGER trg_posts_00_guard_authorization_identity
BEFORE UPDATE OF author_id, original_post_id
ON public.posts
FOR EACH ROW
EXECUTE FUNCTION public.guard_post_authorization_identity();

CREATE FUNCTION public.can_actor_read_post_fields(
  p_viewer_id uuid,
  p_author_id uuid,
  p_group_id uuid,
  p_visibility text,
  p_status public.post_status,
  p_deleted_at timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT p_author_id IS NOT NULL
    AND p_visibility IS NOT NULL
    AND p_status IN ('active'::public.post_status, 'locked'::public.post_status)
    AND p_deleted_at IS NULL
$function$;
ALTER FUNCTION public.can_actor_read_post_fields(
  uuid, uuid, uuid, text, public.post_status, timestamptz
) OWNER TO postgres;

CREATE FUNCTION public.can_actor_read_post_id(
  p_post_id uuid,
  p_viewer_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE((
    SELECT public.can_actor_read_post_fields(
      p_viewer_id,
      wrapper.author_id,
      wrapper.group_id,
      wrapper.visibility,
      wrapper.status,
      wrapper.deleted_at
    ) AND (
      wrapper.original_post_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.posts AS root
        WHERE root.id = wrapper.original_post_id
          AND root.original_post_id IS NULL
          AND public.can_actor_read_post_fields(
            p_viewer_id,
            root.author_id,
            root.group_id,
            root.visibility,
            root.status,
            root.deleted_at
          )
      )
    )
    FROM public.posts AS wrapper
    WHERE wrapper.id = p_post_id
  ), false)
$function$;
ALTER FUNCTION public.can_actor_read_post_id(uuid, uuid) OWNER TO postgres;

CREATE FUNCTION public.can_service_actor_read_post(
  p_post_id uuid,
  p_actor_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  RETURN public.can_actor_read_post_id(p_post_id, p_actor_id);
END
$function$;
ALTER FUNCTION public.can_service_actor_read_post(uuid, uuid) OWNER TO postgres;

CREATE FUNCTION public.get_following_posts_page(
  p_viewer_id uuid,
  p_limit integer DEFAULT 20,
  p_before_created_at timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL,
  p_group_id uuid DEFAULT NULL,
  p_group_ids uuid[] DEFAULT NULL,
  p_author_handle text DEFAULT NULL,
  p_language text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;

  SELECT pg_catalog.jsonb_build_object(
    'posts',
    COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('id', wrapper.id)
        ORDER BY wrapper.id
      ),
      '[]'::jsonb
    )
  )
  INTO v_result
  FROM public.posts AS wrapper
  LEFT JOIN public.posts AS root
    ON root.id = wrapper.original_post_id
   AND root.original_post_id IS NULL
  WHERE EXISTS (
      SELECT 1
      FROM public.user_follows AS followed_author
      WHERE followed_author.follower_id = p_viewer_id
        AND followed_author.following_id = wrapper.author_id
    )
    AND public.can_actor_read_post_fields(
      p_viewer_id,
      wrapper.author_id,
      wrapper.group_id,
      wrapper.visibility,
      wrapper.status,
      wrapper.deleted_at
    )
    AND (
      wrapper.original_post_id IS NULL
      OR (
        root.id IS NOT NULL
        AND public.can_actor_read_post_fields(
          p_viewer_id,
          root.author_id,
          root.group_id,
          root.visibility,
          root.status,
          root.deleted_at
        )
      )
    );

  RETURN v_result;
END
$function$;
ALTER FUNCTION public.get_following_posts_page(
  uuid, integer, timestamptz, uuid, uuid, uuid[], text, text
) OWNER TO postgres;

CREATE FUNCTION public.mutate_group_membership_atomic(
  p_actor_id uuid,
  p_group_id uuid,
  p_action text,
  p_pro_free_promo boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_profile public.user_profiles%ROWTYPE;
  v_group public.groups%ROWTYPE;
BEGIN
  SELECT * INTO v_profile FROM public.user_profiles WHERE id = p_actor_id;
  SELECT * INTO v_group FROM public.groups WHERE id = p_group_id;
  IF COALESCE(v_group.is_premium_only, false)
    AND NOT COALESCE(p_pro_free_promo, false)
    AND COALESCE(v_profile.subscription_tier, 'free') <> 'pro'
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'pro_required');
  END IF;
  RETURN pg_catalog.jsonb_build_object('status', 'eligible');
END
$function$;
ALTER FUNCTION public.mutate_group_membership_atomic(uuid, uuid, text, boolean)
  OWNER TO postgres;

CREATE FUNCTION public.redeem_group_invite_atomic(
  p_actor_id uuid,
  p_group_id uuid,
  p_token text,
  p_pro_free_promo boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_profile public.user_profiles%ROWTYPE;
  v_group public.groups%ROWTYPE;
BEGIN
  SELECT * INTO v_profile FROM public.user_profiles WHERE id = p_actor_id;
  SELECT * INTO v_group FROM public.groups WHERE id = p_group_id;
  IF COALESCE(v_group.is_premium_only, false)
    AND NOT COALESCE(p_pro_free_promo, false)
    AND COALESCE(v_profile.subscription_tier, 'free') <> 'pro'
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'pro_required');
  END IF;
  RETURN pg_catalog.jsonb_build_object('status', 'eligible');
END
$function$;
ALTER FUNCTION public.redeem_group_invite_atomic(uuid, uuid, text, boolean)
  OWNER TO postgres;

CREATE FUNCTION public.mutate_group_join_request_atomic(
  p_actor_id uuid,
  p_group_id uuid,
  p_action text,
  p_operation_id text,
  p_pro_free_promo boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_profile public.user_profiles%ROWTYPE;
  v_group public.groups%ROWTYPE;
BEGIN
  SELECT * INTO v_profile FROM public.user_profiles WHERE id = p_actor_id;
  SELECT * INTO v_group FROM public.groups WHERE id = p_group_id;
  IF COALESCE(v_group.is_premium_only, false)
    AND NOT COALESCE(p_pro_free_promo, false)
    AND COALESCE(v_profile.subscription_tier, 'free') <> 'pro'
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'pro_required');
  END IF;
  RETURN pg_catalog.jsonb_build_object('status', 'eligible');
END
$function$;
ALTER FUNCTION public.mutate_group_join_request_atomic(uuid, uuid, text, text, boolean)
  OWNER TO postgres;

CREATE FUNCTION public.inspect_group_invite_atomic(
  p_actor_id uuid,
  p_group_id uuid,
  p_token text,
  p_pro_free_promo boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_profile public.user_profiles%ROWTYPE;
  v_group public.groups%ROWTYPE;
BEGIN
  SELECT * INTO v_profile FROM public.user_profiles WHERE id = p_actor_id;
  SELECT * INTO v_group FROM public.groups WHERE id = p_group_id;
  IF COALESCE(v_group.is_premium_only, false)
    AND NOT COALESCE(p_pro_free_promo, false)
    AND COALESCE(v_profile.subscription_tier, 'free') <> 'pro'
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'pro_required');
  END IF;
  RETURN pg_catalog.jsonb_build_object('status', 'eligible');
END
$function$;
ALTER FUNCTION public.inspect_group_invite_atomic(uuid, uuid, text, boolean)
  OWNER TO postgres;

INSERT INTO public.user_profiles (
  id, subscription_tier, pro_expires_at
) VALUES
  ('10000000-0000-4000-8000-000000000001', 'free', NULL),
  ('20000000-0000-4000-8000-000000000002', 'free', NULL),
  ('30000000-0000-4000-8000-000000000003', 'free', NULL),
  ('40000000-0000-4000-8000-000000000004', 'free', NULL),
  ('50000000-0000-4000-8000-000000000005', 'free', NULL),
  (
    '60000000-0000-4000-8000-000000000006',
    'pro',
    pg_catalog.clock_timestamp() - interval '1 day'
  );

INSERT INTO public.groups (id, created_by, is_premium_only) VALUES
  (
    'a0000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000004',
    false
  ),
  (
    'a0000000-0000-4000-8000-000000000002',
    '40000000-0000-4000-8000-000000000004',
    true
  );

INSERT INTO public.group_members (group_id, user_id, role) VALUES
  (
    'a0000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    'member'
  ),
  (
    'a0000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    'member'
  ),
  (
    'a0000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000003',
    'member'
  ),
  (
    'a0000000-0000-4000-8000-000000000002',
    '50000000-0000-4000-8000-000000000005',
    'admin'
  );

INSERT INTO public.user_follows (follower_id, following_id) VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000004'
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '40000000-0000-4000-8000-000000000004'
  ),
  (
    '30000000-0000-4000-8000-000000000003',
    '40000000-0000-4000-8000-000000000004'
  );

INSERT INTO public.group_subscriptions (
  id, group_id, user_id, status, expires_at
) VALUES
  (
    'b0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    'active',
    pg_catalog.clock_timestamp() + interval '1 day'
  ),
  (
    'b0000000-0000-4000-8000-000000000002',
    'a0000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    'active',
    pg_catalog.clock_timestamp() - interval '1 second'
  );

INSERT INTO public.subscriptions (
  id, user_id, tier, plan, status, current_period_end
) VALUES
  (
    'c0000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000003',
    'pro',
    'monthly',
    'active',
    pg_catalog.clock_timestamp() + interval '1 day'
  ),
  (
    'c0000000-0000-4000-8000-000000000002',
    '60000000-0000-4000-8000-000000000006',
    'pro',
    'monthly',
    'active',
    pg_catalog.clock_timestamp() - interval '1 second'
  );

INSERT INTO public.posts (
  id, group_id, author_id, content, visibility
) VALUES
  (
    'd0000000-0000-4000-8000-000000000001',
    NULL,
    '40000000-0000-4000-8000-000000000004',
    'general',
    'public'
  ),
  (
    'd0000000-0000-4000-8000-000000000002',
    'a0000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000004',
    'nonpremium',
    'public'
  ),
  (
    'd0000000-0000-4000-8000-000000000003',
    'a0000000-0000-4000-8000-000000000002',
    '40000000-0000-4000-8000-000000000004',
    'premium-owner',
    'group'
  ),
  (
    'd0000000-0000-4000-8000-000000000004',
    'a0000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    'premium-expired-author',
    'group'
  );

INSERT INTO public.posts (
  id, group_id, author_id, content, original_post_id
) VALUES (
  'd0000000-0000-4000-8000-000000000007',
  NULL,
  '40000000-0000-4000-8000-000000000004',
  'public-wrapper-premium-root',
  'd0000000-0000-4000-8000-000000000003'
);
SQL

# A noncanonical direct service member must fail before any helper or policy is
# created, then the canonical authenticator edge applies cleanly.
psql_cmd -c \
  'GRANT service_role TO hostile_role WITH INHERIT FALSE, SET TRUE' >/dev/null
if psql_cmd -f "$MIGRATION" >"$LOG_DIR/unsafe-role.log" \
  2>"$TMP_ROOT/unsafe-role.err"; then
  echo 'Migration accepted an unsafe premium-entitlement role graph' >&2
  exit 1
fi
if ! grep -q 'group premium entitlement service-role graph is unsafe' \
  "$TMP_ROOT/unsafe-role.err"; then
  echo 'Migration failed for an unexpected unsafe-role reason' >&2
  cat "$TMP_ROOT/unsafe-role.err" >&2
  exit 1
fi
psql_cmd -c 'REVOKE service_role FROM hostile_role' >/dev/null

psql_cmd -f "$MIGRATION" >"$LOG_DIR/first-application.log"

expect_failure \
  "SET ROLE authenticated; SELECT public.has_current_group_entitlement('10000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002')" \
  'authenticated arbitrary-actor entitlement helper'
expect_failure \
  "SET ROLE authenticated; SELECT public.service_actor_has_current_group_entitlement('10000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002')" \
  'authenticated service entitlement wrapper'

psql_cmd <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $entry_contract$
DECLARE
  v_premium constant uuid := 'a0000000-0000-4000-8000-000000000002';
  v_public constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_wrapper constant uuid := 'd0000000-0000-4000-8000-000000000007';
  v_following jsonb;
BEGIN
  IF NOT public.service_actor_has_current_group_entitlement(
    '10000000-0000-4000-8000-000000000001', v_premium
  ) OR NOT public.service_actor_has_current_group_entitlement(
    '30000000-0000-4000-8000-000000000003', v_premium
  ) OR NOT public.service_actor_has_current_group_entitlement(
    '40000000-0000-4000-8000-000000000004', v_premium
  ) OR NOT public.service_actor_has_current_group_entitlement(
    '50000000-0000-4000-8000-000000000005', v_premium
  ) OR public.service_actor_has_current_group_entitlement(
    '20000000-0000-4000-8000-000000000002', v_premium
  ) OR public.service_actor_has_current_group_entitlement(
    '60000000-0000-4000-8000-000000000006', v_premium
  ) OR NOT public.service_actor_has_current_group_entitlement(
    '60000000-0000-4000-8000-000000000006', v_public
  ) THEN
    RAISE EXCEPTION 'group entitlement truth table mismatch';
  END IF;

  IF NOT public.service_actor_has_current_global_pro_entitlement(
    '30000000-0000-4000-8000-000000000003'
  ) OR public.service_actor_has_current_global_pro_entitlement(
    '60000000-0000-4000-8000-000000000006'
  ) THEN
    RAISE EXCEPTION 'global Pro entitlement truth table mismatch';
  END IF;

  IF public.can_service_actor_read_post(
    v_wrapper,
    '20000000-0000-4000-8000-000000000002'
  ) OR NOT public.can_service_actor_read_post(
    v_wrapper,
    '10000000-0000-4000-8000-000000000001'
  ) OR NOT public.can_service_actor_read_post(
    v_wrapper,
    '30000000-0000-4000-8000-000000000003'
  ) THEN
    RAISE EXCEPTION 'service wrapper/root entitlement composition mismatch';
  END IF;

  v_following := public.get_following_posts_page(
    '20000000-0000-4000-8000-000000000002'
  );
  IF pg_catalog.strpos(v_following::text, v_wrapper::text) > 0 THEN
    RAISE EXCEPTION 'following feed leaked premium root through public wrapper';
  END IF;
  v_following := public.get_following_posts_page(
    '10000000-0000-4000-8000-000000000001'
  );
  IF pg_catalog.strpos(v_following::text, v_wrapper::text) = 0 THEN
    RAISE EXCEPTION 'current group pass lost following wrapper/root read';
  END IF;
  v_following := public.get_following_posts_page(
    '30000000-0000-4000-8000-000000000003'
  );
  IF pg_catalog.strpos(v_following::text, v_wrapper::text) = 0 THEN
    RAISE EXCEPTION 'current global Pro lost following wrapper/root read';
  END IF;

  IF public.mutate_group_membership_atomic(
    '10000000-0000-4000-8000-000000000001', v_premium, 'join', false
  ) ->> 'status' <> 'eligible' OR public.redeem_group_invite_atomic(
    '30000000-0000-4000-8000-000000000003', v_premium, 'token', false
  ) ->> 'status' <> 'eligible' OR public.mutate_group_join_request_atomic(
    '50000000-0000-4000-8000-000000000005', v_premium, 'submit', 'op', false
  ) ->> 'status' <> 'eligible' OR public.inspect_group_invite_atomic(
    '20000000-0000-4000-8000-000000000002', v_premium, 'token', false
  ) ->> 'status' <> 'pro_required' OR public.inspect_group_invite_atomic(
    '20000000-0000-4000-8000-000000000002', v_premium, 'token', true
  ) ->> 'status' <> 'eligible' THEN
    RAISE EXCEPTION 'membership entry-point entitlement wiring mismatch';
  END IF;
END
$entry_contract$;
RESET ROLE;
SQL

# The route's admin client bypasses RLS, so service writes must still cross the
# PostgreSQL-owned publish guard. Expired paid state fails closed on INSERT and
# user-content UPDATE, while the failed statements leave no partial changes.
expect_failure \
  "SET ROLE service_role; INSERT INTO public.posts(id,group_id,author_id,content,visibility) VALUES('d0000000-0000-4000-8000-000000000010','a0000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','service-denied','group')" \
  'expired service premium insert'
if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.posts WHERE id='d0000000-0000-4000-8000-000000000010'")" != '0' ]]; then
  echo 'Expired service INSERT left a partial post' >&2
  exit 1
fi
expect_failure \
  "SET ROLE service_role; BEGIN; UPDATE public.posts SET content='service-denied-update' WHERE id='d0000000-0000-4000-8000-000000000004'; COMMIT" \
  'expired service premium content update'
if [[ "$(psql_cmd -Atqc "SELECT content FROM public.posts WHERE id='d0000000-0000-4000-8000-000000000004'")" != 'premium-expired-author' ]]; then
  echo 'Expired service UPDATE was not rolled back' >&2
  exit 1
fi

# Current group-pass and global-Pro authors succeed through the same service
# path. Counter and explicit moderation updates remain operational after an
# author's pass expires because they do not republish user-controlled content.
psql_cmd <<'SQL'
SET ROLE service_role;
INSERT INTO public.posts (
  id, group_id, author_id, content, visibility
) VALUES
  (
    'd0000000-0000-4000-8000-000000000008',
    'a0000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    'service-pass-created',
    'group'
  ),
  (
    'd0000000-0000-4000-8000-000000000009',
    'a0000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000003',
    'service-pro-created',
    'group'
  );
UPDATE public.posts
SET content = 'service-pass-updated'
WHERE id = 'd0000000-0000-4000-8000-000000000008';
UPDATE public.posts
SET content = 'service-pro-updated'
WHERE id = 'd0000000-0000-4000-8000-000000000009';
UPDATE public.posts
SET view_count = view_count + 1,
    status = 'locked'
WHERE id = 'd0000000-0000-4000-8000-000000000004';
RESET ROLE;
SQL
if [[ "$(psql_cmd -Atqc "SELECT content || ':' || view_count::text || ':' || status::text FROM public.posts WHERE id='d0000000-0000-4000-8000-000000000004'")" != 'premium-expired-author:1:locked' ]]; then
  echo 'Background counter or moderation update crossed the publish guard' >&2
  exit 1
fi

# Audience and author identity cannot drift. The content assignment in each
# transaction proves the whole failed statement rolls back, not just the key.
expect_failure \
  "SET ROLE service_role; BEGIN; UPDATE public.posts SET content='group-drift-partial',group_id='a0000000-0000-4000-8000-000000000001' WHERE id='d0000000-0000-4000-8000-000000000008'; COMMIT" \
  'service group audience drift'
expect_failure \
  "SET ROLE service_role; BEGIN; UPDATE public.posts SET content='author-drift-partial',author_id='30000000-0000-4000-8000-000000000003' WHERE id='d0000000-0000-4000-8000-000000000008'; COMMIT" \
  'service author identity drift'
if [[ "$(psql_cmd -Atqc "SELECT content || ':' || group_id::text || ':' || author_id::text FROM public.posts WHERE id='d0000000-0000-4000-8000-000000000008'")" != 'service-pass-updated:a0000000-0000-4000-8000-000000000002:10000000-0000-4000-8000-000000000001' ]]; then
  echo 'Identity drift failure did not roll back the full post update' >&2
  exit 1
fi

# Anonymous users retain general/nonpremium reads but never premium reads.
if [[ "$(psql_cmd -Atqc "SET ROLE anon; SELECT pg_catalog.count(*) FROM public.posts")" != '2' ]]; then
  echo 'Anonymous premium post boundary mismatch' >&2
  exit 1
fi

# A current group pass can read and create premium content.
psql_cmd <<'SQL'
SET ROLE authenticated;
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  false
);
INSERT INTO public.posts (
  id, group_id, author_id, content, visibility
) VALUES (
  'd0000000-0000-4000-8000-000000000005',
  'a0000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001',
  'pass-created',
  'group'
);
UPDATE public.posts SET content = 'pass-updated'
WHERE id = 'd0000000-0000-4000-8000-000000000005';
RESET ROLE;
SQL

# Expiry denies even the historical author SELECT/INSERT/UPDATE. The direct
# table DELETE remains unable to target a row hidden by the SELECT boundary;
# a dedicated actor-bound delete path, if required, must be added separately.
if [[ "$(psql_cmd -Atqc "SET ROLE authenticated; SELECT pg_catalog.set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000002',false); SELECT pg_catalog.count(*) FROM public.posts WHERE group_id = 'a0000000-0000-4000-8000-000000000002'")" != $'20000000-0000-4000-8000-000000000002\n0' ]]; then
  echo 'Expired premium author retained SELECT access' >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SET ROLE authenticated; SELECT pg_catalog.set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000002',false); SELECT pg_catalog.count(*) FROM public.posts WHERE id='d0000000-0000-4000-8000-000000000007'")" != $'20000000-0000-4000-8000-000000000002\n0' ]]; then
  echo 'Expired actor read a public wrapper over a premium root' >&2
  exit 1
fi
expect_failure \
  "SET ROLE authenticated; SELECT pg_catalog.set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000002',false); INSERT INTO public.posts(id,group_id,author_id,content,visibility) VALUES('d0000000-0000-4000-8000-000000000006','a0000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','denied','group')" \
  'expired premium author insert'
if [[ "$(psql_cmd -Atqc "SET ROLE authenticated; SELECT pg_catalog.set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000002',false); WITH changed AS (UPDATE public.posts SET content='denied-update' WHERE id='d0000000-0000-4000-8000-000000000004' RETURNING 1) SELECT pg_catalog.count(*) FROM changed")" != $'20000000-0000-4000-8000-000000000002\n0' ]]; then
  echo 'Expired premium author retained UPDATE access' >&2
  exit 1
fi
psql_cmd -Atqc "SET ROLE authenticated; SELECT pg_catalog.set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000002',false); DELETE FROM public.posts WHERE id IN ('d0000000-0000-4000-8000-000000000003','d0000000-0000-4000-8000-000000000004')" >/dev/null
if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.string_agg(id::text, ',' ORDER BY id) FROM public.posts WHERE id IN ('d0000000-0000-4000-8000-000000000003','d0000000-0000-4000-8000-000000000004')")" != 'd0000000-0000-4000-8000-000000000003,d0000000-0000-4000-8000-000000000004' ]]; then
  echo 'Expired author DELETE boundary changed' >&2
  exit 1
fi
psql_cmd -Atqc "SET ROLE service_role; DELETE FROM public.posts WHERE id='d0000000-0000-4000-8000-000000000004'" >/dev/null
if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM public.posts WHERE id='d0000000-0000-4000-8000-000000000004'")" != '0' ]]; then
  echo 'Trusted service DELETE was restricted by browser entitlement RLS' >&2
  exit 1
fi

# Current global Pro, the creator, and an admin are all positive browser cases.
for actor in \
  10000000-0000-4000-8000-000000000001 \
  30000000-0000-4000-8000-000000000003 \
  40000000-0000-4000-8000-000000000004 \
  50000000-0000-4000-8000-000000000005; do
  if [[ "$(psql_cmd -Atqc "SET ROLE authenticated; SELECT pg_catalog.set_config('request.jwt.claim.sub','$actor',false); SELECT pg_catalog.count(*) FROM public.posts WHERE id IN ('d0000000-0000-4000-8000-000000000003','d0000000-0000-4000-8000-000000000007')")" != "$actor"$'\n2' ]]; then
    echo "Positive premium post reader failed: $actor" >&2
    exit 1
  fi
done

# Reapply after ACL, policy, and RLS drift. The source is already patched, so
# this also proves idempotent forward-porting of the latest entry points.
psql_cmd <<'SQL'
ALTER TABLE public.posts DISABLE ROW LEVEL SECURITY;
GRANT EXECUTE ON FUNCTION public.has_current_group_entitlement(uuid, uuid)
  TO authenticated, hostile_role WITH GRANT OPTION;
GRANT EXECUTE ON FUNCTION public.current_user_has_current_group_entitlement(uuid)
  TO hostile_role, service_role;
GRANT EXECUTE ON FUNCTION public.enforce_current_group_post_publish()
  TO hostile_role WITH GRANT OPTION;
ALTER TABLE public.posts DISABLE TRIGGER trg_posts_15_current_group_publish;
DROP POLICY posts_group_premium_read_entitlement ON public.posts;
CREATE POLICY posts_group_premium_read_entitlement
  ON public.posts AS PERMISSIVE FOR SELECT TO PUBLIC USING (true);
SQL

psql_cmd -f "$MIGRATION" >"$LOG_DIR/replay-application.log"

psql_cmd <<'SQL'
DO $replay_contract$
DECLARE
  v_postgres oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres'
  );
BEGIN
  IF pg_catalog.has_function_privilege(
    'authenticated',
    'public.has_current_group_entitlement(uuid,uuid)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'hostile_role',
    'public.has_current_group_entitlement(uuid,uuid)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'hostile_role',
    'public.current_user_has_current_group_entitlement(uuid)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'hostile_role',
    'public.enforce_current_group_post_publish()',
    'EXECUTE'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.posts'::pg_catalog.regclass
      AND relation.relowner = v_postgres
      AND relation.relrowsecurity
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.posts'::pg_catalog.regclass
      AND policy.polname = 'posts_group_premium_read_entitlement'
      AND NOT policy.polpermissive
      AND pg_catalog.strpos(
        pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true),
        'current_user_can_read_post_with_current_entitlement(id)'
      ) > 0
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.posts'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_posts_15_current_group_publish'
      AND trigger_row.tgfoid =
        'public.enforce_current_group_post_publish()'::pg_catalog.regprocedure
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 23
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'premium entitlement replay did not converge';
  END IF;
END
$replay_contract$;
SQL

echo 'group premium entitlement PG17 proof passed'
