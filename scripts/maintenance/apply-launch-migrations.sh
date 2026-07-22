#!/usr/bin/env bash

# Launch migration diagnostics and dormant ordered-channel candidate.
#
# Usage:
#   DATABASE_URL=... scripts/maintenance/apply-launch-migrations.sh status
#   DATABASE_URL=... scripts/maintenance/apply-launch-migrations.sh dry-run-all
#   DATABASE_URL=... scripts/maintenance/apply-launch-migrations.sh \
#     dry-run-predeploy-one 20260721120000_metric_trust_shadow_gate.sql
#   ARENA_PRODUCTION_MIGRATION_CONFIRM=APPLY_PREDEPLOY_ONE_20260721120000 \
#     ARENA_PRODUCTION_MIGRATION_BODY_SHA256=<exact-file-sha256> \
#     ARENA_PRODUCTION_RELEASE_SHA=<full-origin-main-sha> \
#     ARENA_PRODUCTION_PROJECT_REF=iknktzifjdyujdccyhsv \
#     ARENA_ORDERED_PSQL_CHANNEL_APPROVAL=ADR_023_FUTURE_ADDENDUM_ORDERED_PSQL_V1_APPROVED \
#     DATABASE_URL=... scripts/maintenance/apply-launch-migrations.sh \
#     apply-predeploy-one 20260721120000_metric_trust_shadow_gate.sql
#   DATABASE_URL=... scripts/maintenance/apply-launch-migrations.sh dry-run-recovery
#   ARENA_PRODUCTION_MIGRATION_CONFIRM=APPLY_PREDEPLOY_ONE_20260721210000 \
#     ARENA_PRODUCTION_MIGRATION_BODY_SHA256=<exact-file-sha256> \
#     ARENA_PRODUCTION_RELEASE_SHA=<full-origin-main-sha> \
#     ARENA_PRODUCTION_PROJECT_REF=iknktzifjdyujdccyhsv \
#     ARENA_ORDERED_PSQL_CHANNEL_APPROVAL=ADR_023_FUTURE_ADDENDUM_ORDERED_PSQL_V1_APPROVED \
#     ARENA_TIP_CHECKOUT_CUTOVER_CONFIRM=TIP_CHECKOUT_FROZEN_PENDING_ZERO \
#     DATABASE_URL=... scripts/maintenance/apply-launch-migrations.sh \
#     apply-predeploy-one 20260721210000_tip_checkout_lifecycle_atomic.sql
#   Legacy predeploy/postdeploy/recovery write commands are disabled pending
#   production-channel governance.
#
# The psql-backed single-predeploy command is a dormant candidate break-glass
# channel, not an approved production path. ADR-023 keeps Supabase MCP
# apply_migration as the only approved channel until a future addendum adopts
# this candidate and authorizes its separate governance literal. Candidate
# predeploy is intentionally ordered and single-file. Its session lock is
# acquired before BEGIN so a repeatable-read target cannot take an old snapshot
# while waiting. Migration files keep their original transaction statements in
# the ledger. Exact rows are skipped as new launch migrations are appended,
# while drift always fails closed.

set -Eeuo pipefail

ROOT="$(git rev-parse --show-toplevel)"
MIGRATIONS_DIR="$ROOT/supabase/migrations"
PRODUCTION_PROJECT_REF='iknktzifjdyujdccyhsv'
ORDERED_PSQL_CHANNEL_APPROVAL='ADR_023_FUTURE_ADDENDUM_ORDERED_PSQL_V1_APPROVED'

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
  20260717130000_hero_stats_count_live_source_boards.sql
  20260717220000_notification_read_authority.sql
  20260717222500_notification_type_contract.sql
  20260718120000_leaderboard_source_freshness.sql
  20260718123000_shadow_sources_without_roi_basis.sql
  20260718130000_count_trader_account_followers.sql
  20260718131000_source_scope_trader_follow_activity.sql
  20260718132000_active_source_platform_freshness.sql
  20260718133000_history_partition_range_guard.sql
  20260718134000_freshness_expected_sources.sql
  20260718135000_partition_child_rls_convergence.sql
  20260718140000_add_metric_completeness_daily.sql
  20260718182917_arena_resolver_fetch_region.sql
  20260718183000_atomic_stripe_entitlement_identity.sql
  20260718183500_harden_stripe_entitlement_null_validation.sql
  20260718183600_fix_stripe_lifetime_duplicate_and_early_expiry.sql
  20260718184000_arena_score_inputs_board_as_of.sql
  20260718184500_classify_non_entitlement_stripe_payments.sql
  20260718184550_durable_tip_completion_notification.sql
  20260721120000_metric_trust_shadow_gate.sql
  20260721130000_raw_object_gc_outbox.sql
  20260721140000_idempotent_equivalent_refund_events.sql
  20260721150000_metric_trust_raw_artifact_identity.sql
  20260721175746_arena_score_inputs_publish_bundle.sql
  20260721210000_tip_checkout_lifecycle_atomic.sql
  20260721211000_tip_checkout_completion_identity.sql
  20260722030000_durable_leaderboard_acquisition_attempt_ledger.sql
  20260722040000_leaderboard_acquisition_manifest_v3_compat.sql
  20260722041000_pure_arena_score_v4_scorer.sql
  20260722042000_leaderboard_terminal_publication_fence.sql
  20260722050000_metric_trust_attempt_outcome_authority.sql
  20260722051000_leaderboard_score_input_manifest_contract.sql
  20260722052000_leaderboard_score_input_manifest_rank_eligible_pnl.sql
)

TIP_CHECKOUT_CUTOVER_VERSIONS=(
  20260721210000
  20260721211000
)
TIP_CHECKOUT_CUTOVER_ATTESTATION='TIP_CHECKOUT_FROZEN_PENDING_ZERO'

# These contracts revoke compatibility writes or change identity uniqueness
# used by old routes. They must run only after the target application is serving
# production.
POSTDEPLOY_MIGRATIONS=(
  20260716192000_social_edge_write_contract.sql
  20260717120000_trader_follows_composite_identity.sql
)

# Recovery repairs the immutable application snapshot whose original cutover
# was exactly these 41 migrations. Keep this prerequisite frozen: later launch
# additions must not delay an independently resumable recovery.
RECOVERY_PREREQUISITE_MIGRATIONS=(
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
  20260716192000_social_edge_write_contract.sql
)

# These index migrations were present in the immutable target application
# snapshot but omitted from the original cutover manifest. PostgreSQL forbids
# CREATE INDEX CONCURRENTLY inside a transaction, so each file runs in its own
# resumable autocommit session and receives its exact-body ledger row only after
# every index postflight succeeds.
CONCURRENT_RECOVERY_MIGRATIONS=(
  20260716090000_add_account_export_cursor_indexes.sql
  20260716091500_add_security_export_cursor_indexes.sql
  20260716094500_add_bookmark_export_cursor_indexes.sql
  20260716101500_add_interaction_export_cursor_indexes.sql
  20260716110000_add_domain_export_cursor_indexes.sql
)

# These transactional migrations were also present in the immutable target
# application snapshot but omitted from the original cutover manifest. Apply
# them only after all 41 original cutover ledger rows exist. Each migration and
# its exact-body ledger row commit together in a short, resumable transaction so
# unrelated table locks are never held across the whole recovery phase.
RECOVERY_MIGRATIONS=(
  20260716112000_exchange_connections_server_only.sql
  20260716112200_atomic_impression_recording.sql
  20260716083256_repair_legacy_exchange_logo_paths.sql
)

# Do not replay this older collection boundary. The separately applied
# 20260717230000 migration replaces its policies with current-owner/current-
# resource audience checks and atomic service-only writes.
SUPERSEDED_MIGRATIONS=(
  20260716104500_collection_read_write_boundaries.sql
)

require_environment() {
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "DATABASE_URL is required" >&2
    exit 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "node is required" >&2
    exit 1
  fi
  if ! command -v psql >/dev/null 2>&1; then
    echo "psql is required" >&2
    exit 1
  fi
}

# PGDATABASE is a literal database name, not a connection-URI expansion point.
# Parse DATABASE_URL in the wrapper and pass only individual libpq environment
# variables to psql. The credential never enters psql's argv.
psql_with_database() {
  node "$ROOT/scripts/maintenance/psql-from-database-url.mjs" "$@"
}

require_session_connection() {
  node "$ROOT/scripts/maintenance/psql-from-database-url.mjs" \
    --check-session-connection
}

migration_version() {
  printf '%s' "${1%%_*}"
}

migration_name() {
  local without_extension="${1%.sql}"
  printf '%s' "${without_extension#*_}"
}

validate_transactional_migration_file() {
  local migration="$1"
  local file="$MIGRATIONS_DIR/$migration"
  local begin_count
  local commit_count
  local transaction_mode_count
  local repeatable_read_count

  [[ -f "$file" ]] || {
    echo "migration file is missing: $migration" >&2
    exit 1
  }
  begin_count="$(rg -c '^BEGIN;$' "$file" || true)"
  commit_count="$(rg -c '^COMMIT;$' "$file" || true)"
  transaction_mode_count="$(rg -c '^SET TRANSACTION ' "$file" || true)"
  repeatable_read_count="$(
    rg -c '^SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;$' "$file" || true
  )"
  transaction_mode_count="${transaction_mode_count:-0}"
  repeatable_read_count="${repeatable_read_count:-0}"
  if [[ "$begin_count" != "1" || "$commit_count" != "1" ]]; then
    echo "migration must contain one exact outer BEGIN/COMMIT: $migration" >&2
    exit 1
  fi
  if ((transaction_mode_count != repeatable_read_count || repeatable_read_count > 1)); then
    echo "migration has an unsupported transaction mode: $migration" >&2
    exit 1
  fi
}

transaction_begin_for_migrations() {
  local migration
  local begin_statement='BEGIN;'

  for migration in "$@"; do
    validate_transactional_migration_file "$migration"
    if rg -q '^SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;$' \
      "$MIGRATIONS_DIR/$migration"; then
      begin_statement='BEGIN ISOLATION LEVEL REPEATABLE READ;'
    fi
  done

  printf '%s' "$begin_statement"
}

validate_concurrent_migration_file() {
  local migration="$1"
  local file="$MIGRATIONS_DIR/$migration"
  local begin_count
  local commit_count
  local concurrent_count

  [[ -f "$file" ]] || {
    echo "migration file is missing: $migration" >&2
    exit 1
  }
  begin_count="$(rg -c '^BEGIN;$' "$file" || true)"
  commit_count="$(rg -c '^COMMIT;$' "$file" || true)"
  concurrent_count="$(rg -c '^CREATE INDEX CONCURRENTLY ' "$file" || true)"
  if [[ -n "$begin_count" || -n "$commit_count" || -z "$concurrent_count" ]]; then
    echo "concurrent migration must have CREATE INDEX CONCURRENTLY and no outer transaction: $migration" >&2
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

emit_ledger_exact_preflight() {
  local migration="$1"
  local phase="${2:-migration}"
  local version
  local name
  local hash
  local tag
  local file="$MIGRATIONS_DIR/$migration"

  version="$(migration_version "$migration")"
  name="$(migration_name "$migration")"
  hash="$(shasum -a 256 "$file" | awk '{print $1}')"
  tag="arena_ledger_exact_${version}"

  # Re-attest and lock an exact ledger row inside the migration transaction.
  # The host-side status check decides whether to emit a migration, but it
  # cannot protect the interval before psql begins the transaction.
  printf '%s\n' \
    "DO \$$tag\$" \
    'BEGIN' \
    '  PERFORM 1' \
    '  FROM supabase_migrations.schema_migrations AS ledger' \
    "  WHERE ledger.version = '$version'" \
    "    AND ledger.name = '$name'" \
    "    AND ledger.created_by = 'codex'" \
    "    AND ledger.idempotency_key = 'codex:$version:$hash'" \
    '    AND pg_catalog.array_length(ledger.statements, 1) = 1' \
    '    AND pg_catalog.encode(' \
    "      extensions.digest(ledger.statements[1], 'sha256')," \
    "      'hex'" \
    "    ) = '$hash'" \
    '  FOR SHARE;' \
    '  IF NOT FOUND THEN' \
    "    RAISE EXCEPTION '$phase requires exact ledger: $migration';" \
    '  END IF;' \
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
  validate_transactional_migration_file "$migration"
  version="$(migration_version "$migration")"

  printf '\\echo APPLY %s\n' "$migration"
  emit_ledger_absence_preflight "$version"
  # The exact outer COMMIT may be followed by rollback documentation. Strip
  # the validated transaction statements wherever their exact lines occur;
  # otherwise a dry run could change isolation too late or commit before the
  # runner emits its terminal ROLLBACK.
  perl -0pe \
    's/(^|\n)BEGIN;\n/$1/; s/(^|\n)SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;\n/$1/; s/(^|\n)COMMIT;(?:\n|\z)/$1/' \
    "$file"
  printf '%s\n' \
    'SET LOCAL search_path TO DEFAULT;' \
    'SET LOCAL lock_timeout TO DEFAULT;' \
    'SET LOCAL statement_timeout TO DEFAULT;'
  emit_ledger_insert "$migration"
}

emit_pending_migration() {
  local migration="$1"
  local state

  validate_transactional_migration_file "$migration"
  state="$(ledger_state "$migration")"
  if [[ "$state" == "exact" ]]; then
    printf '\\echo SKIP exact ledger: %s\n' "$migration"
    emit_ledger_exact_preflight "$migration"
    return
  fi
  if [[ "$state" != "missing" ]]; then
    echo "refusing drifted ledger: $migration" >&2
    exit 1
  fi
  emit_migration "$migration"
}

require_exact_migrations() {
  local phase="$1"
  shift
  local migration
  local state

  for migration in "$@"; do
    validate_transactional_migration_file "$migration"
    state="$(ledger_state "$migration")"
    if [[ "$state" != "exact" ]]; then
      echo "$phase requires exact ledger: $migration ($state)" >&2
      exit 1
    fi
  done
}

require_predeploy_target() {
  local target="$1"
  local migration

  for migration in "${PREDEPLOY_MIGRATIONS[@]}"; do
    if [[ "$migration" == "$target" ]]; then
      return
    fi
  done
  echo "predeploy target is not in the ordered candidate manifest: $target" >&2
  exit 2
}

require_tracked_migration() {
  local migration="$1"
  local relative_path="supabase/migrations/$migration"

  if ! git -C "$ROOT" ls-files --error-unmatch -- "$relative_path" >/dev/null 2>&1; then
    echo "predeploy target must be tracked by git: $relative_path" >&2
    exit 1
  fi
}

require_production_project_ref() {
  EXPECTED_PROJECT_REF="$PRODUCTION_PROJECT_REF" node <<'NODE'
const expected = process.env.EXPECTED_PROJECT_REF
let parsed
try {
  parsed = new URL(process.env.DATABASE_URL)
} catch {
  process.stderr.write('single predeploy requires a valid production DATABASE_URL\n')
  process.exit(1)
}
const host = parsed.hostname.toLowerCase()
let username
let database
try {
  username = decodeURIComponent(parsed.username)
  database = decodeURIComponent(parsed.pathname)
} catch {
  process.stderr.write('single predeploy requires a valid production DATABASE_URL\n')
  process.exit(1)
}
const isPostgresProtocol = parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:'
const isSessionPort = parsed.port === '5432'
const isPostgresDatabase = database === '/postgres'
const sslModes = parsed.searchParams.getAll('sslmode')
const hasVerifiedTls = sslModes.length === 1 && sslModes[0] === 'verify-full'
const isDirect = host === `db.${expected}.supabase.co` && username === 'postgres'
const isPooler =
  host === 'aws-0-us-west-2.pooler.supabase.com' && username === `postgres.${expected}`
if (
  !isPostgresProtocol ||
  !isSessionPort ||
  !isPostgresDatabase ||
  !hasVerifiedTls ||
  (!isDirect && !isPooler)
) {
  process.stderr.write('single predeploy requires the exact production session endpoint\n')
  process.exit(1)
}
NODE
}

require_ordered_psql_channel_approval() {
  if [[ "${ARENA_ORDERED_PSQL_CHANNEL_APPROVAL:-}" != \
    "$ORDERED_PSQL_CHANNEL_APPROVAL" ]]; then
    echo \
      "ordered psql candidate is dormant pending an ADR-023 addendum; channel approval is absent" \
      >&2
    exit 1
  fi
}

require_release_provenance() {
  local migration="$1"
  local head_sha
  local origin_main_sha
  local remote_main_line
  local remote_main_sha
  local dirty

  require_tracked_migration "$migration"
  dirty="$(git -C "$ROOT" status --porcelain=v1 --untracked-files=all)"
  if [[ -n "$dirty" ]]; then
    echo "single predeploy requires a clean worktree" >&2
    exit 1
  fi
  head_sha="$(git -C "$ROOT" rev-parse --verify HEAD)"
  origin_main_sha="$(git -C "$ROOT" rev-parse --verify refs/remotes/origin/main)"
  if [[ "$head_sha" != "$origin_main_sha" ]]; then
    echo "single predeploy requires HEAD to equal the pushed origin/main SHA" >&2
    exit 1
  fi
  if ! remote_main_line="$(
    GIT_TERMINAL_PROMPT=0 git -C "$ROOT" ls-remote --exit-code origin refs/heads/main 2>/dev/null
  )"; then
    echo "single predeploy could not verify the live origin/main SHA" >&2
    exit 1
  fi
  remote_main_sha="$(printf '%s\n' "$remote_main_line" | awk 'NR == 1 {print $1}')"
  if [[ ! "$remote_main_sha" =~ ^[0-9a-f]{40,64}$ || "$head_sha" != "$remote_main_sha" ]]; then
    echo "single predeploy requires HEAD to equal the live pushed origin/main SHA" >&2
    exit 1
  fi
  require_production_project_ref
}

require_single_predeploy_confirmation() {
  local migration="$1"
  local version
  local body_sha
  local head_sha
  local confirmation

  version="$(migration_version "$migration")"
  body_sha="$(shasum -a 256 "$MIGRATIONS_DIR/$migration" | awk '{print $1}')"
  head_sha="$(git -C "$ROOT" rev-parse --verify HEAD)"
  confirmation="APPLY_PREDEPLOY_ONE_$version"
  if [[ "${ARENA_PRODUCTION_MIGRATION_CONFIRM:-}" != "$confirmation" ]]; then
    echo "set ARENA_PRODUCTION_MIGRATION_CONFIRM=$confirmation" >&2
    exit 1
  fi
  if [[ "${ARENA_PRODUCTION_MIGRATION_BODY_SHA256:-}" != "$body_sha" ]]; then
    echo "set ARENA_PRODUCTION_MIGRATION_BODY_SHA256=$body_sha" >&2
    exit 1
  fi
  if [[ "${ARENA_PRODUCTION_RELEASE_SHA:-}" != "$head_sha" ]]; then
    echo "set ARENA_PRODUCTION_RELEASE_SHA=$head_sha" >&2
    exit 1
  fi
  if [[ "${ARENA_PRODUCTION_PROJECT_REF:-}" != "$PRODUCTION_PROJECT_REF" ]]; then
    echo "set ARENA_PRODUCTION_PROJECT_REF=$PRODUCTION_PROJECT_REF" >&2
    exit 1
  fi
}

ORDERED_PREDEPLOY_PREREQUISITES=()

prepare_ordered_predeploy_target() {
  local target="$1"
  local migration
  local state

  require_predeploy_target "$target"
  require_release_provenance "$target"
  ORDERED_PREDEPLOY_PREREQUISITES=()
  for migration in "${PREDEPLOY_MIGRATIONS[@]}"; do
    validate_transactional_migration_file "$migration"
    state="$(ledger_state "$migration")"
    case "$state" in
      exact)
        ORDERED_PREDEPLOY_PREREQUISITES+=("$migration")
        ;;
      missing)
        if [[ "$migration" != "$target" ]]; then
          echo \
            "predeploy target must be the first missing migration: requested $target, first missing $migration" \
            >&2
          exit 1
        fi
        return
        ;;
      *)
        echo "refusing drifted predeploy ledger before target: $migration ($state)" >&2
        exit 1
        ;;
    esac
  done

  echo "predeploy manifest has no missing migration; requested target is not pending: $target" >&2
  exit 1
}

require_tip_checkout_cutover_attestation() {
  if [[ "${ARENA_TIP_CHECKOUT_CUTOVER_CONFIRM:-}" != \
    "$TIP_CHECKOUT_CUTOVER_ATTESTATION" ]]; then
    echo \
      "Tip checkout lifecycle apply is blocked: freeze the old Tip checkout route, verify pending Tips are zero, then set ARENA_TIP_CHECKOUT_CUTOVER_CONFIRM=$TIP_CHECKOUT_CUTOVER_ATTESTATION" \
      >&2
    exit 1
  fi
}

require_tip_checkout_cutover_for_target() {
  local migration="$1"
  local version
  local protected_version
  version="$(migration_version "$migration")"
  for protected_version in "${TIP_CHECKOUT_CUTOVER_VERSIONS[@]}"; do
    if [[ "$version" == "$protected_version" ]]; then
      require_tip_checkout_cutover_attestation
      return
    fi
  done
}

emit_concurrent_migration() {
  local migration="$1"
  local version
  local file="$MIGRATIONS_DIR/$migration"
  local lock_key

  validate_concurrent_migration_file "$migration"
  version="$(migration_version "$migration")"
  lock_key="arena:concurrent-recovery:$version"

  printf '\\echo APPLY %s\n' "$migration"
  printf '%s\n' \
    "SELECT pg_catalog.pg_advisory_lock(" \
    "  pg_catalog.hashtextextended('$lock_key', 0)" \
    ');'
  emit_ledger_absence_preflight "$version"
  perl -0pe '' "$file"
  emit_ledger_insert "$migration"
  printf '%s\n' \
    "SELECT pg_catalog.pg_advisory_unlock(" \
    "  pg_catalog.hashtextextended('$lock_key', 0)" \
    ');'
}

ledger_state() {
  local migration="$1"
  local version
  local name
  local hash

  version="$(migration_version "$migration")"
  name="$(migration_name "$migration")"
  hash="$(shasum -a 256 "$MIGRATIONS_DIR/$migration" | awk '{print $1}')"

  psql_with_database -X -q -v ON_ERROR_STOP=1 -Atc \
    "SELECT CASE
       WHEN ledger.version IS NULL THEN 'missing'
       WHEN ledger.name = '$name'
        AND ledger.created_by = 'codex'
        AND ledger.idempotency_key = 'codex:$version:$hash'
        AND pg_catalog.array_length(ledger.statements, 1) = 1
        AND pg_catalog.encode(
          extensions.digest(ledger.statements[1], 'sha256'),
          'hex'
        ) = '$hash'
       THEN 'exact'
       ELSE 'drift'
     END
     FROM (SELECT 1) AS seed
     LEFT JOIN supabase_migrations.schema_migrations AS ledger
       ON ledger.version = '$version';"
}

emit_predeploy_ledger_requirement() {
  local migration
  for migration in "${PREDEPLOY_MIGRATIONS[@]}"; do
    emit_ledger_exact_preflight "$migration" 'postdeploy'
  done
}

emit_cutover_ledger_requirement() {
  local migration
  for migration in "${RECOVERY_PREREQUISITE_MIGRATIONS[@]}"; do
    emit_ledger_exact_preflight "$migration" 'recovery'
  done
}

emit_transaction() {
  local terminal="$1"
  shift
  local migration
  local begin_statement

  begin_statement="$(transaction_begin_for_migrations "$@")"
  printf '%s\n' \
    "$begin_statement" \
    "SET LOCAL client_min_messages = 'warning';"
  for migration in "$@"; do
    emit_pending_migration "$migration"
  done
  printf '%s\n' "$terminal;"
}

emit_ordered_predeploy_transaction() {
  local terminal="$1"
  local target="$2"
  local migration
  local begin_statement
  local lock_key='arena:production-schema-migration'

  begin_statement="$(transaction_begin_for_migrations "$target")"
  # Take the session lock before BEGIN. A repeatable-read target must not
  # establish its snapshot and then wait behind another ordered apply.
  printf '%s\n' \
    "SET lock_timeout = '10s';" \
    "SET statement_timeout = '15min';" \
    "SELECT pg_catalog.pg_advisory_lock(" \
    "  pg_catalog.hashtextextended('$lock_key', 0)" \
    ');' \
    "$begin_statement" \
    "SET LOCAL lock_timeout = '10s';" \
    "SET LOCAL statement_timeout = '15min';" \
    "SET LOCAL idle_in_transaction_session_timeout = '60s';" \
    'LOCK TABLE supabase_migrations.schema_migrations' \
    '  IN SHARE ROW EXCLUSIVE MODE;' \
    "SET LOCAL client_min_messages = 'warning';"
  for migration in "${ORDERED_PREDEPLOY_PREREQUISITES[@]}"; do
    emit_ledger_exact_preflight "$migration" 'ordered predeploy'
  done
  emit_migration "$target"
  printf '%s\n' \
    "$terminal;" \
    'DO $arena_ordered_predeploy_unlock$' \
    'BEGIN' \
    '  IF NOT pg_catalog.pg_advisory_unlock(' \
    "    pg_catalog.hashtextextended('$lock_key', 0)" \
    '  ) THEN' \
    "    RAISE EXCEPTION 'ordered predeploy advisory unlock failed';" \
    '  END IF;' \
    'END' \
    '$arena_ordered_predeploy_unlock$;'
}

emit_all_dry_run() {
  local migration
  local begin_statement

  begin_statement="$(
    transaction_begin_for_migrations \
      "${PREDEPLOY_MIGRATIONS[@]}" \
      "${POSTDEPLOY_MIGRATIONS[@]}" \
      "${RECOVERY_MIGRATIONS[@]}"
  )"
  printf '%s\n' \
    "$begin_statement" \
    "SET LOCAL client_min_messages = 'warning';"
  for migration in "${PREDEPLOY_MIGRATIONS[@]}"; do
    emit_pending_migration "$migration"
  done
  emit_predeploy_ledger_requirement
  for migration in "${POSTDEPLOY_MIGRATIONS[@]}"; do
    emit_pending_migration "$migration"
  done
  emit_cutover_ledger_requirement
  for migration in "${RECOVERY_MIGRATIONS[@]}"; do
    emit_pending_migration "$migration"
  done
  printf '%s\n' 'ROLLBACK;'
}

status() {
  local migration
  local phase
  {
    printf '%s\n' \
      'WITH target(version, phase, ordinal, expected_name, expected_hash) AS (VALUES'
    local ordinal=0
    local separator=''
    for phase in predeploy postdeploy concurrent-recovery recovery superseded; do
      local -a phase_migrations
      if [[ "$phase" == "predeploy" ]]; then
        phase_migrations=("${PREDEPLOY_MIGRATIONS[@]}")
      elif [[ "$phase" == "postdeploy" ]]; then
        phase_migrations=("${POSTDEPLOY_MIGRATIONS[@]}")
      elif [[ "$phase" == "concurrent-recovery" ]]; then
        phase_migrations=("${CONCURRENT_RECOVERY_MIGRATIONS[@]}")
      elif [[ "$phase" == "recovery" ]]; then
        phase_migrations=("${RECOVERY_MIGRATIONS[@]}")
      else
        phase_migrations=("${SUPERSEDED_MIGRATIONS[@]}")
      fi
      for migration in "${phase_migrations[@]}"; do
        ordinal=$((ordinal + 1))
        local version
        local name
        local hash
        version="$(migration_version "$migration")"
        name="$(migration_name "$migration")"
        hash="$(shasum -a 256 "$MIGRATIONS_DIR/$migration" | awk '{print $1}')"
        printf "%s  ('%s', '%s', %d, '%s', '%s')" \
          "$separator" "$version" "$phase" "$ordinal" "$name" "$hash"
        separator=$',\n'
      done
    done
    printf '%s\n' \
      ')' \
      "SELECT target.phase || '|' || target.version || '|' ||" \
      "  CASE" \
      "    WHEN target.phase = 'superseded' AND EXISTS (" \
      "      SELECT 1 FROM supabase_migrations.schema_migrations AS replacement" \
      "      WHERE replacement.version = '20260717230000'" \
      "    ) THEN 'superseded-by-20260717230000'" \
      "    WHEN target.phase = 'superseded' THEN 'missing-superseder'" \
      "    WHEN ledger.version IS NULL THEN 'missing'" \
      "    WHEN ledger.name = target.expected_name" \
      "      AND ledger.created_by = 'codex'" \
      "      AND ledger.idempotency_key =" \
      "        'codex:' || target.version || ':' || target.expected_hash" \
      "      AND pg_catalog.array_length(ledger.statements, 1) = 1" \
      "      AND pg_catalog.encode(" \
      "        extensions.digest(ledger.statements[1], 'sha256')," \
      "        'hex'" \
      "      ) = target.expected_hash" \
      "    THEN 'exact'" \
      "    ELSE 'drift'" \
      "  END" \
      'FROM target' \
      'LEFT JOIN supabase_migrations.schema_migrations AS ledger USING (version)' \
      'ORDER BY target.ordinal;'
  } | psql_with_database -X -q -v ON_ERROR_STOP=1 -At
}

run_sql_stream() {
  psql_with_database -X -q -v ON_ERROR_STOP=1
}

main() {
  require_environment
  local command="${1:-status}"
  if [[ "$command" != "status" ]]; then
    require_session_connection
  fi
  case "$command" in
    status)
      status
      ;;
    dry-run-all)
      emit_all_dry_run | run_sql_stream
      ;;
    dry-run-predeploy-one)
      if [[ "$#" != "2" ]]; then
        echo "usage: $0 dry-run-predeploy-one <manifest-migration.sql>" >&2
        exit 2
      fi
      local migration="$2"
      prepare_ordered_predeploy_target "$migration"
      emit_ordered_predeploy_transaction 'ROLLBACK' "$migration" | run_sql_stream
      ;;
    dry-run-recovery)
      local migration
      local state
      local begin_statement
      require_exact_migrations \
        'recovery' \
        "${RECOVERY_PREREQUISITE_MIGRATIONS[@]}"
      for migration in "${RECOVERY_MIGRATIONS[@]}"; do
        validate_transactional_migration_file "$migration"
        state="$(ledger_state "$migration")"
        if [[ "$state" == "exact" ]]; then
          echo "SKIP exact ledger: $migration"
          continue
        fi
        if [[ "$state" != "missing" ]]; then
          echo "refusing drifted ledger: $migration" >&2
          exit 1
        fi
        begin_statement="$(transaction_begin_for_migrations "$migration")"
        {
          printf '%s\n' \
            "$begin_statement" \
            "SET LOCAL client_min_messages = 'warning';"
          emit_cutover_ledger_requirement
          emit_migration "$migration"
          printf '%s\n' 'ROLLBACK;'
        } | run_sql_stream
      done
      ;;
    apply-concurrent-recovery)
      echo "apply-concurrent-recovery is disabled by ADR-023 pending channel governance" >&2
      exit 2
      ;;
    apply-predeploy)
      echo \
        "apply-predeploy is disabled by ADR-023; use apply-predeploy-one for the first missing migration" \
        >&2
      exit 2
      ;;
    apply-predeploy-one)
      if [[ "$#" != "2" ]]; then
        echo "usage: $0 apply-predeploy-one <manifest-migration.sql>" >&2
        exit 2
      fi
      local migration="$2"
      require_predeploy_target "$migration"
      require_tracked_migration "$migration"
      require_ordered_psql_channel_approval
      require_single_predeploy_confirmation "$migration"
      require_tip_checkout_cutover_for_target "$migration"
      prepare_ordered_predeploy_target "$migration"
      echo "CANDIDATE BREAK-GLASS: applying one ordered predeploy migration" >&2
      emit_ordered_predeploy_transaction 'COMMIT' "$migration" | run_sql_stream
      ;;
    apply-postdeploy)
      echo "apply-postdeploy is disabled by ADR-023 pending channel governance" >&2
      exit 2
      ;;
    apply-recovery)
      echo "apply-recovery is disabled by ADR-023 pending channel governance" >&2
      exit 2
      ;;
    *)
      echo "usage: $0 {status|dry-run-all|dry-run-predeploy-one|dry-run-recovery|apply-concurrent-recovery|apply-predeploy|apply-predeploy-one|apply-postdeploy|apply-recovery}" >&2
      exit 2
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
