#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for atomic group join/leave/invite authorization.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716113900_atomic_group_membership.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ ! -f "$MIGRATION" ]]; then
  echo "Atomic group membership migration is missing: $MIGRATION" >&2
  exit 1
fi
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/atomic-group-membership-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55479
mkdir -p "$SOCKET_DIR" "$LOG_DIR"

cleanup() {
  local exit_status=$?
  if (( exit_status != 0 )) && [[ -f "$LOG_DIR/postgres.log" ]]; then
    echo "PostgreSQL 17 integration cluster log:" >&2
    tail -200 "$LOG_DIR/postgres.log" >&2 || true
  fi
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

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

psql_cmd() {
  "$PG_BIN/psql" \
    -X \
    -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" \
    -p "$PORT" \
    -d postgres \
    "$@"
}

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE drifted_member_writer NOLOGIN;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, drifted_member_writer;

CREATE TYPE public.member_role AS ENUM ('owner', 'admin', 'member');
CREATE TYPE public.group_visibility AS ENUM ('open', 'apply');

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean DEFAULT false,
  ban_expires_at timestamptz,
  subscription_tier text DEFAULT 'free',
  reputation_score integer DEFAULT 0,
  is_verified_trader boolean DEFAULT false
);

CREATE TABLE public.groups (
  id uuid PRIMARY KEY,
  created_by uuid NOT NULL,
  visibility public.group_visibility NOT NULL DEFAULT 'open',
  member_count integer,
  dissolved_at timestamptz,
  is_premium_only boolean DEFAULT false,
  min_arena_score integer DEFAULT 0,
  is_verified_only boolean DEFAULT false
);

CREATE TABLE public.group_members (
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role public.member_role NOT NULL DEFAULT 'member',
  joined_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE public.group_bans (
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  banned_by uuid,
  reason text,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE public.group_invites (
  id uuid PRIMARY KEY,
  group_id uuid REFERENCES public.groups(id) ON DELETE CASCADE,
  created_by uuid,
  token_hash text NOT NULL,
  max_uses integer,
  used_count integer,
  expires_at timestamptz,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp()
);
CREATE INDEX idx_group_invites_token_hash ON public.group_invites(token_hash);

CREATE TABLE public.group_join_requests (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  answer_text text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE public.membership_join_log (
  group_id uuid NOT NULL,
  user_id uuid NOT NULL
);

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.groups OWNER TO postgres;
ALTER TABLE public.group_members OWNER TO postgres;
ALTER TABLE public.group_bans OWNER TO postgres;
ALTER TABLE public.group_invites OWNER TO postgres;
ALTER TABLE public.group_join_requests OWNER TO postgres;
ALTER TABLE public.membership_join_log OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.sync_group_member_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.groups SET member_count = member_count + 1 WHERE id = NEW.group_id;
    RETURN NEW;
  END IF;
  UPDATE public.groups
  SET member_count = GREATEST(member_count - 1, 0)
  WHERE id = OLD.group_id;
  RETURN OLD;
END
$function$;
ALTER FUNCTION public.sync_group_member_count() OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.update_group_member_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.groups SET member_count = member_count + 1 WHERE id = NEW.group_id;
    RETURN NEW;
  END IF;
  UPDATE public.groups SET member_count = member_count - 1 WHERE id = OLD.group_id;
  RETURN OLD;
END
$function$;
ALTER FUNCTION public.update_group_member_count() OWNER TO postgres;

CREATE TRIGGER trigger_sync_member_count
  AFTER INSERT OR DELETE ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.sync_group_member_count();
CREATE TRIGGER trg_update_group_member_count
  AFTER INSERT OR DELETE ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.update_group_member_count();

CREATE OR REPLACE FUNCTION public.log_group_join_fixture()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  INSERT INTO public.membership_join_log(group_id, user_id)
  VALUES (NEW.group_id, NEW.user_id);
  RETURN NEW;
END
$function$;
ALTER FUNCTION public.log_group_join_fixture() OWNER TO postgres;
CREATE TRIGGER trg_log_group_join_activity
  AFTER INSERT ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.log_group_join_fixture();

CREATE OR REPLACE FUNCTION public.increment_member_count(group_id uuid)
RETURNS integer
LANGUAGE sql
AS $function$
  UPDATE public.groups
  SET member_count = COALESCE(member_count, 0) + 1
  WHERE id = group_id
  RETURNING member_count
$function$;
CREATE OR REPLACE FUNCTION public.increment_member_count(p_group_id uuid, p_delta integer)
RETURNS void
LANGUAGE sql
AS $function$
  UPDATE public.groups
  SET member_count = GREATEST(COALESCE(member_count, 0) + p_delta, 0)
  WHERE id = p_group_id
$function$;
ALTER FUNCTION public.increment_member_count(uuid) OWNER TO postgres;
ALTER FUNCTION public.increment_member_count(uuid, integer) OWNER TO postgres;
CREATE OR REPLACE FUNCTION public.decrement_member_count(group_id uuid)
RETURNS integer
LANGUAGE sql
AS $function$
  UPDATE public.groups
  SET member_count = GREATEST(COALESCE(member_count, 0) - 1, 0)
  WHERE id = group_id
  RETURNING member_count
$function$;
ALTER FUNCTION public.decrement_member_count(uuid) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.increment_member_count(uuid)
  TO PUBLIC, anon, authenticated, service_role, drifted_member_writer;
GRANT EXECUTE ON FUNCTION public.increment_member_count(uuid, integer)
  TO PUBLIC, anon, authenticated, service_role, drifted_member_writer;
GRANT EXECUTE ON FUNCTION public.decrement_member_count(uuid)
  TO PUBLIC, anon, authenticated, service_role, drifted_member_writer;

INSERT INTO public.user_profiles (
  id, subscription_tier, reputation_score, is_verified_trader
) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'pro', 100, true),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'free', 50, true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'free', 50, true),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'free', 50, true),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'free', 50, true),
  ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'free', 50, true),
  ('11111111-1111-4111-8111-111111111111', 'free', 50, true),
  ('22222222-2222-4222-8222-222222222222', 'free', 50, true),
  ('33333333-3333-4333-8333-333333333333', 'free', 50, true);

INSERT INTO public.groups (
  id, created_by, visibility, member_count
) VALUES
  ('10000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'open', NULL),
  ('20000000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'apply', 99),
  ('30000000-0000-4000-8000-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'open', -4);

INSERT INTO public.group_members(group_id, user_id, role) VALUES
  ('10000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner'),
  ('20000000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner'),
  ('30000000-0000-4000-8000-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner');
UPDATE public.groups
SET member_count = CASE id
  WHEN '10000000-0000-4000-8000-000000000001'::uuid THEN NULL
  WHEN '20000000-0000-4000-8000-000000000002'::uuid THEN 99
  ELSE -4
END;

-- Both duplicate sets are deployment races, not disposable rows.
INSERT INTO public.group_invites (
  id, group_id, token_hash, max_uses, used_count, expires_at
) VALUES
  ('41000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', repeat('a', 64), 2, 0, pg_catalog.clock_timestamp() + interval '1 day'),
  ('41000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', repeat('a', 64), 2, 0, pg_catalog.clock_timestamp() + interval '1 day');
INSERT INTO public.group_join_requests (
  id, group_id, user_id, status, decided_by, decided_at
) VALUES
  ('51000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'approved', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_catalog.clock_timestamp()),
  ('51000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'approved', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_catalog.clock_timestamp());
SQL

# Duplicate invite evidence must abort and survive the rolled-back migration.
if psql_cmd -f "$MIGRATION" >"$LOG_DIR/duplicate-invite.log" 2>&1; then
  echo "Migration unexpectedly deleted or accepted duplicate invite hashes" >&2
  exit 1
fi
grep -Fq 'duplicate group invite token hashes require explicit review' \
  "$LOG_DIR/duplicate-invite.log"
if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.group_invites WHERE token_hash = repeat('a', 64)")" != "2" ]]; then
  echo "Duplicate invite evidence changed after failed migration" >&2
  exit 1
fi
psql_cmd -c \
  "DELETE FROM public.group_invites WHERE id = '41000000-0000-4000-8000-000000000002'" \
  >/dev/null

# Duplicate active approvals must independently abort and survive.
if psql_cmd -f "$MIGRATION" >"$LOG_DIR/duplicate-request.log" 2>&1; then
  echo "Migration unexpectedly deleted or accepted duplicate active requests" >&2
  exit 1
fi
grep -Fq 'duplicate active group join requests require explicit review' \
  "$LOG_DIR/duplicate-request.log"
if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.group_join_requests WHERE user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'")" != "2" ]]; then
  echo "Duplicate join-request evidence changed after failed migration" >&2
  exit 1
fi
psql_cmd -c \
  "DELETE FROM public.group_join_requests WHERE id = '51000000-0000-4000-8000-000000000002'" \
  >/dev/null

# A same-name unique index on the wrong key is a decoy, not an idempotent hit.
psql_cmd -c \
  'CREATE UNIQUE INDEX group_invites_token_hash_unique ON public.group_invites(id)' \
  >/dev/null
if psql_cmd -f "$MIGRATION" >"$LOG_DIR/decoy-index.log" 2>&1; then
  echo "Migration unexpectedly accepted a same-name invite index decoy" >&2
  exit 1
fi
grep -Fq 'group_invites_token_hash_unique is a conflicting index' \
  "$LOG_DIR/decoy-index.log"
psql_cmd -c 'DROP INDEX public.group_invites_token_hash_unique' >/dev/null

psql_cmd -f "$MIGRATION" >"$LOG_DIR/first-apply.log"

# INSERT can never mint its own approved credential. A pending request may be
# approved only through a later state transition with decision evidence.
if psql_cmd -c \
  "INSERT INTO public.group_join_requests(id, group_id, user_id, status, decided_by, decided_at) VALUES ('52000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', '33333333-3333-4333-8333-333333333333', 'approved', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_catalog.clock_timestamp())" \
  >"$LOG_DIR/forged-approval.log" 2>&1; then
  echo "Join-request INSERT unexpectedly minted approved authority" >&2
  exit 1
fi
grep -Fq 'new group join requests must start pending' "$LOG_DIR/forged-approval.log"
psql_cmd <<'SQL'
INSERT INTO public.group_join_requests(id, group_id, user_id)
VALUES (
  '52000000-0000-4000-8000-000000000003',
  '20000000-0000-4000-8000-000000000002',
  '33333333-3333-4333-8333-333333333333'
);
UPDATE public.group_join_requests
SET status = 'approved',
    decided_by = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    decided_at = pg_catalog.clock_timestamp()
WHERE id = '52000000-0000-4000-8000-000000000003';
DELETE FROM public.group_join_requests
WHERE id = '52000000-0000-4000-8000-000000000003';
SQL

assert_status() {
  local expected="$1"
  local expression="$2"
  local actual
  actual="$(psql_cmd -Atqc "SET ROLE service_role; SELECT ($expression)->>'status'; RESET ROLE;")"
  if [[ "$actual" != "$expected" ]]; then
    echo "Expected membership status '$expected', got '$actual'" >&2
    exit 1
  fi
}

OPEN_GROUP="'10000000-0000-4000-8000-000000000001'::uuid"
APPLY_GROUP="'20000000-0000-4000-8000-000000000002'::uuid"
USER_B="'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid"
USER_C="'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid"

# Explicit booleans preserve nonmember join/leave state across later SELECTs.
assert_status joined "public.mutate_group_membership_atomic($USER_B, $OPEN_GROUP, 'join', false)"
assert_status already_member "public.mutate_group_membership_atomic($USER_B, $OPEN_GROUP, 'join', false)"
assert_status left "public.mutate_group_membership_atomic($USER_B, $OPEN_GROUP, 'leave', false)"
assert_status not_member "public.mutate_group_membership_atomic($USER_B, $OPEN_GROUP, 'leave', false)"
assert_status owner_forbidden \
  "public.mutate_group_membership_atomic('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', $OPEN_GROUP, 'leave', false)"

# Every join gate is evaluated inside the same locked transaction.
psql_cmd -c \
  "UPDATE public.groups SET min_arena_score = 60 WHERE id = $OPEN_GROUP" \
  >/dev/null
assert_status score_too_low \
  "public.mutate_group_membership_atomic($USER_B, $OPEN_GROUP, 'join', false)"
psql_cmd -c \
  "UPDATE public.groups SET min_arena_score = 0, is_verified_only = true WHERE id = $OPEN_GROUP; UPDATE public.user_profiles SET is_verified_trader = false WHERE id = $USER_B" \
  >/dev/null
assert_status verified_only \
  "public.mutate_group_membership_atomic($USER_B, $OPEN_GROUP, 'join', false)"
psql_cmd -c \
  "UPDATE public.groups SET is_verified_only = false, is_premium_only = true WHERE id = $OPEN_GROUP; UPDATE public.user_profiles SET is_verified_trader = true WHERE id = $USER_B" \
  >/dev/null
assert_status premium_required \
  "public.mutate_group_membership_atomic($USER_B, $OPEN_GROUP, 'join', false)"
assert_status joined \
  "public.mutate_group_membership_atomic($USER_B, $OPEN_GROUP, 'join', true)"
assert_status left "public.mutate_group_membership_atomic($USER_B, $OPEN_GROUP, 'leave', true)"
psql_cmd -c \
  "UPDATE public.groups SET is_premium_only = false WHERE id = $OPEN_GROUP; UPDATE public.user_profiles SET is_banned = true WHERE id = $USER_B" \
  >/dev/null
assert_status account_inactive \
  "public.mutate_group_membership_atomic($USER_B, $OPEN_GROUP, 'join', false)"
psql_cmd -c \
  "UPDATE public.user_profiles SET is_banned = false WHERE id = $USER_B; UPDATE public.groups SET dissolved_at = pg_catalog.clock_timestamp() WHERE id = '30000000-0000-4000-8000-000000000003'" \
  >/dev/null
assert_status dissolved \
  "public.mutate_group_membership_atomic($USER_B, '30000000-0000-4000-8000-000000000003'::uuid, 'join', false)"

assert_status approval_required \
  "public.mutate_group_membership_atomic($USER_C, $APPLY_GROUP, 'join', false)"

# The surviving approved request is consumed once; leaving cannot reuse it.
assert_status joined "public.mutate_group_membership_atomic($USER_B, $APPLY_GROUP, 'join', false)"
assert_status left "public.mutate_group_membership_atomic($USER_B, $APPLY_GROUP, 'leave', false)"
assert_status approval_required \
  "public.mutate_group_membership_atomic($USER_B, $APPLY_GROUP, 'join', false)"

# A valid invite is bound to its group and user redemption, and is not reusable.
assert_status joined \
  "public.redeem_group_invite_atomic($USER_C, $APPLY_GROUP, repeat('a', 64), false)"
assert_status invalid_invite \
  "public.redeem_group_invite_atomic($USER_B, $OPEN_GROUP, repeat('a', 64), false)"
assert_status left "public.mutate_group_membership_atomic($USER_C, $APPLY_GROUP, 'leave', false)"
assert_status invite_already_used \
  "public.redeem_group_invite_atomic($USER_C, $APPLY_GROUP, repeat('a', 64), false)"
assert_status invalid \
  "public.redeem_group_invite_atomic($USER_B, $APPLY_GROUP, 'not-a-hash', false)"

psql_cmd <<'SQL'
INSERT INTO public.group_invites (
  id, group_id, token_hash, max_uses, used_count, expires_at
) VALUES (
  '44000000-0000-4000-8000-000000000004',
  '20000000-0000-4000-8000-000000000002',
  repeat('e', 64),
  1,
  0,
  pg_catalog.clock_timestamp() - interval '1 second'
);
SQL
assert_status invalid_invite \
  "public.redeem_group_invite_atomic($USER_B, $APPLY_GROUP, repeat('e', 64), false)"

# An exception after membership/redemption inserts must roll the whole RPC back.
psql_cmd <<'SQL'
INSERT INTO public.group_invites (
  id, group_id, token_hash, max_uses, used_count, expires_at
) VALUES (
  '42000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000002',
  repeat('d', 64),
  1,
  0,
  pg_catalog.clock_timestamp() + interval '1 day'
);

CREATE OR REPLACE FUNCTION public.fail_selected_invite_update()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.token_hash = repeat('d', 64) THEN
    RAISE EXCEPTION 'injected invite update failure';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER trg_fail_selected_invite_update
  BEFORE UPDATE ON public.group_invites
  FOR EACH ROW EXECUTE FUNCTION public.fail_selected_invite_update();
SQL

if psql_cmd -c \
  "SET ROLE service_role; SELECT public.redeem_group_invite_atomic('22222222-2222-4222-8222-222222222222', '20000000-0000-4000-8000-000000000002', repeat('d', 64), false)" \
  >"$LOG_DIR/injected-failure.log" 2>&1; then
  echo "Injected invite failure unexpectedly committed" >&2
  exit 1
fi
grep -Fq 'injected invite update failure' "$LOG_DIR/injected-failure.log"
psql_cmd <<'SQL'
DO $rollback_proof$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = '20000000-0000-4000-8000-000000000002'
      AND user_id = '22222222-2222-4222-8222-222222222222'
  ) OR EXISTS (
    SELECT 1 FROM public.group_invite_redemptions
    WHERE invite_id = '42000000-0000-4000-8000-000000000002'
  ) OR (
    SELECT used_count FROM public.group_invites
    WHERE id = '42000000-0000-4000-8000-000000000002'
  ) <> 0 THEN
    RAISE EXCEPTION 'failed invite redemption left partial state';
  END IF;
END
$rollback_proof$;
DROP TRIGGER trg_fail_selected_invite_update ON public.group_invites;
DROP FUNCTION public.fail_selected_invite_update();
SQL

# max_uses=2 must admit exactly two of three concurrent users.
psql_cmd <<'SQL'
INSERT INTO public.group_invites (
  id, group_id, token_hash, max_uses, used_count, expires_at
) VALUES (
  '43000000-0000-4000-8000-000000000003',
  '20000000-0000-4000-8000-000000000002',
  repeat('c', 64),
  2,
  0,
  pg_catalog.clock_timestamp() + interval '1 day'
);
SQL

CONCURRENT_USERS=(
  dddddddd-dddd-4ddd-8ddd-dddddddddddd
  eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee
  ffffffff-ffff-4fff-8fff-ffffffffffff
)
pids=()
index=0
for user_id in "${CONCURRENT_USERS[@]}"; do
  index=$((index + 1))
  psql_cmd -Atqc \
    "SET ROLE service_role; SELECT (public.redeem_group_invite_atomic('$user_id', '20000000-0000-4000-8000-000000000002', repeat('c', 64), false))->>'status';" \
    >"$LOG_DIR/concurrent-$index.out" 2>&1 &
  pids+=("$!")
done
for pid in "${pids[@]}"; do
  wait "$pid"
done

psql_cmd <<'SQL'
DO $capacity_proof$
BEGIN
  IF (
    SELECT used_count FROM public.group_invites
    WHERE id = '43000000-0000-4000-8000-000000000003'
  ) <> 2 OR (
    SELECT pg_catalog.count(*) FROM public.group_invite_redemptions
    WHERE invite_id = '43000000-0000-4000-8000-000000000003'
  ) <> 2 OR (
    SELECT pg_catalog.count(*) FROM public.group_members
    WHERE group_id = '20000000-0000-4000-8000-000000000002'
      AND user_id IN (
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        'ffffffff-ffff-4fff-8fff-ffffffffffff'
      )
  ) <> 2 THEN
    RAISE EXCEPTION 'concurrent invite capacity was not exact';
  END IF;
END
$capacity_proof$;
SQL

joined_count="$(grep -h '^joined$' "$LOG_DIR"/concurrent-*.out | wc -l | tr -d ' ')"
invalid_count="$(grep -h '^invalid_invite$' "$LOG_DIR"/concurrent-*.out | wc -l | tr -d ' ')"
if [[ "$joined_count" != "2" ]] || [[ "$invalid_count" != "1" ]]; then
  echo "Concurrent invite statuses were not exactly two joined and one rejected" >&2
  exit 1
fi

# Two concurrent direct joins on one edge create exactly one membership.
for index in 1 2; do
  psql_cmd -Atqc \
    "SET ROLE service_role; SELECT (public.mutate_group_membership_atomic('22222222-2222-4222-8222-222222222222', '10000000-0000-4000-8000-000000000001', 'join', false))->>'status';" \
    >"$LOG_DIR/join-$index.out" 2>&1 &
  pids[$index]="$!"
done
wait "${pids[1]}"
wait "${pids[2]}"
joined_count="$(grep -h '^joined$' "$LOG_DIR"/join-*.out | wc -l | tr -d ' ')"
already_count="$(grep -h '^already_member$' "$LOG_DIR"/join-*.out | wc -l | tr -d ' ')"
if [[ "$joined_count" != "1" ]] || [[ "$already_count" != "1" ]]; then
  echo "Concurrent joins did not linearize to joined + already_member" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.group_members WHERE group_id = '10000000-0000-4000-8000-000000000001' AND user_id = '22222222-2222-4222-8222-222222222222'")" != "1" ]]; then
  echo "Concurrent joins created a duplicate membership" >&2
  exit 1
fi
assert_status left \
  "public.mutate_group_membership_atomic('22222222-2222-4222-8222-222222222222', $OPEN_GROUP, 'leave', false)"

# Ban insertion holds the shared edge lock. Join waits, then rechecks the now
# committed ban and fails closed without inserting membership.
PGAPPNAME=membership_ban_gate psql_cmd >"$LOG_DIR/ban-gate.out" 2>&1 <<'SQL' &
BEGIN;
INSERT INTO public.group_bans(group_id, user_id, banned_by)
VALUES (
  '10000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
);
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
BAN_PID=$!

gate_ready=false
for _ in {1..100}; do
  if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE application_name = 'membership_ban_gate' AND state = 'active' AND query LIKE '%pg_sleep%'")" == "1" ]]; then
    gate_ready=true
    break
  fi
  sleep 0.05
done
if [[ "$gate_ready" != true ]]; then
  echo "Ban concurrency gate did not become ready" >&2
  exit 1
fi
assert_status banned \
  "public.mutate_group_membership_atomic('11111111-1111-4111-8111-111111111111', $OPEN_GROUP, 'join', false)"
wait "$BAN_PID"

# Two concurrent leave calls delete once and decrement once.
assert_status joined \
  "public.mutate_group_membership_atomic('33333333-3333-4333-8333-333333333333', $OPEN_GROUP, 'join', false)"
for index in 1 2; do
  psql_cmd -Atqc \
    "SET ROLE service_role; SELECT (public.mutate_group_membership_atomic('33333333-3333-4333-8333-333333333333', '10000000-0000-4000-8000-000000000001', 'leave', false))->>'status';" \
    >"$LOG_DIR/leave-$index.out" 2>&1 &
  pids[$index]="$!"
done
wait "${pids[1]}"
wait "${pids[2]}"
left_count="$(grep -h '^left$' "$LOG_DIR"/leave-*.out | wc -l | tr -d ' ')"
not_member_count="$(grep -h '^not_member$' "$LOG_DIR"/leave-*.out | wc -l | tr -d ' ')"
if [[ "$left_count" != "1" ]] || [[ "$not_member_count" != "1" ]]; then
  echo "Concurrent leaves did not linearize to left + not_member" >&2
  exit 1
fi

# Inject table/column/policy/function ACL drift before replay. The migration must
# converge arbitrary grantees, not merely the three named API roles.
psql_cmd <<'SQL'
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.group_invite_redemptions
  TO drifted_member_writer;
GRANT SELECT (invite_id), UPDATE (redeemed_at)
  ON public.group_invite_redemptions
  TO drifted_member_writer;
CREATE POLICY unexpected_redemption_reader
  ON public.group_invite_redemptions
  FOR SELECT
  TO drifted_member_writer
  USING (true);
GRANT EXECUTE ON FUNCTION public.mutate_group_membership_atomic(
  uuid, uuid, text, boolean
) TO drifted_member_writer;
GRANT EXECUTE ON FUNCTION public.redeem_group_invite_atomic(
  uuid, uuid, text, boolean
) TO drifted_member_writer;
SQL

# Replay after real evidence exists and verify the exact catalog/data boundary.
psql_cmd -f "$MIGRATION" >"$LOG_DIR/replay.log"

psql_cmd <<'SQL'
DO $catalog_and_data_contract$
DECLARE
  rpc_signature regprocedure;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.groups AS target_group
    WHERE target_group.member_count <> (
      SELECT pg_catalog.count(*)::integer
      FROM public.group_members AS member
      WHERE member.group_id = target_group.id
    )
  ) THEN
    RAISE EXCEPTION 'member count differs from canonical membership rows';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_info
    JOIN pg_catalog.pg_proc AS function_info ON function_info.oid = trigger_info.tgfoid
    WHERE trigger_info.tgrelid = 'public.group_members'::regclass
      AND NOT trigger_info.tgisinternal
      AND function_info.proname IN ('sync_group_member_count', 'update_group_member_count')
  ) <> 1 OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.group_members'::regclass
      AND tgname = 'trg_log_group_join_activity'
  ) THEN
    RAISE EXCEPTION 'counter convergence removed or duplicated unrelated triggers';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(function_info.proacl, pg_catalog.acldefault('f', function_info.proowner))
    ) AS acl
    WHERE function_info.pronamespace = 'public'::regnamespace
      AND function_info.proname IN ('increment_member_count', 'decrement_member_count')
      AND acl.privilege_type = 'EXECUTE'
      AND acl.grantee <> function_info.proowner
  ) THEN
    RAISE EXCEPTION 'legacy counter remains callable by a nonowner';
  END IF;

  FOREACH rpc_signature IN ARRAY ARRAY[
    'public.mutate_group_membership_atomic(uuid,uuid,text,boolean)'::regprocedure,
    'public.redeem_group_invite_atomic(uuid,uuid,text,boolean)'::regprocedure
  ]
  LOOP
    IF NOT pg_catalog.has_function_privilege('service_role', rpc_signature, 'EXECUTE')
      OR pg_catalog.has_function_privilege('anon', rpc_signature, 'EXECUTE')
      OR pg_catalog.has_function_privilege('authenticated', rpc_signature, 'EXECUTE')
      OR pg_catalog.has_function_privilege('drifted_member_writer', rpc_signature, 'EXECUTE')
      OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc AS function_info
        WHERE function_info.oid = rpc_signature
          AND function_info.prosecdef
          AND pg_catalog.pg_get_userbyid(function_info.proowner) = 'postgres'
          AND function_info.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
      )
    THEN
      RAISE EXCEPTION 'atomic RPC security contract drifted: %', rpc_signature;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM public.group_join_requests
    WHERE id = '51000000-0000-4000-8000-000000000001'
      AND status = 'joined'
      AND consumed_at IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = '10000000-0000-4000-8000-000000000001'
      AND user_id = '11111111-1111-4111-8111-111111111111'
  ) THEN
    RAISE EXCEPTION 'approval consumption or ban fail-closed state drifted';
  END IF;

  IF pg_catalog.has_table_privilege(
    'service_role', 'public.group_invite_redemptions',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) THEN
    RAISE EXCEPTION 'redemption evidence table became directly writable';
  END IF;

  IF pg_catalog.has_table_privilege(
    'drifted_member_writer', 'public.group_invite_redemptions',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR pg_catalog.has_any_column_privilege(
    'drifted_member_writer', 'public.group_invite_redemptions',
    'SELECT,INSERT,UPDATE,REFERENCES'
  ) OR (
    SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.group_invite_redemptions'::regclass
  ) <> 1 THEN
    RAISE EXCEPTION 'arbitrary redemption ACL/policy drift survived replay';
  END IF;
END
$catalog_and_data_contract$;
SQL

echo "atomic group membership PG17 integration proof passed"
