#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BASE_MIGRATION="$ROOT_DIR/supabase/migrations/20260803106000_durable_comment_reaction_count_repair.sql"
DESIRED_MIGRATION="$ROOT_DIR/supabase/migrations/20260803107000_set_comment_reaction_desired_state.sql"
CAUSAL_MIGRATION="$ROOT_DIR/supabase/migrations/20260803108000_comment_reaction_causal_intents.sql"
CONTRACT_MIGRATION="$ROOT_DIR/supabase/migrations/20260803109000_close_legacy_comment_reaction_desired_state.sql"
DESIRED_FIXTURE="$ROOT_DIR/supabase/migrations/__tests__/set-comment-reaction-desired-state.pg17.sh"
CAUSAL_FIXTURE="$ROOT_DIR/supabase/migrations/__tests__/comment-reaction-causal-intents.pg17.sh"

# Reuse the proven 1080 setup through its first successful deployment. The
# extracted prefix in turn reuses the 1060/1070 fixture, so this proof exercises
# the real sealed dependency graph without copying its large scaffold.
SETUP_PREFIX="$(mktemp /tmp/close-legacy-comment-reaction-setup.XXXXXX)"
awk '
  NR == 2 { print; next }
  NR >= 10 { print }
  $0 == "psql_cmd -f \"$CAUSAL_MIGRATION\"" { exit }
' "$CAUSAL_FIXTURE" >"$SETUP_PREFIX"
# shellcheck source=/dev/null
source "$SETUP_PREFIX"
rm -f "$SETUP_PREFIX"

assert_migration_fails() {
  local label="$1"
  local expected="$2"
  if psql_cmd -f "$CONTRACT_MIGRATION" \
    >"$TMP_ROOT/$label.out" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if ! grep -q "$expected" "$TMP_ROOT/$label.out"; then
    echo "$label failed for an unexpected reason" >&2
    cat "$TMP_ROOT/$label.out" >&2
    exit 1
  fi
}

ACTOR_ID='10000000-0000-0000-0000-000000000001'
POST_ID='20000000-0000-0000-0000-000000000001'
COMMENT_ID='30000000-0000-0000-0000-000000000001'
REQUEST_ID='90909090909090909090909090909090'

# legacy_grant_chain_converged: discover arbitrary grantees, PUBLIC and grant
# options from the catalog; CASCADE must also remove a delegated child grant.
psql_cmd <<'SQL'
CREATE ROLE legacy_comment_reactor NOLOGIN;
CREATE ROLE delegated_comment_reactor NOLOGIN;
GRANT USAGE ON SCHEMA public
  TO legacy_comment_reactor, delegated_comment_reactor;
GRANT EXECUTE ON FUNCTION
  public.set_comment_reaction_desired_state_atomic(uuid, uuid, uuid, text)
  TO PUBLIC;
GRANT EXECUTE ON FUNCTION
  public.set_comment_reaction_desired_state_atomic(uuid, uuid, uuid, text)
  TO legacy_comment_reactor WITH GRANT OPTION;
SET ROLE legacy_comment_reactor;
GRANT EXECUTE ON FUNCTION
  public.set_comment_reaction_desired_state_atomic(uuid, uuid, uuid, text)
  TO delegated_comment_reactor;
RESET ROLE;
SQL

psql_cmd -f "$CONTRACT_MIGRATION"
assert_scalar '0|false|false|false|false' \
  "SELECT
     (SELECT pg_catalog.count(*)
        FROM pg_catalog.pg_proc AS function_row
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            function_row.proacl,
            pg_catalog.acldefault('f', function_row.proowner)
          )
        ) AS acl_entry
       WHERE function_row.oid =
         'public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text)'::regprocedure
         AND acl_entry.grantee <> function_row.proowner) || '|' ||
     pg_catalog.has_function_privilege(
       'service_role',
       'public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text)',
       'EXECUTE'
     )::text || '|' ||
     pg_catalog.has_function_privilege(
       'legacy_comment_reactor',
       'public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text)',
       'EXECUTE'
     )::text || '|' ||
     pg_catalog.has_function_privilege(
       'delegated_comment_reactor',
       'public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text)',
       'EXECUTE'
     )::text || '|' ||
     pg_catalog.has_function_privilege(
       'authenticated',
       'public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text)',
       'EXECUTE'
     )::text"

# legacy_service_execute_closed: a fully qualified direct legacy call is now
# denied by function ACL before its SECURITY DEFINER body can run.
assert_service_fails_42501 legacy_service_execute_closed \
  "SELECT public.set_comment_reaction_desired_state_atomic(
     '$ACTOR_ID', '$POST_ID', '$COMMENT_ID', 'dislike'
   )"

# causal_owner_composition_survives: service_role can still reserve and apply.
# The apply function executes as postgres and composes the retained owner-only
# four-argument authority, proving the intended nested path in real PG17.
assert_service 'issued|1' \
  "SELECT (result->>'status') || '|' || (result->>'intent_sequence')
     FROM (SELECT public.reserve_comment_reaction_intent_atomic(
       '$ACTOR_ID', '$POST_ID', '$COMMENT_ID', '$REQUEST_ID', 'dislike'
     ) AS result) AS reservation"
assert_service 'changed|dislike|1|false|0|1' \
  "SELECT (result->>'action') || '|' || (result->>'reaction') || '|' ||
          (result->>'intent_sequence') || '|' || (result->>'replayed') || '|' ||
          (result->>'like_count') || '|' || (result->>'dislike_count')
     FROM (SELECT public.set_comment_reaction_desired_state_causal_atomic(
       '$ACTOR_ID', '$POST_ID', '$COMMENT_ID', '$REQUEST_ID', 1, 'dislike'
     ) AS result) AS application"

# contract_migration_replay: an already owner-only legacy ACL is a valid,
# no-op input and the complete strict contract remains replayable.
psql_cmd -f "$CONTRACT_MIGRATION"
assert_scalar 'false|true|true|true' \
  "SELECT
     pg_catalog.has_function_privilege(
       'service_role',
       'public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text)',
       'EXECUTE'
     )::text || '|' ||
     pg_catalog.has_function_privilege(
       'service_role',
       'public.reserve_comment_reaction_intent_atomic(uuid,uuid,uuid,text,text)',
       'EXECUTE'
     )::text || '|' ||
     pg_catalog.has_function_privilege(
       'service_role',
       'public.set_comment_reaction_desired_state_causal_atomic(uuid,uuid,uuid,text,bigint,text)',
       'EXECUTE'
     )::text || '|' ||
     pg_catalog.has_function_privilege(
       'service_role',
       'public.cleanup_comment_reaction_intents_atomic(integer)',
       'EXECUTE'
     )::text"

# private_column_acl_drift_rejected: 1090 never blesses or repairs an altered
# 1080 private boundary; even an independently stored column ACL fails before
# the legacy function ACL is touched.
psql_cmd -c \
  'GRANT SELECT (actor_id) ON TABLE public.comment_reaction_intent_heads TO authenticated'
assert_migration_fails \
  private_column_acl_drift_rejected \
  'causal comment reaction private table boundary drifted'
psql_cmd -c \
  'REVOKE SELECT (actor_id) ON TABLE public.comment_reaction_intent_heads FROM authenticated'

# causal_acl_drift_rejected: causal entry points must remain the exact
# postgres-owner + service_role surface; unlike the intentional legacy ACL
# convergence, an unexpected causal grant is a fail-closed dependency drift.
psql_cmd -c \
  'GRANT EXECUTE ON FUNCTION public.reserve_comment_reaction_intent_atomic(uuid,uuid,uuid,text,text) TO legacy_comment_reactor'
assert_migration_fails \
  causal_acl_drift_rejected \
  'causal comment reaction function ACL drifted'
psql_cmd -c \
  'REVOKE EXECUTE ON FUNCTION public.reserve_comment_reaction_intent_atomic(uuid,uuid,uuid,text,text) FROM legacy_comment_reactor'

# causal_source_seal_drift_rejected: comments seal the exact executable body,
# so metadata-compatible replacement or comment tampering cannot be published.
psql_cmd -c \
  "COMMENT ON FUNCTION public.set_comment_reaction_desired_state_causal_atomic(
     uuid, uuid, uuid, text, bigint, text
   ) IS 'drifted'"
assert_migration_fails \
  causal_source_seal_drift_rejected \
  'comment reaction function source seal drifted'
psql_cmd <<'SQL'
DO $restore_causal_apply_seal$
DECLARE
  v_source text;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.set_comment_reaction_desired_state_causal_atomic(uuid,uuid,uuid,text,bigint,text)'::regprocedure;
  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION public.set_comment_reaction_desired_state_causal_atomic(uuid,uuid,uuid,text,bigint,text) IS %L',
    'comment-reaction-causal-intent:apply-v1:' || pg_catalog.md5(v_source)
  );
END
$restore_causal_apply_seal$;
SQL

# resealed_body_drift_rejected: an owner-level attacker cannot replace a body
# and bless it by recomputing the comment from that altered prosrc. The
# contract pins the reviewed digest independently of the live self-seal.
psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION public.cleanup_comment_reaction_intents_atomic(
  p_limit integer DEFAULT 500
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '15s'
AS $function$
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'operations_deleted', 0,
    'heads_deleted', 0
  );
END
$function$;

DO $reseal_modified_cleanup$
DECLARE
  v_source text;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.cleanup_comment_reaction_intents_atomic(integer)'::regprocedure;
  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION public.cleanup_comment_reaction_intents_atomic(integer) IS %L',
    'comment-reaction-causal-intent:cleanup-v1:' || pg_catalog.md5(v_source)
  );
END
$reseal_modified_cleanup$;
SQL
assert_migration_fails \
  resealed_body_drift_rejected \
  'comment reaction function source seal drifted'

# Restore the canonical expansion in the disposable database. 1080 requires
# its rolling-compatibility grant during preflight; 1090 immediately closes it
# again after the canonical body and reviewed seal have been restored.
psql_cmd -c \
  'GRANT EXECUTE ON FUNCTION public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text) TO service_role'
psql_cmd -f "$CAUSAL_MIGRATION"
psql_cmd -f "$CONTRACT_MIGRATION"

# unexpected_overload_rejected: exact reviewed names/signatures are pinned;
# adding even an owner-only overload aborts contract publication.
psql_cmd <<'SQL'
CREATE FUNCTION public.cleanup_comment_reaction_intents_atomic(bigint)
RETURNS jsonb
LANGUAGE sql
AS $function$
  SELECT '{}'::jsonb
$function$;
SQL
assert_migration_fails \
  unexpected_overload_rejected \
  'function surface is not the reviewed closed set'
psql_cmd -c \
  'DROP FUNCTION public.cleanup_comment_reaction_intents_atomic(bigint)'

psql_cmd -f "$CONTRACT_MIGRATION"

echo 'legacy comment reaction desired-state closure PG17 proof passed'
