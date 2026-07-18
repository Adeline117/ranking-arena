#!/usr/bin/env bash

# Audited production cutover runner for the July B2C launch hardening chain.
#
# Usage:
#   DATABASE_URL=... scripts/maintenance/apply-launch-migrations.sh status
#   DATABASE_URL=... scripts/maintenance/apply-launch-migrations.sh dry-run-all
#   ARENA_PRODUCTION_MIGRATION_CONFIRM=APPLY_PREDEPLOY \
#     DATABASE_URL=... scripts/maintenance/apply-launch-migrations.sh apply-predeploy
#   ARENA_PRODUCTION_MIGRATION_CONFIRM=APPLY_POSTDEPLOY \
#     DATABASE_URL=... scripts/maintenance/apply-launch-migrations.sh apply-postdeploy
#
# Every phase is one outer transaction. Migration files keep their original
# BEGIN/COMMIT in the ledger, while only those two outer statements are stripped
# from the executable stream. Any migration or ledger failure rolls back the
# whole phase.

set -Eeuo pipefail

ROOT="$(git rev-parse --show-toplevel)"
MIGRATIONS_DIR="$ROOT/supabase/migrations"

PREDEPLOY_MIGRATIONS=(
  20260716111600_atomic_group_application_review.sql
  20260716111700_group_application_read_write_boundary.sql
  20260716111800_group_creation_membership_write_boundary.sql
  20260716112100_channel_membership_server_boundary.sql
  20260716112300_atomic_content_report_submission.sql
  20260716113800_private_report_evidence_storage.sql
  20260716113900_atomic_group_membership.sql
  20260716114000_atomic_direct_message_send.sql
  20260716114100_atomic_group_member_moderation.sql
  20260716114200_atomic_direct_message_delete.sql
  20260716114500_atomic_comment_block_authorization.sql
  20260716114600_group_membership_identity_guard.sql
  20260716114700_atomic_group_join_requests.sql
  20260716114800_atomic_group_invites.sql
  20260716114900_atomic_deleted_account_group_purge.sql
  20260716152647_atomic_existing_channel_member_add.sql
  20260716154731_atomic_report_moderation_queue.sql
  20260716160000_report_moderation_operation_id.sql
  20260716161000_atomic_group_channel_create.sql
  20260716163000_atomic_single_report_resolution.sql
  20260716164000_group_application_operation_replay.sql
  20260716165000_atomic_group_mute.sql
  20260716170000_group_edit_application_operation_replay.sql
  20260716171000_group_member_read_privacy.sql
  20260716172000_group_subscriptions_server_authority.sql
  20260716173000_group_audit_log_read_boundary.sql
  20260716174000_group_subscription_expiry_owner_compat.sql
  20260716175000_atomic_group_dissolution.sql
  20260716176000_atomic_group_pass.sql
  20260716176100_group_premium_entitlement.sql
  20260716177000_atomic_pro_official_groups.sql
  20260716178000_user_profile_write_authority.sql
  20260716178100_atomic_post_child_interactions.sql
  20260716179000_user_profile_handle_contract.sql
  20260716179100_user_profile_read_audience.sql
  20260716179200_user_profile_wallet_authority.sql
  20260716190000_atomic_user_follow.sql
  20260716191000_atomic_user_block.sql
  20260717220000_notification_read_authority.sql
  20260717222500_notification_type_contract.sql
)

# This contract revokes the compatibility writes used by the old follow/block
# routes. It must run only after the target application is serving production.
POSTDEPLOY_MIGRATIONS=(
  20260716192000_social_edge_write_contract.sql
)

require_environment() {
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "DATABASE_URL is required" >&2
    exit 1
  fi
  if ! command -v psql >/dev/null 2>&1; then
    echo "psql is required" >&2
    exit 1
  fi
}

migration_version() {
  printf '%s' "${1%%_*}"
}

migration_name() {
  local without_extension="${1%.sql}"
  printf '%s' "${without_extension#*_}"
}

validate_migration_file() {
  local migration="$1"
  local file="$MIGRATIONS_DIR/$migration"
  local begin_count
  local commit_count

  [[ -f "$file" ]] || {
    echo "migration file is missing: $migration" >&2
    exit 1
  }
  begin_count="$(rg -c '^BEGIN;$' "$file" || true)"
  commit_count="$(rg -c '^COMMIT;$' "$file" || true)"
  if [[ "$begin_count" != "1" || "$commit_count" != "1" ]]; then
    echo "migration must contain one exact outer BEGIN/COMMIT: $migration" >&2
    exit 1
  fi
}

emit_ledger_absence_preflight() {
  local version="$1"
  local tag="arena_ledger_preflight_${version}"
  printf '%s\n' \
    "DO \$$tag\$" \
    'BEGIN' \
    "  IF EXISTS (" \
    "    SELECT 1 FROM supabase_migrations.schema_migrations" \
    "    WHERE version = '$version'" \
    "  ) THEN" \
    "    RAISE EXCEPTION 'migration ledger version already exists: $version';" \
    "  END IF;" \
    'END' \
    "\$$tag\$;"
}

emit_ledger_insert() {
  local migration="$1"
  local version
  local name
  local hash
  local tag
  local file="$MIGRATIONS_DIR/$migration"

  version="$(migration_version "$migration")"
  name="$(migration_name "$migration")"
  hash="$(shasum -a 256 "$file" | awk '{print $1}')"
  tag="arena_ledger_body_${version}"

  if rg -F -q "\$$tag\$" "$file"; then
    echo "ledger dollar-quote tag collides with migration: $migration" >&2
    exit 1
  fi

  printf '%s' \
    "INSERT INTO supabase_migrations.schema_migrations" \
    " (version, statements, name, created_by, idempotency_key)" \
    " VALUES ('$version', ARRAY[\$$tag\$"
  perl -0pe '' "$file"
  printf '%s\n' \
    "\$$tag\$]::text[], '$name', 'codex'," \
    " 'codex:$version:$hash');"
}

emit_migration() {
  local migration="$1"
  local version
  local file="$MIGRATIONS_DIR/$migration"
  validate_migration_file "$migration"
  version="$(migration_version "$migration")"

  printf '\\echo APPLY %s\n' "$migration"
  emit_ledger_absence_preflight "$version"
  perl -0pe 's/(^|\n)BEGIN;\n/$1/; s/\nCOMMIT;\s*\z/\n/' "$file"
  printf '%s\n' \
    'SET LOCAL search_path TO DEFAULT;' \
    'SET LOCAL lock_timeout TO DEFAULT;' \
    'SET LOCAL statement_timeout TO DEFAULT;'
  emit_ledger_insert "$migration"
}

emit_predeploy_ledger_requirement() {
  local versions=()
  local migration
  local quoted
  for migration in "${PREDEPLOY_MIGRATIONS[@]}"; do
    versions+=("'$(migration_version "$migration")'")
  done
  quoted="$(IFS=,; printf '%s' "${versions[*]}")"

  printf '%s\n' \
    'DO $arena_predeploy_requirement$' \
    'DECLARE' \
    '  v_recorded integer;' \
    'BEGIN' \
    '  SELECT pg_catalog.count(*)' \
    '  INTO STRICT v_recorded' \
    '  FROM supabase_migrations.schema_migrations' \
    "  WHERE version IN ($quoted);" \
    "  IF v_recorded <> ${#PREDEPLOY_MIGRATIONS[@]} THEN" \
    "    RAISE EXCEPTION 'postdeploy requires all predeploy ledger rows: found %/${#PREDEPLOY_MIGRATIONS[@]}', v_recorded;" \
    '  END IF;' \
    'END' \
    '$arena_predeploy_requirement$;'
}

emit_transaction() {
  local terminal="$1"
  shift
  local migration

  printf '%s\n' \
    'BEGIN;' \
    "SET LOCAL client_min_messages = 'warning';"
  for migration in "$@"; do
    emit_migration "$migration"
  done
  printf '%s\n' "$terminal;"
}

emit_all_dry_run() {
  local migration

  printf '%s\n' \
    'BEGIN;' \
    "SET LOCAL client_min_messages = 'warning';"
  for migration in "${PREDEPLOY_MIGRATIONS[@]}"; do
    emit_migration "$migration"
  done
  emit_predeploy_ledger_requirement
  for migration in "${POSTDEPLOY_MIGRATIONS[@]}"; do
    emit_migration "$migration"
  done
  printf '%s\n' 'ROLLBACK;'
}

status() {
  local migration
  local phase
  {
    printf '%s\n' 'WITH target(version, phase, ordinal) AS (VALUES'
    local ordinal=0
    local separator=''
    for phase in predeploy postdeploy; do
      local -a phase_migrations
      if [[ "$phase" == "predeploy" ]]; then
        phase_migrations=("${PREDEPLOY_MIGRATIONS[@]}")
      else
        phase_migrations=("${POSTDEPLOY_MIGRATIONS[@]}")
      fi
      for migration in "${phase_migrations[@]}"; do
        ordinal=$((ordinal + 1))
        printf "%s  ('%s', '%s', %d)" \
          "$separator" "$(migration_version "$migration")" "$phase" "$ordinal"
        separator=$',\n'
      done
    done
    printf '%s\n' \
      ')' \
      "SELECT target.phase || '|' || target.version || '|' ||" \
      "  CASE WHEN ledger.version IS NULL THEN 'missing' ELSE 'recorded' END" \
      'FROM target' \
      'LEFT JOIN supabase_migrations.schema_migrations AS ledger USING (version)' \
      'ORDER BY target.ordinal;'
  } | psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -At
}

run_sql_stream() {
  psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1
}

main() {
  require_environment
  local command="${1:-status}"
  case "$command" in
    status)
      status
      ;;
    dry-run-all)
      emit_all_dry_run | run_sql_stream
      ;;
    apply-predeploy)
      if [[ "${ARENA_PRODUCTION_MIGRATION_CONFIRM:-}" != "APPLY_PREDEPLOY" ]]; then
        echo "set ARENA_PRODUCTION_MIGRATION_CONFIRM=APPLY_PREDEPLOY" >&2
        exit 1
      fi
      emit_transaction 'COMMIT' "${PREDEPLOY_MIGRATIONS[@]}" | run_sql_stream
      ;;
    apply-postdeploy)
      if [[ "${ARENA_PRODUCTION_MIGRATION_CONFIRM:-}" != "APPLY_POSTDEPLOY" ]]; then
        echo "set ARENA_PRODUCTION_MIGRATION_CONFIRM=APPLY_POSTDEPLOY" >&2
        exit 1
      fi
      {
        printf '%s\n' \
          'BEGIN;' \
          "SET LOCAL client_min_messages = 'warning';"
        emit_predeploy_ledger_requirement
        local migration
        for migration in "${POSTDEPLOY_MIGRATIONS[@]}"; do
          emit_migration "$migration"
        done
        printf '%s\n' 'COMMIT;'
      } | run_sql_stream
      ;;
    *)
      echo "usage: $0 {status|dry-run-all|apply-predeploy|apply-postdeploy}" >&2
      exit 2
      ;;
  esac
}

main "$@"
