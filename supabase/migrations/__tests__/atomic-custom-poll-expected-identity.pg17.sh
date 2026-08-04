#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260803100000_atomic_custom_poll_expected_identity.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
TMP_ROOT="$(mktemp -d /tmp/arena-custom-poll-expected.XXXXXX)"
PG_DATA="$TMP_ROOT/data"
PG_SOCKET="$TMP_ROOT/socket"
PG_PORT="$((43000 + RANDOM % 14000))"

cleanup() {
  "$PG_BIN/pg_ctl" -D "$PG_DATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

if [[ ! -x "$PG_BIN/postgres" ]] || ! "$PG_BIN/postgres" --version | grep -q 'PostgreSQL) 17\.'; then
  echo "PostgreSQL 17 is required; set PG17_BIN to its bin directory" >&2
  exit 1
fi

mkdir -p "$PG_SOCKET"
"$PG_BIN/initdb" -D "$PG_DATA" -A trust -U postgres >/dev/null
if ! "$PG_BIN/pg_ctl" -D "$PG_DATA" \
  -l "$TMP_ROOT/postgres.log" \
  -o "-F -p $PG_PORT -k $PG_SOCKET -c listen_addresses=''" \
  -w start >/dev/null; then
  cat "$TMP_ROOT/postgres.log" >&2
  exit 1
fi

psql_cmd() {
  "$PG_BIN/psql" \
    -X \
    -v ON_ERROR_STOP=1 \
    -h "$PG_SOCKET" \
    -p "$PG_PORT" \
    -U postgres \
    -d postgres \
    "$@"
}

wait_for_file() {
  local marker="$1"
  for _attempt in $(seq 1 100); do
    [[ -f "$marker" ]] && return 0
    sleep 0.05
  done
  echo "Timed out waiting for PostgreSQL concurrency marker: $marker" >&2
  exit 1
}

psql_cmd >/dev/null <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE authenticator NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE rogue_poll_writer NOLOGIN;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')
$function$;

CREATE TABLE public.posts (
  id uuid PRIMARY KEY,
  author_id uuid NOT NULL,
  poll_id uuid
);
CREATE TABLE public.polls (
  id uuid PRIMARY KEY,
  post_id uuid,
  question text NOT NULL,
  options jsonb NOT NULL,
  type text,
  end_at timestamptz,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz
);
CREATE UNIQUE INDEX polls_one_custom_per_post_idx
  ON public.polls (post_id)
  WHERE post_id IS NOT NULL;
CREATE TABLE public.poll_votes (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  poll_id uuid NOT NULL,
  user_id uuid NOT NULL,
  option_index integer NOT NULL,
  UNIQUE (poll_id, user_id, option_index)
);

CREATE FUNCTION public.lock_actor_can_interact_with_post(
  p_post_id uuid,
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF p_actor_id IS NULL THEN
    RETURN false;
  END IF;
  PERFORM 1
  FROM public.posts AS target
  WHERE target.id = p_post_id
  FOR SHARE;
  RETURN FOUND;
END
$function$;

CREATE FUNCTION public.cast_post_poll_vote_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_option_indexes integer[]
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_poll_id uuid;
  v_options jsonb;
  v_updated_options jsonb;
  v_poll_type text;
  v_end_at timestamptz;
  v_options_count integer;
  v_total_votes bigint;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;
  IF p_actor_id IS NULL
     OR p_post_id IS NULL
     OR COALESCE(pg_catalog.array_length(p_option_indexes, 1), 0) = 0
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;
  IF NOT public.lock_actor_can_interact_with_post(p_post_id, p_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT poll.id, poll.options, poll.type, poll.end_at
  INTO v_poll_id, v_options, v_poll_type, v_end_at
  FROM public.polls AS poll
  WHERE poll.post_id = p_post_id
  ORDER BY poll.created_at, poll.id
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF v_end_at IS NOT NULL AND v_end_at <= pg_catalog.statement_timestamp() THEN
    RETURN pg_catalog.jsonb_build_object('status', 'ended');
  END IF;

  v_options_count := pg_catalog.jsonb_array_length(v_options);
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(p_option_indexes) AS requested(option_index)
    WHERE requested.option_index < 0
      OR requested.option_index >= v_options_count
  ) OR (
    v_poll_type = 'single'
    AND pg_catalog.array_length(p_option_indexes, 1) <> 1
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  DELETE FROM public.poll_votes AS existing_vote
  WHERE existing_vote.poll_id = v_poll_id
    AND existing_vote.user_id = p_actor_id;

  INSERT INTO public.poll_votes (poll_id, user_id, option_index)
  SELECT v_poll_id, p_actor_id, requested.option_index
  FROM pg_catalog.unnest(p_option_indexes) AS requested(option_index);

  SELECT pg_catalog.jsonb_agg(
    pg_catalog.jsonb_set(
      option_row.option_value,
      '{votes}',
      pg_catalog.to_jsonb(COALESCE(vote_count.total, 0)),
      true
    )
    ORDER BY option_row.ordinality
  )
  INTO v_updated_options
  FROM pg_catalog.jsonb_array_elements(v_options)
    WITH ORDINALITY AS option_row(option_value, ordinality)
  LEFT JOIN (
    SELECT vote.option_index, pg_catalog.count(*) AS total
    FROM public.poll_votes AS vote
    WHERE vote.poll_id = v_poll_id
    GROUP BY vote.option_index
  ) AS vote_count
    ON vote_count.option_index = option_row.ordinality - 1;

  SELECT pg_catalog.count(*)
  INTO v_total_votes
  FROM public.poll_votes AS vote
  WHERE vote.poll_id = v_poll_id;

  UPDATE public.polls
  SET options = v_updated_options,
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = v_poll_id;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'voted',
    'poll_id', v_poll_id,
    'options', v_updated_options,
    'total_votes', v_total_votes,
    'user_votes', pg_catalog.to_jsonb(p_option_indexes)
  );
END
$function$;

REVOKE ALL ON FUNCTION public.lock_actor_can_interact_with_post(uuid, uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.cast_post_poll_vote_atomic(uuid, uuid, integer[])
  FROM PUBLIC, anon, authenticated, authenticator;
GRANT EXECUTE ON FUNCTION public.cast_post_poll_vote_atomic(uuid, uuid, integer[])
  TO service_role;
GRANT SELECT ON TABLE public.poll_votes TO service_role;

INSERT INTO public.posts (id, author_id, poll_id)
VALUES (
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000099',
  '20000000-0000-4000-8000-000000000001'
);
INSERT INTO public.polls (id, post_id, question, options, type)
VALUES
  (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'Current poll',
    '[{"text":"Up","votes":0,"index":0},{"text":"Down","votes":0,"index":1}]'::jsonb,
    'single'
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    NULL,
    'Replacement poll',
    '[{"text":"Yes","votes":0,"index":0},{"text":"No","votes":0,"index":1}]'::jsonb,
    'single'
  );
SQL

psql_cmd <"$MIGRATION" >/dev/null

# exact expected poll vote
psql_cmd >/dev/null <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $exact_expected_poll_vote$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.cast_post_poll_vote_expected_atomic(
    '30000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    ARRAY[1]
  );
  IF v_result ->> 'status' <> 'voted'
     OR v_result ->> 'poll_id' <> '20000000-0000-4000-8000-000000000001'
     OR (v_result ->> 'total_votes')::integer <> 1
  THEN
    RAISE EXCEPTION 'exact expected poll vote failed: %', v_result;
  END IF;
END
$exact_expected_poll_vote$;
RESET ROLE;
SQL

# stale expected poll rejects before mutation
psql_cmd >/dev/null <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $stale_expected_poll$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_result jsonb;
BEGIN
  SELECT pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'poll_id', vote.poll_id,
      'user_id', vote.user_id,
      'option_index', vote.option_index
    ) ORDER BY vote.poll_id, vote.user_id, vote.option_index
  )
  INTO v_before
  FROM public.poll_votes AS vote;

  v_result := public.cast_post_poll_vote_expected_atomic(
    '30000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    ARRAY[0]
  );

  SELECT pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'poll_id', vote.poll_id,
      'user_id', vote.user_id,
      'option_index', vote.option_index
    ) ORDER BY vote.poll_id, vote.user_id, vote.option_index
  )
  INTO v_after
  FROM public.poll_votes AS vote;

  IF v_result <> '{"status":"poll_changed"}'::jsonb
     OR v_after IS DISTINCT FROM v_before
  THEN
    RAISE EXCEPTION 'stale expected poll mutated votes: %, %, %',
      v_result, v_before, v_after;
  END IF;
END
$stale_expected_poll$;
RESET ROLE;
SQL

# poll switch first returns poll_changed
psql_cmd >"$TMP_ROOT/switch-first.log" 2>&1 <<SQL &
BEGIN;
UPDATE public.posts
SET poll_id = '20000000-0000-4000-8000-000000000002'
WHERE id = '10000000-0000-4000-8000-000000000001';
UPDATE public.polls
SET post_id = NULL
WHERE id = '20000000-0000-4000-8000-000000000001';
UPDATE public.polls
SET post_id = '10000000-0000-4000-8000-000000000001'
WHERE id = '20000000-0000-4000-8000-000000000002';
\! touch "$TMP_ROOT/switch-first.locked"
SELECT pg_catalog.pg_sleep(1.5);
COMMIT;
SQL
switch_pid=$!
wait_for_file "$TMP_ROOT/switch-first.locked"

switch_result="$(psql_cmd -Atq <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.cast_post_poll_vote_expected_atomic(
  '30000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  ARRAY[0]
) ->> 'status';
SQL
)"
wait "$switch_pid"
if [[ "$switch_result" != "service_role"$'\n'"poll_changed" && "$switch_result" != "poll_changed" ]]; then
  echo "poll switch first did not return poll_changed: $switch_result" >&2
  exit 1
fi
psql_cmd -Atqc "SELECT count(*) FROM public.poll_votes WHERE poll_id='20000000-0000-4000-8000-000000000002'" | grep -qx '0'
psql_cmd -Atqc "SELECT option_index FROM public.poll_votes WHERE poll_id='20000000-0000-4000-8000-000000000001'" | grep -qx '1'

# vote first serializes poll switch
psql_cmd >"$TMP_ROOT/vote-first.log" 2>&1 <<SQL &
BEGIN;
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.cast_post_poll_vote_expected_atomic(
  '30000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  ARRAY[0]
) ->> 'status';
\! touch "$TMP_ROOT/vote-first.locked"
SELECT pg_catalog.pg_sleep(1.5);
COMMIT;
SQL
vote_pid=$!
wait_for_file "$TMP_ROOT/vote-first.locked"

psql_cmd >"$TMP_ROOT/switch-after-vote.log" 2>&1 <<SQL &
BEGIN;
UPDATE public.posts
SET poll_id = '20000000-0000-4000-8000-000000000001'
WHERE id = '10000000-0000-4000-8000-000000000001';
UPDATE public.polls
SET post_id = NULL
WHERE id = '20000000-0000-4000-8000-000000000002';
UPDATE public.polls
SET post_id = '10000000-0000-4000-8000-000000000001'
WHERE id = '20000000-0000-4000-8000-000000000001';
COMMIT;
\! touch "$TMP_ROOT/switch-after-vote.finished"
SQL

switch_after_vote_pid=$!
sleep 0.2
if [[ -f "$TMP_ROOT/switch-after-vote.finished" ]]; then
  echo "poll switch did not wait for the vote transaction" >&2
  exit 1
fi
wait "$vote_pid"
wait "$switch_after_vote_pid"
[[ -f "$TMP_ROOT/switch-after-vote.finished" ]]
grep -q 'voted' "$TMP_ROOT/vote-first.log"
psql_cmd -Atqc "SELECT option_index FROM public.poll_votes WHERE poll_id='20000000-0000-4000-8000-000000000002'" | grep -qx '0'

# service-only expected poll RPC ACL
psql_cmd >/dev/null <<'SQL'
DO $acl_contract$
DECLARE
  v_function regprocedure :=
    'public.cast_post_poll_vote_expected_atomic(uuid,uuid,uuid,integer[])'::regprocedure;
BEGIN
  IF NOT pg_catalog.has_function_privilege('service_role', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticator', v_function, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'service-only expected poll RPC ACL drifted';
  END IF;
END
$acl_contract$;
SQL

# expected poll identity migration replay
vote_snapshot="$(psql_cmd -Atqc "SELECT pg_catalog.md5(COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(vote) ORDER BY vote.poll_id, vote.user_id, vote.option_index)::text, 'null')) FROM public.poll_votes AS vote")"
psql_cmd -c "GRANT EXECUTE ON FUNCTION public.cast_post_poll_vote_expected_atomic(uuid,uuid,uuid,integer[]) TO rogue_poll_writer" >/dev/null
psql_cmd <"$MIGRATION" >/dev/null
replayed_snapshot="$(psql_cmd -Atqc "SELECT pg_catalog.md5(COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(vote) ORDER BY vote.poll_id, vote.user_id, vote.option_index)::text, 'null')) FROM public.poll_votes AS vote")"
[[ "$vote_snapshot" == "$replayed_snapshot" ]]
psql_cmd -Atqc "SELECT pg_catalog.has_function_privilege('rogue_poll_writer','public.cast_post_poll_vote_expected_atomic(uuid,uuid,uuid,integer[])','EXECUTE')" | grep -qx 'f'

echo "atomic custom poll expected identity PostgreSQL 17 proof passed"
