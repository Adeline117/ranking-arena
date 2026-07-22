#!/usr/bin/env bash

set -Eeuo pipefail

SOCKET_DIR="${1:?socket directory is required}"
PORT="${2:?port is required}"
PG_BIN="${3:?PostgreSQL bin directory is required}"
TMP_DIR="$(mktemp -d /tmp/tip-checkout-lifecycle-concurrency.XXXXXX)"

psql_cmd() {
  "$PG_BIN/psql" \
    -X \
    -v ON_ERROR_STOP=1 \
    -v VERBOSITY=verbose \
    -h "$SOCKET_DIR" \
    -p "$PORT" \
    -d postgres \
    "$@"
}

cleanup() {
  psql_cmd -qAtc "
    DROP TRIGGER IF EXISTS trg_tips_zz_checkout_concurrency_sleep
      ON public.tips;
    DROP FUNCTION IF EXISTS public.sleep_tip_checkout_concurrency();
  " >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

wait_for_sleep() {
  local marker="$1"
  local count
  for _attempt in {1..150}; do
    count="$(psql_cmd -qAtc "
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_stat_activity AS activity
      WHERE pg_catalog.strpos(activity.query, '$marker') > 0
        AND activity.wait_event_type = 'Timeout'
        AND activity.wait_event = 'PgSleep';
    ")"
    if [[ "$count" -ge 1 ]]; then
      return 0
    fi
    sleep 0.02
  done
  echo "$marker never reached the deterministic sleep point" >&2
  psql_cmd -x -c "
    SELECT pid, state, wait_event_type, wait_event, query
    FROM pg_catalog.pg_stat_activity
    WHERE datname = pg_catalog.current_database()
      AND pid <> pg_catalog.pg_backend_pid();
  " >&2 || true
  return 1
}

run_fanout() {
  local scenario="$1"
  local count="$2"
  local sql_template="$3"
  local lane
  local sql
  local pid
  local status=0
  local -a pids=()

  mkdir -p "$TMP_DIR/$scenario"
  for ((lane = 1; lane <= count; lane += 1)); do
    sql="${sql_template//__LANE__/$lane}"
    psql_cmd -qAtc "$sql" \
      >"$TMP_DIR/$scenario/$lane.out" \
      2>"$TMP_DIR/$scenario/$lane.err" &
    pids+=("$!")
  done
  for pid in "${pids[@]}"; do
    if ! wait "$pid"; then
      status=1
    fi
  done
  if [[ "$status" -ne 0 ]]; then
    echo "$scenario fanout had a failed PostgreSQL connection" >&2
    for lane_file in "$TMP_DIR/$scenario"/*.err; do
      if [[ -s "$lane_file" ]]; then
        sed -n '1,100p' "$lane_file" >&2
      fi
    done
    return 1
  fi
  if grep -Eiq \
    '40P01|55P03|deadlock detected|canceling statement due to lock timeout' \
    "$TMP_DIR/$scenario"/*.out "$TMP_DIR/$scenario"/*.err; then
    echo "$scenario encountered a deadlock or lock timeout" >&2
    sed -n '1,100p' "$TMP_DIR/$scenario"/*.err >&2
    return 1
  fi
}

assert_count() {
  local scenario="$1"
  local expected="$2"
  local value="$3"
  local actual
  actual="$(grep -hFx "$value" "$TMP_DIR/$scenario"/*.out | wc -l | tr -d ' ')"
  if [[ "$actual" != "$expected" ]]; then
    echo "$scenario expected $expected '$value' results, got $actual" >&2
    sort "$TMP_DIR/$scenario"/*.out | uniq -c >&2
    return 1
  fi
}

assert_query() {
  local description="$1"
  local expected="$2"
  local query="$3"
  local actual
  actual="$(psql_cmd -qAtF '|' -c "$query")"
  if [[ "$actual" != "$expected" ]]; then
    echo "$description drifted: expected $expected, got $actual" >&2
    return 1
  fi
}

psql_cmd <<'SQL'
INSERT INTO auth.users (id) VALUES
  ('c6100000-0000-4000-8000-000000000001'),
  ('c6100000-0000-4000-8000-000000000002'),
  ('c6100000-0000-4000-8000-000000000003');

INSERT INTO public.user_profiles (id, handle) VALUES
  ('c6100000-0000-4000-8000-000000000001', 'tip_concurrency_payer'),
  ('c6100000-0000-4000-8000-000000000002', 'tip_concurrency_recipient'),
  ('c6100000-0000-4000-8000-000000000003', 'tip_concurrency_delete_recipient');

INSERT INTO public.posts (id, author_id, title, content) VALUES
  (
    'c6200000-0000-4000-8000-000000000001',
    'c6100000-0000-4000-8000-000000000002',
    'reserve bind expiry concurrency',
    'reserve bind expiry concurrency'
  ),
  (
    'c6200000-0000-4000-8000-000000000002',
    'c6100000-0000-4000-8000-000000000002',
    'post delete bind race',
    'post delete bind race'
  ),
  (
    'c6200000-0000-4000-8000-000000000003',
    'c6100000-0000-4000-8000-000000000003',
    'recipient delete expiry race',
    'recipient delete expiry race'
  ),
  (
    'c6200000-0000-4000-8000-000000000004',
    'c6100000-0000-4000-8000-000000000002',
    'expiry completion race',
    'expiry completion race'
  );

CREATE OR REPLACE FUNCTION public.sleep_tip_checkout_concurrency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF pg_catalog.current_setting('tip_checkout.race', true) IN (
    'post_bind',
    'recipient_expire',
    'terminal_expire'
  ) THEN
    PERFORM pg_catalog.pg_sleep(0.75);
  END IF;
  RETURN NEW;
END
$function$;
ALTER FUNCTION public.sleep_tip_checkout_concurrency() OWNER TO postgres;
CREATE TRIGGER trg_tips_zz_checkout_concurrency_sleep
  BEFORE UPDATE ON public.tips
  FOR EACH ROW
  EXECUTE FUNCTION public.sleep_tip_checkout_concurrency();
SQL

reserve_sql="
  WITH role_set AS MATERIALIZED (
    SELECT pg_catalog.set_config(
      'request.jwt.claim.role', 'service_role', false
    )
  )
  SELECT result ->> 'status'
  FROM role_set
  CROSS JOIN LATERAL public.reserve_tip_checkout_atomic(
    'c6100000-0000-4000-8000-000000000001',
    'c6200000-0000-4000-8000-000000000001',
    4500,
    'reserve lane __LANE__',
    3600
  ) AS result;
  /* tip_checkout_reserve_lane___LANE__ */
"
run_fanout reserve_same_tuple 12 "$reserve_sql"
assert_count reserve_same_tuple 1 reserved
assert_count reserve_same_tuple 11 reservation_exists
assert_query \
  "same-tuple reservation cardinality" \
  "1|1" \
  "
    SELECT pg_catalog.count(*),
      pg_catalog.count(*) FILTER (
        WHERE checkout_post_id =
          'c6200000-0000-4000-8000-000000000001'
          AND checkout_to_user_id =
          'c6100000-0000-4000-8000-000000000002'
      )
    FROM public.tips
    WHERE from_user_id = 'c6100000-0000-4000-8000-000000000001'
      AND checkout_post_id = 'c6200000-0000-4000-8000-000000000001'
      AND amount_cents = 4500
      AND status = 'pending';
  "

IFS='|' read -r SAME_TIP_ID SAME_EXPIRES_AT <<<"$(
  psql_cmd -qAtF '|' -c "
    SELECT id, checkout_expires_at
    FROM public.tips
    WHERE from_user_id = 'c6100000-0000-4000-8000-000000000001'
      AND checkout_post_id = 'c6200000-0000-4000-8000-000000000001'
      AND amount_cents = 4500
      AND status = 'pending';
  "
)"

bind_sql="
  WITH role_set AS MATERIALIZED (
    SELECT pg_catalog.set_config(
      'request.jwt.claim.role', 'service_role', false
    )
  )
  SELECT result ->> 'status'
  FROM role_set
  CROSS JOIN LATERAL public.bind_tip_checkout_session_atomic(
    '$SAME_TIP_ID',
    'c6100000-0000-4000-8000-000000000001',
    'cs_tip_concurrency_same',
    '$SAME_EXPIRES_AT'
  ) AS result;
  /* tip_checkout_same_bind___LANE__ */
"
run_fanout bind_same_session 12 "$bind_sql"
assert_count bind_same_session 1 bound
assert_count bind_same_session 11 already_bound

IFS='|' read -r ALT_TIP_ID ALT_EXPIRES_AT <<<"$(
  psql_cmd -qAtF '|' -c "
    WITH role_set AS MATERIALIZED (
      SELECT pg_catalog.set_config(
        'request.jwt.claim.role', 'service_role', false
      )
    ), reserved AS MATERIALIZED (
      SELECT public.reserve_tip_checkout_atomic(
        'c6100000-0000-4000-8000-000000000001',
        'c6200000-0000-4000-8000-000000000001',
        4600,
        NULL,
        3600
      ) AS result
      FROM role_set
    )
    SELECT result ->> 'tip_id', result ->> 'checkout_expires_at'
    FROM reserved;
  "
)"

alt_bind_sql="
  WITH role_set AS MATERIALIZED (
    SELECT pg_catalog.set_config(
      'request.jwt.claim.role', 'service_role', false
    )
  )
  SELECT result ->> 'status'
  FROM role_set
  CROSS JOIN LATERAL public.bind_tip_checkout_session_atomic(
    '$ALT_TIP_ID',
    'c6100000-0000-4000-8000-000000000001',
    CASE WHEN (__LANE__ % 2) = 0
      THEN 'cs_tip_concurrency_even'
      ELSE 'cs_tip_concurrency_odd'
    END,
    '$ALT_EXPIRES_AT'
  ) AS result;
  /* tip_checkout_different_bind___LANE__ */
"
run_fanout bind_different_sessions 12 "$alt_bind_sql"
assert_count bind_different_sessions 1 bound
if grep -hvE '^(bound|already_bound|identity_conflict)$' \
  "$TMP_DIR/bind_different_sessions"/*.out | grep -q .; then
  echo "different-Session bind returned an unexpected status" >&2
  sort "$TMP_DIR/bind_different_sessions"/*.out | uniq -c >&2
  exit 1
fi
if [[ "$(grep -hFx identity_conflict "$TMP_DIR/bind_different_sessions"/*.out | wc -l | tr -d ' ')" -lt 1 ]]; then
  echo "different-Session bind never rejected the losing identity" >&2
  exit 1
fi
assert_query \
  "different-Session stable winner" \
  "1" \
  "
    SELECT pg_catalog.count(*)
    FROM public.tips
    WHERE id = '$ALT_TIP_ID'
      AND stripe_checkout_session_id IN (
        'cs_tip_concurrency_even', 'cs_tip_concurrency_odd'
      );
  "

EVENT_CREATED_AT="$(psql_cmd -qAtc "
  SELECT pg_catalog.date_trunc('second', pg_catalog.clock_timestamp());
")"
expire_sql="
  WITH role_set AS MATERIALIZED (
    SELECT pg_catalog.set_config(
      'request.jwt.claim.role', 'service_role', false
    )
  )
  SELECT result ->> 'status'
  FROM role_set
  CROSS JOIN LATERAL public.expire_pending_tip_checkout_atomic(
    '$SAME_TIP_ID',
    'c6100000-0000-4000-8000-000000000001',
    'c6200000-0000-4000-8000-000000000001',
    'c6100000-0000-4000-8000-000000000002',
    4500,
    'cs_tip_concurrency_same',
    '$SAME_EXPIRES_AT',
    'evt_tip_concurrency_same',
    '$EVENT_CREATED_AT'
  ) AS result;
  /* tip_checkout_same_expiry___LANE__ */
"
run_fanout expire_same_event 12 "$expire_sql"
assert_count expire_same_event 1 expired
assert_count expire_same_event 11 already_expired
assert_query \
  "same-event expiry terminal state" \
  "failed|evt_tip_concurrency_same|cs_tip_concurrency_same" \
  "
    SELECT status, checkout_failure_event_id, stripe_checkout_session_id
    FROM public.tips
    WHERE id = '$SAME_TIP_ID';
  "

direct_insert_sql="
  INSERT INTO public.tips (
    id, post_id, from_user_id, to_user_id, amount_cents, status
  ) VALUES (
    pg_catalog.gen_random_uuid(),
    'c6200000-0000-4000-8000-000000000001',
    'c6100000-0000-4000-8000-000000000001',
    'c6100000-0000-4000-8000-000000000002',
    4700,
    'pending'
  )
  ON CONFLICT (from_user_id, checkout_post_id, amount_cents)
    WHERE status = 'pending'
  DO NOTHING
  RETURNING 1;
  /* tip_checkout_direct_insert___LANE__ */
"
run_fanout direct_insert_same_tuple 12 "$direct_insert_sql"
assert_count direct_insert_same_tuple 1 1
assert_query \
  "mixed-writer tuple uniqueness" \
  "1|1" \
  "
    SELECT pg_catalog.count(*),
      pg_catalog.count(*) FILTER (
        WHERE checkout_post_id =
          'c6200000-0000-4000-8000-000000000001'
          AND checkout_to_user_id =
          'c6100000-0000-4000-8000-000000000002'
      )
    FROM public.tips
    WHERE from_user_id = 'c6100000-0000-4000-8000-000000000001'
      AND checkout_post_id = 'c6200000-0000-4000-8000-000000000001'
      AND amount_cents = 4700
      AND status = 'pending';
  "

run_ordered_pair() {
  local scenario="$1"
  local first_marker="$2"
  local first_sql="$3"
  local second_sql="$4"
  local first_pid
  local second_pid
  local first_status=0
  local second_status=0
  local first_out="$TMP_DIR/$scenario.first.out"
  local second_out="$TMP_DIR/$scenario.second.out"

  psql_cmd -qAtc "$first_sql" >"$first_out" 2>&1 &
  first_pid=$!
  wait_for_sleep "$first_marker"
  psql_cmd -qAtc "$second_sql" >"$second_out" 2>&1 &
  second_pid=$!
  wait "$first_pid" || first_status=$?
  wait "$second_pid" || second_status=$?
  if [[ "$first_status" -ne 0 || "$second_status" -ne 0 ]]; then
    echo "$scenario did not complete both PostgreSQL sessions" >&2
    sed -n '1,120p' "$first_out" >&2
    sed -n '1,120p' "$second_out" >&2
    return 1
  fi
  if grep -Eiq \
    '40P01|55P03|deadlock detected|canceling statement due to lock timeout' \
    "$first_out" "$second_out"; then
    echo "$scenario encountered a deadlock or lock timeout" >&2
    sed -n '1,120p' "$first_out" >&2
    sed -n '1,120p' "$second_out" >&2
    return 1
  fi
  PAIR_FIRST_RESULT="$(<"$first_out")"
  PAIR_SECOND_RESULT="$(<"$second_out")"
}

IFS='|' read -r POST_TIP_ID POST_EXPIRES_AT <<<"$(
  psql_cmd -qAtF '|' -c "
    WITH role_set AS MATERIALIZED (
      SELECT pg_catalog.set_config(
        'request.jwt.claim.role', 'service_role', false
      )
    ), reserved AS MATERIALIZED (
      SELECT public.reserve_tip_checkout_atomic(
        'c6100000-0000-4000-8000-000000000001',
        'c6200000-0000-4000-8000-000000000002',
        4800,
        NULL,
        3600
      ) AS result
      FROM role_set
    )
    SELECT result ->> 'tip_id', result ->> 'checkout_expires_at'
    FROM reserved;
  "
)"
post_bind_sql="
  WITH settings AS MATERIALIZED (
    SELECT
      pg_catalog.set_config(
        'request.jwt.claim.role', 'service_role', false
      ),
      pg_catalog.set_config('tip_checkout.race', 'post_bind', false)
  )
  SELECT result ->> 'status'
  FROM settings
  CROSS JOIN LATERAL public.bind_tip_checkout_session_atomic(
    '$POST_TIP_ID',
    'c6100000-0000-4000-8000-000000000001',
    'cs_tip_post_delete_race',
    '$POST_EXPIRES_AT'
  ) AS result;
  /* tip_checkout_post_delete_bind */
"
post_delete_sql="
  SET lock_timeout = '5s';
  DELETE FROM public.posts
  WHERE id = 'c6200000-0000-4000-8000-000000000002'
  RETURNING 'deleted';
  /* tip_checkout_post_delete_parent */
"
run_ordered_pair \
  post_delete_bind \
  tip_checkout_post_delete_bind \
  "$post_bind_sql" \
  "$post_delete_sql"
if [[ "$PAIR_FIRST_RESULT" != "bound"
  || "$PAIR_SECOND_RESULT" != "deleted" ]]; then
  echo "post-delete/bind returned unexpected results" >&2
  printf '%s\n%s\n' "$PAIR_FIRST_RESULT" "$PAIR_SECOND_RESULT" >&2
  exit 1
fi
assert_query \
  "post-delete bind snapshot" \
  "t|c6200000-0000-4000-8000-000000000002|cs_tip_post_delete_race" \
  "
    SELECT post_id IS NULL, checkout_post_id, stripe_checkout_session_id
    FROM public.tips
    WHERE id = '$POST_TIP_ID';
  "

IFS='|' read -r RECIPIENT_TIP_ID RECIPIENT_EXPIRES_AT <<<"$(
  psql_cmd -qAtF '|' -c "
    WITH role_set AS MATERIALIZED (
      SELECT pg_catalog.set_config(
        'request.jwt.claim.role', 'service_role', false
      )
    ), reserved AS MATERIALIZED (
      SELECT public.reserve_tip_checkout_atomic(
        'c6100000-0000-4000-8000-000000000001',
        'c6200000-0000-4000-8000-000000000003',
        4900,
        NULL,
        3600
      ) AS result
      FROM role_set
    )
    SELECT result ->> 'tip_id', result ->> 'checkout_expires_at'
    FROM reserved;
  "
)"
RECIPIENT_EVENT_CREATED="$(psql_cmd -qAtc "
  SELECT pg_catalog.date_trunc('second', pg_catalog.clock_timestamp());
")"
recipient_expire_sql="
  WITH settings AS MATERIALIZED (
    SELECT
      pg_catalog.set_config(
        'request.jwt.claim.role', 'service_role', false
      ),
      pg_catalog.set_config(
        'tip_checkout.race', 'recipient_expire', false
      )
  )
  SELECT result ->> 'status'
  FROM settings
  CROSS JOIN LATERAL public.expire_pending_tip_checkout_atomic(
    '$RECIPIENT_TIP_ID',
    'c6100000-0000-4000-8000-000000000001',
    'c6200000-0000-4000-8000-000000000003',
    'c6100000-0000-4000-8000-000000000003',
    4900,
    'cs_tip_recipient_delete_race',
    '$RECIPIENT_EXPIRES_AT',
    'evt_tip_recipient_delete_race',
    '$RECIPIENT_EVENT_CREATED'
  ) AS result;
  /* tip_checkout_recipient_delete_expiry */
"
recipient_delete_sql="
  SET lock_timeout = '5s';
  DELETE FROM auth.users
  WHERE id = 'c6100000-0000-4000-8000-000000000003'
  RETURNING 'deleted';
  /* tip_checkout_recipient_delete_parent */
"
run_ordered_pair \
  recipient_delete_expiry \
  tip_checkout_recipient_delete_expiry \
  "$recipient_expire_sql" \
  "$recipient_delete_sql"
if [[ "$PAIR_FIRST_RESULT" != "expired"
  || "$PAIR_SECOND_RESULT" != "deleted" ]]; then
  echo "recipient-delete/expiry returned unexpected results" >&2
  printf '%s\n%s\n' "$PAIR_FIRST_RESULT" "$PAIR_SECOND_RESULT" >&2
  exit 1
fi
assert_query \
  "recipient-delete expiry snapshot" \
  "failed|t|c6100000-0000-4000-8000-000000000003|evt_tip_recipient_delete_race" \
  "
    SELECT status, to_user_id IS NULL, checkout_to_user_id,
      checkout_failure_event_id
    FROM public.tips
    WHERE id = '$RECIPIENT_TIP_ID';
  "

IFS='|' read -r TERMINAL_TIP_ID TERMINAL_EXPIRES_AT <<<"$(
  psql_cmd -qAtF '|' -c "
    WITH role_set AS MATERIALIZED (
      SELECT pg_catalog.set_config(
        'request.jwt.claim.role', 'service_role', false
      )
    ), reserved AS MATERIALIZED (
      SELECT public.reserve_tip_checkout_atomic(
        'c6100000-0000-4000-8000-000000000001',
        'c6200000-0000-4000-8000-000000000004',
        5000,
        NULL,
        3600
      ) AS result
      FROM role_set
    )
    SELECT result ->> 'tip_id', result ->> 'checkout_expires_at'
    FROM reserved;
  "
)"
assert_query \
  "terminal-race initial Session bind" \
  "bound" \
  "
    WITH role_set AS MATERIALIZED (
      SELECT pg_catalog.set_config(
        'request.jwt.claim.role', 'service_role', false
      )
    )
    SELECT result ->> 'status'
    FROM role_set
    CROSS JOIN LATERAL public.bind_tip_checkout_session_atomic(
      '$TERMINAL_TIP_ID',
      'c6100000-0000-4000-8000-000000000001',
      'cs_tip_expiry_completion_race',
      '$TERMINAL_EXPIRES_AT'
    ) AS result;
  "
TERMINAL_EVENT_CREATED="$(psql_cmd -qAtc "
  SELECT pg_catalog.date_trunc('second', pg_catalog.clock_timestamp());
")"
terminal_expire_sql="
  WITH settings AS MATERIALIZED (
    SELECT
      pg_catalog.set_config(
        'request.jwt.claim.role', 'service_role', false
      ),
      pg_catalog.set_config('tip_checkout.race', 'terminal_expire', false)
  )
  SELECT result ->> 'status'
  FROM settings
  CROSS JOIN LATERAL public.expire_pending_tip_checkout_atomic(
    '$TERMINAL_TIP_ID',
    'c6100000-0000-4000-8000-000000000001',
    'c6200000-0000-4000-8000-000000000004',
    'c6100000-0000-4000-8000-000000000002',
    5000,
    'cs_tip_expiry_completion_race',
    '$TERMINAL_EXPIRES_AT',
    'evt_tip_expiry_completion_race',
    '$TERMINAL_EVENT_CREATED'
  ) AS result;
  /* tip_checkout_expiry_completion_expiry */
"
terminal_complete_sql="
  WITH role_set AS MATERIALIZED (
    SELECT pg_catalog.set_config(
      'request.jwt.claim.role', 'service_role', false
    )
  )
  SELECT result ->> 'status'
  FROM role_set
  CROSS JOIN LATERAL public.complete_tip_with_stripe_ownership_atomic(
    '$TERMINAL_TIP_ID',
    'cus_tip_expiry_completion_race',
    'pi_tip_expiry_completion_race',
    'ch_tip_expiry_completion_race',
    'cs_tip_expiry_completion_race',
    5000,
    'usd',
    '$TERMINAL_EVENT_CREATED',
    '$TERMINAL_TIP_ID',
    'c6100000-0000-4000-8000-000000000001',
    'c6100000-0000-4000-8000-000000000001',
    'c6200000-0000-4000-8000-000000000004',
    'c6100000-0000-4000-8000-000000000002',
    5000,
    '$TERMINAL_EXPIRES_AT',
    'evt_tip_expiry_completion_complete'
  ) AS result;
  /* tip_checkout_expiry_completion_payment */
"
run_ordered_pair \
  expiry_completion \
  tip_checkout_expiry_completion_expiry \
  "$terminal_expire_sql" \
  "$terminal_complete_sql"
if [[ "$PAIR_FIRST_RESULT" != "expired"
  || "$PAIR_SECOND_RESULT" != "manual_review" ]]; then
  echo "expiry/completion race did not commit the signed first terminal" >&2
  printf '%s\n%s\n' "$PAIR_FIRST_RESULT" "$PAIR_SECOND_RESULT" >&2
  exit 1
fi
assert_query \
  "expiry/completion single terminal" \
  "failed|evt_tip_expiry_completion_race||||0|1" \
  "
    SELECT status, checkout_failure_event_id,
      stripe_payment_intent_id, stripe_charge_id, completed_at,
      (
        SELECT pg_catalog.count(*)
        FROM public.stripe_payment_ownerships AS ownership
        WHERE ownership.ledger_id = tip.id
          OR ownership.stripe_payment_intent_id =
            'pi_tip_expiry_completion_race'
          OR ownership.stripe_charge_id = 'ch_tip_expiry_completion_race'
          OR ownership.checkout_session_id =
            'cs_tip_expiry_completion_race'
      ),
      (
        SELECT pg_catalog.count(*)
        FROM public.stripe_manual_reviews AS review
        WHERE review.object_type = 'tip_checkout_completion'
          AND review.object_id = 'evt_tip_expiry_completion_complete'
          AND review.reason_key =
            'tip_checkout_completion_after_expiry'
      )
    FROM public.tips AS tip
    WHERE tip.id = '$TERMINAL_TIP_ID';
  "

echo "Tip checkout 12-connection and parent/terminal concurrency proof passed"
