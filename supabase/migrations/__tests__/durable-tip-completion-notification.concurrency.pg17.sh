#!/usr/bin/env bash

set -Eeuo pipefail

SOCKET_DIR="${1:?socket directory is required}"
PORT="${2:?port is required}"
PG_BIN="${3:?PostgreSQL bin directory is required}"
TMP_DIR="$(mktemp -d /tmp/durable-tip-notification-concurrency.XXXXXX)"

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
    DROP TRIGGER IF EXISTS trg_tips_zz_durable_concurrency_sleep
      ON public.tips;
    DROP FUNCTION IF EXISTS public.sleep_durable_tip_concurrency_update();
  " >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

wait_for_activity_event() {
  local marker="$1"
  local wait_event_type="$2"
  local wait_event="${3:-}"
  local observed=false
  local count

  for _attempt in {1..100}; do
    count="$(
      psql_cmd -qAtc "
        SELECT pg_catalog.count(*)
        FROM pg_catalog.pg_stat_activity AS activity
        WHERE pg_catalog.strpos(activity.query, '$marker') > 0
          AND activity.wait_event_type = '$wait_event_type'
          AND (
            '$wait_event' = ''
            OR activity.wait_event = '$wait_event'
          )
      "
    )"
    if [[ "$count" -ge 1 ]]; then
      observed=true
      break
    fi
    sleep 0.05
  done

  if [[ "$observed" != "true" ]]; then
    echo "$marker never reached $wait_event_type/$wait_event" >&2
    psql_cmd -x -c "
      SELECT pid, state, wait_event_type, wait_event, query
      FROM pg_catalog.pg_stat_activity
      WHERE datname = pg_catalog.current_database()
        AND pid <> pg_catalog.pg_backend_pid();
    " >&2 || true
    return 1
  fi
}

run_deterministic_pair() {
  local scenario="$1"
  local first_marker="$2"
  local first_sql="$3"
  local second_marker="$4"
  local second_sql="$5"
  local first_out="$TMP_DIR/${scenario}.first.out"
  local second_out="$TMP_DIR/${scenario}.second.out"
  local first_pid
  local second_pid
  local first_status=0
  local second_status=0

  psql_cmd -qAtc "$first_sql" >"$first_out" 2>&1 &
  first_pid=$!
  wait_for_activity_event "$first_marker" Timeout PgSleep

  psql_cmd -qAtc "$second_sql" >"$second_out" 2>&1 &
  second_pid=$!
  wait_for_activity_event "$second_marker" Lock

  wait "$first_pid" || first_status=$?
  wait "$second_pid" || second_status=$?

  if [[ "$first_status" -ne 0 || "$second_status" -ne 0 ]]; then
    echo "$scenario did not complete both sessions" >&2
    sed -n '1,100p' "$first_out" >&2
    sed -n '1,100p' "$second_out" >&2
    return 1
  fi
  if grep -Eiq \
    '40P01|55P03|deadlock detected|canceling statement due to lock timeout' \
    "$first_out" "$second_out"; then
    echo "$scenario encountered a deadlock or lock timeout" >&2
    sed -n '1,100p' "$first_out" >&2
    sed -n '1,100p' "$second_out" >&2
    return 1
  fi

  PAIR_FIRST_RESULT="$(<"$first_out")"
  PAIR_SECOND_RESULT="$(<"$second_out")"
}

assert_query_result() {
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

tip7_complete_sql="
  SET lock_timeout = '5s';
  WITH role_set AS MATERIALIZED (
    SELECT pg_catalog.set_config(
      'request.jwt.claim.role',
      'service_role',
      false
    )
  )
  SELECT (
    public.complete_tip_with_stripe_ownership_atomic(
      'd3000000-0000-4000-8000-000000000007',
      'cus_durable_tip_actor',
      'pi_durable_tip_concurrent_refund',
      'ch_durable_tip_concurrent_refund',
      'cs_durable_tip_concurrent_refund',
      3500,
      'usd',
      '2036-01-07 00:00:01+00'
    ) ->> 'status'
  )
  FROM role_set;
"
run_deterministic_pair \
  completion_replay \
  durable_tip_concurrency_call_one \
  "$tip7_complete_sql /* durable_tip_concurrency_call_one */" \
  durable_tip_concurrency_call_two \
  "$tip7_complete_sql /* durable_tip_concurrency_call_two */"
if [[ "$PAIR_FIRST_RESULT" != "refunded"
  || "$PAIR_SECOND_RESULT" != "refunded" ]]; then
  echo "concurrent completion did not converge to refunded" >&2
  printf '%s\n%s\n' "$PAIR_FIRST_RESULT" "$PAIR_SECOND_RESULT" >&2
  exit 1
fi
assert_query_result \
  "concurrent refunded tip notification state" \
  "refunded|0|1|refund_suppressed" \
  "
    SELECT
      tip.status,
      (
        SELECT pg_catalog.count(*)
        FROM public.notifications AS notification
        WHERE notification.type = 'tip_received'
          AND notification.reference_id = tip.id
      ),
      (
        SELECT pg_catalog.count(*)
        FROM public.tip_completion_notification_deliveries AS delivery
        WHERE delivery.tip_id = tip.id
      ),
      (
        SELECT delivery.disposition
        FROM public.tip_completion_notification_deliveries AS delivery
        WHERE delivery.tip_id = tip.id
      )
    FROM public.tips AS tip
    WHERE tip.id = 'd3000000-0000-4000-8000-000000000007';
  "

post_complete_sql="
  SET lock_timeout = '5s';
  WITH role_set AS MATERIALIZED (
    SELECT pg_catalog.set_config(
      'request.jwt.claim.role',
      'service_role',
      false
    )
  )
  SELECT (
    public.complete_tip_with_stripe_ownership_atomic(
      'd3000000-0000-4000-8000-000000000016',
      'cus_durable_tip_actor',
      'pi_durable_tip_post_delete_race',
      'ch_durable_tip_post_delete_race',
      'cs_durable_tip_post_delete_race',
      1600,
      'usd',
      '2036-01-16 00:00:00+00'
    ) ->> 'status'
  )
  FROM role_set;
  /* durable_tip_post_delete_completion */
"
post_delete_sql="
  SET lock_timeout = '5s';
  DELETE FROM public.posts
  WHERE id = 'd2000000-0000-4000-8000-000000000016'
  RETURNING 'deleted';
  /* durable_tip_post_delete_parent */
"
run_deterministic_pair \
  post_delete_completion \
  durable_tip_post_delete_completion \
  "$post_complete_sql" \
  durable_tip_post_delete_parent \
  "$post_delete_sql"
if [[ "$PAIR_FIRST_RESULT" != "completed"
  || "$PAIR_SECOND_RESULT" != "deleted" ]]; then
  echo "post-delete/completion pair returned unexpected results" >&2
  printf '%s\n%s\n' "$PAIR_FIRST_RESULT" "$PAIR_SECOND_RESULT" >&2
  exit 1
fi
assert_query_result \
  "post-delete/completion durable state" \
  "completed|t|0|1|authority_deleted" \
  "
    SELECT
      tip.status,
      tip.post_id IS NULL,
      (
        SELECT pg_catalog.count(*)
        FROM public.notifications AS notification
        WHERE notification.type = 'tip_received'
          AND notification.reference_id = tip.id
      ),
      (
        SELECT pg_catalog.count(*)
        FROM public.tip_completion_notification_deliveries AS delivery
        WHERE delivery.tip_id = tip.id
      ),
      (
        SELECT delivery.disposition
        FROM public.tip_completion_notification_deliveries AS delivery
        WHERE delivery.tip_id = tip.id
      )
    FROM public.tips AS tip
    WHERE tip.id = 'd3000000-0000-4000-8000-000000000016';
  "
assert_query_result \
  "post-delete completion replay" \
  "already_completed" \
  "
    WITH role_set AS MATERIALIZED (
      SELECT pg_catalog.set_config(
        'request.jwt.claim.role',
        'service_role',
        false
      )
    )
    SELECT (
      public.complete_tip_with_stripe_ownership_atomic(
        'd3000000-0000-4000-8000-000000000016',
        'cus_durable_tip_actor',
        'pi_durable_tip_post_delete_race',
        'ch_durable_tip_post_delete_race',
        'cs_durable_tip_post_delete_race',
        1600,
        'usd',
        '2036-01-16 00:00:00+00'
      ) ->> 'status'
    )
    FROM role_set;
  "

actor_complete_sql="
  SET lock_timeout = '5s';
  WITH role_set AS MATERIALIZED (
    SELECT pg_catalog.set_config(
      'request.jwt.claim.role',
      'service_role',
      false
    )
  )
  SELECT (
    public.complete_tip_with_stripe_ownership_atomic(
      'd3000000-0000-4000-8000-000000000017',
      'cus_durable_tip_deleted_actor',
      'pi_durable_tip_actor_delete_race',
      'ch_durable_tip_actor_delete_race',
      'cs_durable_tip_actor_delete_race',
      1700,
      'usd',
      '2036-01-17 00:00:00+00'
    ) ->> 'status'
  )
  FROM role_set;
  /* durable_tip_actor_delete_completion */
"
actor_delete_sql="
  SET lock_timeout = '5s';
  DELETE FROM auth.users
  WHERE id = 'd1000000-0000-4000-8000-000000000016'
  RETURNING 'deleted';
  /* durable_tip_actor_delete_parent */
"
run_deterministic_pair \
  actor_delete_completion \
  durable_tip_actor_delete_completion \
  "$actor_complete_sql" \
  durable_tip_actor_delete_parent \
  "$actor_delete_sql"
if [[ "$PAIR_FIRST_RESULT" != "completed"
  || "$PAIR_SECOND_RESULT" != "deleted" ]]; then
  echo "actor-delete/completion pair returned unexpected results" >&2
  printf '%s\n%s\n' "$PAIR_FIRST_RESULT" "$PAIR_SECOND_RESULT" >&2
  exit 1
fi
assert_query_result \
  "actor-delete/completion durable state" \
  "0|0|1|authority_deleted" \
  "
    SELECT
      (
        SELECT pg_catalog.count(*)
        FROM public.tips AS tip
        WHERE tip.id = 'd3000000-0000-4000-8000-000000000017'
      ),
      (
        SELECT pg_catalog.count(*)
        FROM public.notifications AS notification
        WHERE notification.type = 'tip_received'
          AND notification.reference_id =
            'd3000000-0000-4000-8000-000000000017'
      ),
      pg_catalog.count(*),
      pg_catalog.min(delivery.disposition)
    FROM public.tip_completion_notification_deliveries AS delivery
    WHERE delivery.tip_id =
      'd3000000-0000-4000-8000-000000000017';
  "
assert_query_result \
  "actor-delete completion replay" \
  "manual_review|tip_completion_subject_missing" \
  "
    WITH role_set AS MATERIALIZED (
      SELECT pg_catalog.set_config(
        'request.jwt.claim.role',
        'service_role',
        false
      )
    ), replay AS MATERIALIZED (
      SELECT public.complete_tip_with_stripe_ownership_atomic(
        'd3000000-0000-4000-8000-000000000017',
        'cus_durable_tip_deleted_actor',
        'pi_durable_tip_actor_delete_race',
        'ch_durable_tip_actor_delete_race',
        'cs_durable_tip_actor_delete_race',
        1700,
        'usd',
        '2036-01-17 00:00:00+00'
      ) AS result
      FROM role_set
    )
    SELECT result ->> 'status', result ->> 'reason_key'
    FROM replay;
  "

recipient_refund_sql="
  SET lock_timeout = '5s';
  WITH role_set AS MATERIALIZED (
    SELECT pg_catalog.set_config(
      'request.jwt.claim.role',
      'service_role',
      false
    )
  ), refund AS MATERIALIZED (
    SELECT public.record_charge_refund_tombstone_atomic(
      'd1000000-0000-4000-8000-000000000001',
      'cus_durable_tip_actor',
      'pi_durable_tip_recipient_refund_race',
      'ch_durable_tip_recipient_refund_race',
      true,
      1800,
      'usd',
      1800,
      'succeeded',
      'evt_durable_tip_recipient_refund_race',
      '2036-01-18 00:01:00+00'
    ) AS result
    FROM role_set
  )
  SELECT
    result ->> 'status',
    result ->> 'product_kind',
    result ->> 'projection_status'
  FROM refund;
  /* durable_tip_recipient_delete_refund */
"
recipient_delete_sql="
  SET lock_timeout = '5s';
  DELETE FROM auth.users
  WHERE id = 'd1000000-0000-4000-8000-000000000018'
  RETURNING 'deleted';
  /* durable_tip_recipient_delete_parent */
"
run_deterministic_pair \
  recipient_delete_refund \
  durable_tip_recipient_delete_refund \
  "$recipient_refund_sql" \
  durable_tip_recipient_delete_parent \
  "$recipient_delete_sql"
if [[ "$PAIR_FIRST_RESULT" != "recorded|tip|resolved"
  || "$PAIR_SECOND_RESULT" != "deleted" ]]; then
  echo "recipient-delete/refund pair returned unexpected results" >&2
  printf '%s\n%s\n' "$PAIR_FIRST_RESULT" "$PAIR_SECOND_RESULT" >&2
  exit 1
fi
assert_query_result \
  "recipient-delete/refund durable state" \
  "refunded|t|0|1|refund_suppressed" \
  "
    SELECT
      tip.status,
      tip.to_user_id IS NULL,
      (
        SELECT pg_catalog.count(*)
        FROM public.notifications AS notification
        WHERE notification.type = 'tip_received'
          AND notification.reference_id = tip.id
      ),
      (
        SELECT pg_catalog.count(*)
        FROM public.tip_completion_notification_deliveries AS delivery
        WHERE delivery.tip_id = tip.id
      ),
      (
        SELECT delivery.disposition
        FROM public.tip_completion_notification_deliveries AS delivery
        WHERE delivery.tip_id = tip.id
      )
    FROM public.tips AS tip
    WHERE tip.id = 'd3000000-0000-4000-8000-000000000018';
  "
assert_query_result \
  "recipient-delete refund replay" \
  "already_recorded|tip|already_resolved" \
  "
    WITH role_set AS MATERIALIZED (
      SELECT pg_catalog.set_config(
        'request.jwt.claim.role',
        'service_role',
        false
      )
    ), refund AS MATERIALIZED (
      SELECT public.record_charge_refund_tombstone_atomic(
        'd1000000-0000-4000-8000-000000000001',
        'cus_durable_tip_actor',
        'pi_durable_tip_recipient_refund_race',
        'ch_durable_tip_recipient_refund_race',
        true,
        1800,
        'usd',
        1800,
        'succeeded',
        'evt_durable_tip_recipient_refund_race',
        '2036-01-18 00:01:00+00'
      ) AS result
      FROM role_set
    )
    SELECT
      result ->> 'status',
      result ->> 'product_kind',
      result ->> 'projection_status'
    FROM refund;
  "
assert_query_result \
  "recipient-delete/refund replay durable state" \
  "refunded|t|0|1|refund_suppressed" \
  "
    SELECT
      tip.status,
      tip.to_user_id IS NULL,
      (
        SELECT pg_catalog.count(*)
        FROM public.notifications AS notification
        WHERE notification.type = 'tip_received'
          AND notification.reference_id = tip.id
      ),
      (
        SELECT pg_catalog.count(*)
        FROM public.tip_completion_notification_deliveries AS delivery
        WHERE delivery.tip_id = tip.id
      ),
      (
        SELECT delivery.disposition
        FROM public.tip_completion_notification_deliveries AS delivery
        WHERE delivery.tip_id = tip.id
      )
    FROM public.tips AS tip
    WHERE tip.id = 'd3000000-0000-4000-8000-000000000018';
  "

echo "Durable tip notification production-order lifecycle concurrency proof passed"
