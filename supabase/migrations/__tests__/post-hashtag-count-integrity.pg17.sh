#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729186000_post_hashtag_count_integrity.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
TMP_ROOT="$(mktemp -d /tmp/post-hashtag-count-pg17.XXXXXX)"
PGDATA="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
PORT="$((56500 + ($$ % 700)))"

cleanup() {
  if [[ -d "$PGDATA" ]]; then
    "$PG_BIN/pg_ctl" -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

if [[ ! -x "$PG_BIN/initdb" || ! -x "$PG_BIN/pg_ctl" || ! -x "$PG_BIN/psql" ]]; then
  echo "PostgreSQL 17 binaries not found at $PG_BIN" >&2
  exit 1
fi

mkdir -p "$SOCKET_DIR"
"$PG_BIN/initdb" -D "$PGDATA" --auth=trust --username=postgres --no-locale --encoding=UTF8 >/dev/null
"$PG_BIN/pg_ctl" -D "$PGDATA" -o "-F -k $SOCKET_DIR -p $PORT" -w start >/dev/null

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -q -h "$SOCKET_DIR" -p "$PORT" -U postgres postgres "$@"
}

psql_cmd <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE authenticator NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

CREATE TABLE public.posts (
  id uuid PRIMARY KEY,
  title text NOT NULL
);
CREATE TABLE public.hashtags (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tag text NOT NULL UNIQUE,
  post_count integer DEFAULT 0
);
CREATE TABLE public.post_hashtags (
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  hashtag_id uuid NOT NULL REFERENCES public.hashtags(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, hashtag_id)
);

ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.hashtags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hashtags FORCE ROW LEVEL SECURITY;
ALTER TABLE public.post_hashtags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_hashtags FORCE ROW LEVEL SECURITY;

CREATE POLICY browser_read_posts ON public.posts
  FOR SELECT TO anon, authenticated, authenticator USING (true);
CREATE POLICY browser_read_hashtags ON public.hashtags
  FOR SELECT TO anon, authenticated, authenticator USING (true);
CREATE POLICY browser_read_post_hashtags ON public.post_hashtags
  FOR SELECT TO anon, authenticated, authenticator USING (true);

GRANT USAGE ON SCHEMA public
  TO anon, authenticated, authenticator, service_role;
GRANT SELECT ON TABLE public.posts, public.hashtags, public.post_hashtags
  TO anon, authenticated, authenticator, service_role;
GRANT INSERT, UPDATE, DELETE
  ON TABLE public.posts, public.hashtags, public.post_hashtags
  TO service_role;

CREATE OR REPLACE FUNCTION public.recount_hashtag_posts(hashtag_ids uuid[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $function$
  UPDATE hashtags AS hashtag
  SET post_count = source_rows.post_count
  FROM (
    SELECT post_hashtag.hashtag_id, pg_catalog.count(*)::integer AS post_count
    FROM post_hashtags AS post_hashtag
    WHERE post_hashtag.hashtag_id = ANY(hashtag_ids)
    GROUP BY post_hashtag.hashtag_id
  ) AS source_rows
  WHERE hashtag.id = source_rows.hashtag_id;
$function$;
ALTER FUNCTION public.recount_hashtag_posts(uuid[]) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.recount_hashtag_posts(uuid[]) TO service_role;

INSERT INTO public.posts (id, title) VALUES
  ('10000000-0000-4000-8000-000000000001', 'historical one'),
  ('10000000-0000-4000-8000-000000000002', 'historical two'),
  ('10000000-0000-4000-8000-000000000003', 'race one'),
  ('10000000-0000-4000-8000-000000000004', 'race two'),
  ('10000000-0000-4000-8000-000000000005', 'rollback'),
  ('10000000-0000-4000-8000-000000000006', 'batch one'),
  ('10000000-0000-4000-8000-000000000007', 'batch two'),
  ('10000000-0000-4000-8000-000000000008', 'batch three'),
  ('10000000-0000-4000-8000-000000000009', 'move one'),
  ('10000000-0000-4000-8000-000000000010', 'move two');

INSERT INTO public.hashtags (id, tag, post_count) VALUES
  ('20000000-0000-4000-8000-000000000001', 'historical', 99),
  ('20000000-0000-4000-8000-000000000002', 'null-drift', NULL),
  ('20000000-0000-4000-8000-000000000003', 'negative-drift', -7),
  ('20000000-0000-4000-8000-000000000004', 'race', 0),
  ('20000000-0000-4000-8000-000000000005', 'batch', 0),
  ('20000000-0000-4000-8000-000000000006', 'move-a', 0),
  ('20000000-0000-4000-8000-000000000007', 'move-b', 0);

INSERT INTO public.post_hashtags (post_id, hashtag_id) VALUES
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001');

-- Prove the migration refuses to put a privileged trigger over a browser-
-- writable source and rolls back before repairing historical drift.
GRANT INSERT ON TABLE public.post_hashtags TO authenticated;
SQL

if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/browser-dml.out" 2>"$TMP_ROOT/browser-dml.err"; then
  echo 'browser-writable association unexpectedly migrated' >&2
  exit 1
fi
grep -q 'browser post/hashtag DML closure must deploy first' "$TMP_ROOT/browser-dml.err"
[[ "$(psql_cmd -At -c "SELECT post_count FROM public.hashtags WHERE tag = 'historical'")" == '99' ]]
psql_cmd -c 'REVOKE INSERT ON TABLE public.post_hashtags FROM authenticated'
echo 'browser DML closure preflight rollback'

psql_cmd -f "$MIGRATION"

[[ "$(psql_cmd -At -F ':' -c "SELECT tag, post_count FROM public.hashtags ORDER BY tag")" == $'batch:0\nhistorical:2\nmove-a:0\nmove-b:0\nnegative-drift:0\nnull-drift:0\nrace:0' ]]
[[ "$(psql_cmd -At -c 'SELECT count(*) FROM public.hashtags')" == '7' ]]
echo 'historical hashtag count drift repaired'

psql_cmd <<'SQL'
DO $proof$
DECLARE
  v_trigger_function regprocedure :=
    'public.maintain_post_hashtag_count()'::regprocedure;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.hashtags'::regclass
      AND attribute.attname = 'post_count'
      AND attribute.attnotnull
      AND pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) = '0'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.hashtags'::regclass
      AND constraint_row.conname = 'hashtags_post_count_nonnegative'
      AND constraint_row.convalidated
  ) THEN
    RAISE EXCEPTION 'post count cache domain is not hardened';
  END IF;

  IF pg_catalog.has_function_privilege(
       'service_role',
       v_trigger_function,
       'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'authenticated',
       v_trigger_function,
       'EXECUTE'
     ) OR (
       SELECT function_row.proowner
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = v_trigger_function
     ) <> 'postgres'::regrole
  THEN
    RAISE EXCEPTION 'trigger function authority is exposed';
  END IF;
END
$proof$;
SQL

if psql_cmd -c "UPDATE public.hashtags SET post_count = -1 WHERE tag = 'historical'" \
  >"$TMP_ROOT/negative.out" 2>"$TMP_ROOT/negative.err"; then
  echo 'negative post count unexpectedly accepted' >&2
  exit 1
fi
grep -q 'hashtags_post_count_nonnegative' "$TMP_ROOT/negative.err"
echo 'post count cache domain hardened'

if psql_cmd >"$TMP_ROOT/direct-trigger.out" 2>"$TMP_ROOT/direct-trigger.err" <<'SQL'
SET ROLE service_role;
SELECT public.maintain_post_hashtag_count();
SQL
then
  echo 'service role directly executed trigger function' >&2
  exit 1
fi
grep -qi 'permission denied' "$TMP_ROOT/direct-trigger.err"
echo 'trigger authority sealed'

# The first transaction holds the hashtag row after applying +1. The second
# insert must wait and then apply its own +1, never overwrite a stale recount.
psql_cmd >"$TMP_ROOT/race-a.out" 2>"$TMP_ROOT/race-a.err" <<'SQL' &
BEGIN;
SET LOCAL lock_timeout = '5s';
INSERT INTO public.post_hashtags (post_id, hashtag_id) VALUES
  ('10000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000004');
SELECT pg_catalog.pg_sleep(0.6);
COMMIT;
SQL
race_a_pid=$!
sleep 0.1
psql_cmd >"$TMP_ROOT/race-b.out" 2>"$TMP_ROOT/race-b.err" <<'SQL' &
BEGIN;
SET LOCAL lock_timeout = '5s';
INSERT INTO public.post_hashtags (post_id, hashtag_id) VALUES
  ('10000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000004');
COMMIT;
SQL
race_b_pid=$!
wait "$race_a_pid"
wait "$race_b_pid"
[[ "$(psql_cmd -At -c "SELECT post_count FROM public.hashtags WHERE tag = 'race'")" == '2' ]]
echo 'concurrent same hashtag inserts retained'

# A service recount locks the parent before reading associations. A concurrent
# insert therefore applies after the recount instead of being overwritten by
# its snapshot; remove the proof edge afterward to restore the duplicate case.
psql_cmd >"$TMP_ROOT/recount.out" 2>"$TMP_ROOT/recount.err" <<'SQL' &
BEGIN;
SET LOCAL lock_timeout = '5s';
SET ROLE service_role;
SELECT public.recount_hashtag_posts(
  ARRAY['20000000-0000-4000-8000-000000000004'::uuid]
);
SELECT pg_catalog.pg_sleep(0.6);
COMMIT;
SQL
recount_pid=$!
sleep 0.1
psql_cmd -c "INSERT INTO public.post_hashtags (post_id, hashtag_id) VALUES ('10000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000004')"
wait "$recount_pid"
[[ "$(psql_cmd -At -c "SELECT post_count FROM public.hashtags WHERE tag = 'race'")" == '3' ]]
psql_cmd -c "DELETE FROM public.post_hashtags WHERE post_id = '10000000-0000-4000-8000-000000000005' AND hashtag_id = '20000000-0000-4000-8000-000000000004'"
[[ "$(psql_cmd -At -c "SELECT post_count FROM public.hashtags WHERE tag = 'race'")" == '2' ]]
echo 'locked recount retained concurrent delta'

psql_cmd <<'SQL'
INSERT INTO public.post_hashtags (post_id, hashtag_id) VALUES
  ('10000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000004')
ON CONFLICT (post_id, hashtag_id) DO NOTHING;
SQL
if psql_cmd -c "INSERT INTO public.post_hashtags (post_id, hashtag_id) VALUES ('10000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000004')" \
  >"$TMP_ROOT/duplicate.out" 2>"$TMP_ROOT/duplicate.err"; then
  echo 'duplicate association unexpectedly inserted' >&2
  exit 1
fi
grep -qi 'duplicate key' "$TMP_ROOT/duplicate.err"
[[ "$(psql_cmd -At -c "SELECT post_count FROM public.hashtags WHERE tag = 'race'")" == '2' ]]
echo 'duplicate association did not double count'

psql_cmd <<'SQL'
BEGIN;
INSERT INTO public.post_hashtags (post_id, hashtag_id) VALUES
  ('10000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000004');
ROLLBACK;
SQL
[[ "$(psql_cmd -At -c "SELECT post_count FROM public.hashtags WHERE tag = 'race'")" == '2' ]]
[[ "$(psql_cmd -At -c "SELECT count(*) FROM public.post_hashtags WHERE post_id = '10000000-0000-4000-8000-000000000005'")" == '0' ]]
echo 'association rollback restored count'

psql_cmd <<'SQL'
INSERT INTO public.post_hashtags (post_id, hashtag_id) VALUES
  ('10000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000005'),
  ('10000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000005'),
  ('10000000-0000-4000-8000-000000000008', '20000000-0000-4000-8000-000000000005');
DELETE FROM public.post_hashtags
WHERE post_id IN (
  '10000000-0000-4000-8000-000000000006',
  '10000000-0000-4000-8000-000000000007'
);
SQL
[[ "$(psql_cmd -At -c "SELECT post_count FROM public.hashtags WHERE tag = 'batch'")" == '1' ]]
echo 'batch association deltas retained'

psql_cmd -c "DELETE FROM public.posts WHERE id = '10000000-0000-4000-8000-000000000008'"
[[ "$(psql_cmd -At -c "SELECT post_count FROM public.hashtags WHERE tag = 'batch'")" == '0' ]]
[[ "$(psql_cmd -At -c "SELECT count(*) FROM public.hashtags WHERE tag = 'batch'")" == '1' ]]
echo 'post cascade decrement retained hashtag'

psql_cmd <<'SQL'
INSERT INTO public.post_hashtags (post_id, hashtag_id) VALUES
  ('10000000-0000-4000-8000-000000000009', '20000000-0000-4000-8000-000000000006'),
  ('10000000-0000-4000-8000-000000000010', '20000000-0000-4000-8000-000000000007');
SQL

psql_cmd >"$TMP_ROOT/move-a.out" 2>"$TMP_ROOT/move-a.err" <<'SQL' &
BEGIN;
SET LOCAL lock_timeout = '5s';
UPDATE public.post_hashtags
SET hashtag_id = '20000000-0000-4000-8000-000000000007'
WHERE post_id = '10000000-0000-4000-8000-000000000009';
SELECT pg_catalog.pg_sleep(0.6);
COMMIT;
SQL
move_a_pid=$!
sleep 0.1
psql_cmd >"$TMP_ROOT/move-b.out" 2>"$TMP_ROOT/move-b.err" <<'SQL' &
BEGIN;
SET LOCAL lock_timeout = '5s';
UPDATE public.post_hashtags
SET hashtag_id = '20000000-0000-4000-8000-000000000006'
WHERE post_id = '10000000-0000-4000-8000-000000000010';
COMMIT;
SQL
move_b_pid=$!
wait "$move_a_pid"
wait "$move_b_pid"
[[ "$(psql_cmd -At -F ':' -c "SELECT tag, post_count FROM public.hashtags WHERE tag IN ('move-a', 'move-b') ORDER BY tag")" == $'move-a:1\nmove-b:1' ]]
echo 'opposite association moves completed without deadlock'

# Replay must repair drift, remove any trigger aliases, and leave exactly one
# delta edge. The next insert therefore increments race exactly once.
psql_cmd -c "UPDATE public.hashtags SET post_count = 77 WHERE tag = 'race'"
psql_cmd -f "$MIGRATION"
[[ "$(psql_cmd -At -c "SELECT post_count FROM public.hashtags WHERE tag = 'race'")" == '2' ]]
[[ "$(psql_cmd -At -c "SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid = 'public.post_hashtags'::regclass AND tgfoid = 'public.maintain_post_hashtag_count()'::regprocedure AND NOT tgisinternal")" == '1' ]]
psql_cmd -c "INSERT INTO public.post_hashtags (post_id, hashtag_id) VALUES ('10000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000004')"
[[ "$(psql_cmd -At -c "SELECT post_count FROM public.hashtags WHERE tag = 'race'")" == '3' ]]
echo 'migration replay repaired drift exactly once'

echo 'post hashtag count integrity PostgreSQL 17 proof passed'
