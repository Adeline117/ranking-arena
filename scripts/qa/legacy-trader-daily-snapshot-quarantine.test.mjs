import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const ROOT = resolve(import.meta.dirname, '../..')
const MIGRATION_PATH =
  'supabase/migrations/20260808090000_quarantine_legacy_trader_daily_snapshots.sql'
const PG17_PATH = 'supabase/migrations/__tests__/legacy-trader-daily-snapshot-quarantine.pg17.sh'

const migration = readFileSync(resolve(ROOT, MIGRATION_PATH), 'utf8')
const pg17 = readFileSync(resolve(ROOT, PG17_PATH), 'utf8')

test('daily snapshot quarantine is forward-only metadata/ACL work', () => {
  assert.match(migration, /\bBEGIN\s*;/u)
  assert.match(migration, /\bCOMMIT\s*;/u)
  assert.match(migration, /LOCK TABLE public\.trader_daily_snapshots IN ACCESS EXCLUSIVE MODE;/u)
  assert.match(migration, /ALTER TABLE public\.trader_daily_snapshots ENABLE ROW LEVEL SECURITY;/u)

  assert.doesNotMatch(
    migration,
    /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|COPY|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?public\.trader_daily_snapshots\b/iu
  )
  assert.doesNotMatch(
    migration,
    /\b(?:DROP|CREATE)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?public\.trader_daily_snapshots\b/iu
  )
  assert.doesNotMatch(
    migration,
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(?:cleanup_|exec_sql|get_latest_)/iu
  )
  assert.doesNotMatch(migration, /\bCASCADE\b/iu)
  assert.match(migration, /relation\.relispartition/u)
  assert.match(migration, /FROM pg_catalog\.pg_inherits AS inheritance/u)
  assert.match(migration, /must not be a partition child/u)
})

test('ACL mutations are limited to known application roles', () => {
  assert.match(
    migration,
    /REVOKE ALL PRIVILEGES\s+ON TABLE public\.trader_daily_snapshots\s+FROM PUBLIC, anon, authenticated, service_role;/u
  )
  assert.match(migration, /FROM PUBLIC, anon, authenticated, service_role',\s+v_column_list/u)
  assert.match(
    migration,
    /GRANT SELECT\s+ON TABLE public\.trader_daily_snapshots\s+TO service_role;/u
  )
  assert.match(
    migration,
    /SELECT WITH GRANT OPTION/u,
    'postflight must reject delegable service reads'
  )
  assert.match(
    migration,
    /FOREACH v_privilege IN ARRAY ARRAY\[\s*'INSERT',\s*'UPDATE',\s*'REFERENCES',\s*'SELECT WITH GRANT OPTION'\s*\][\s\S]*?has_column_privilege\(\s*'service_role'/u,
    'postflight must reject inherited column writes and delegable column reads'
  )
  assert.doesNotMatch(
    migration,
    /REVOKE ALL PRIVILEGES ON TABLE public\.trader_daily_snapshots '\s*\|\|\s*'FROM %s/u,
    'migration must not revoke unknown operator/backup table grantees'
  )
})

test('policy convergence fails closed on unknown live policy names', () => {
  for (const policy of [
    'trader_daily_snapshots_select_all',
    'trader_daily_snapshots_service_role_write',
    'Service role reads quarantined daily snapshots',
  ]) {
    assert.ok(migration.includes(policy), 'missing reviewed policy: ' + policy)
  }
  assert.match(migration, /unknown trader_daily_snapshots policies require operator review/u)
  assert.match(
    migration,
    /CREATE POLICY "Service role reads quarantined daily snapshots"[\s\S]*?FOR SELECT[\s\S]*?TO service_role[\s\S]*?USING \(true\);/u
  )
})

test('dependent owner-security views fail closed before ACL mutation', () => {
  assert.match(migration, /WITH RECURSIVE dependent_relations/u)
  assert.match(migration, /FROM pg_catalog\.pg_depend AS dependency/u)
  assert.match(migration, /JOIN pg_catalog\.pg_rewrite AS rewrite/u)
  assert.match(migration, /dependent_relation\.relkind IN \('v', 'm'\)/u)
  assert.match(migration, /has_table_privilege\([\s\S]*?v_dependent_relation\.relation_oid/u)
  assert.match(migration, /has_column_privilege\([\s\S]*?v_dependent_relation\.relation_oid/u)
  assert.match(migration, /dependent daily snapshot relation/u)
})

test('app-writable SECURITY DEFINER trigger paths fail closed without relying on EXECUTE ACLs', () => {
  assert.match(migration, /FROM pg_catalog\.pg_trigger AS trigger_row/u)
  assert.match(migration, /NOT trigger_row\.tgisinternal/u)
  assert.match(migration, /routine\.prosecdef/u)
  assert.match(migration, /routine_dependency\.refobjid = v_relation/u)
  assert.match(migration, /has_table_privilege\([\s\S]*?v_trigger\.trigger_relation_oid/u)
  assert.match(migration, /has_column_privilege\([\s\S]*?v_trigger\.trigger_relation_oid/u)
  assert.match(migration, /can fire SECURITY DEFINER daily snapshot trigger/u)
})

test('rewrite rules and referential actions are rejected as internal-authority writers', () => {
  assert.match(migration, /rewrite\.rulename <> '_RETURN'/u)
  assert.match(migration, /pg_catalog\.pg_get_ruledef\(rewrite\.oid\)/u)
  assert.match(migration, /non-view rewrite rule/u)
  assert.match(migration, /FROM pg_catalog\.pg_constraint AS constraint_row/u)
  assert.match(migration, /constraint_row\.conrelid = v_relation/u)
  assert.match(migration, /unreviewed daily snapshot foreign key/u)
})

test('unknown SECURITY DEFINER routines are checked across callable non-system schemas', () => {
  assert.match(migration, /routine\.prokind IN \('f', 'p'\)/u)
  assert.match(migration, /namespace\.nspname <> 'pg_catalog'/u)
  assert.match(migration, /namespace\.nspname <> 'information_schema'/u)
  assert.match(migration, /pg_catalog\.has_schema_privilege/u)
  assert.match(migration, /is callable by/u)
})

test('all known legacy RPC bypasses are retired by catalog identity', () => {
  assert.match(migration, /FROM pg_catalog\.pg_proc AS routine/u)
  assert.match(migration, /pg_catalog\.pg_get_function_identity_arguments\(routine\.oid\)/u)

  for (const routine of [
    'cleanup_all_data_violations',
    'cleanup_snapshot_violations',
    'cleanup_stale_data',
    'exec_sql',
    'get_latest_prev_snapshots',
    'get_latest_snapshots_for_date',
  ]) {
    assert.match(migration, new RegExp("'" + routine + "'", 'u'))
  }

  assert.match(
    migration,
    /REVOKE ALL PRIVILEGES ON FUNCTION %s '\s*\|\|\s*'FROM PUBLIC, anon, authenticated, service_role/u
  )
  assert.match(
    migration,
    /pg_catalog\.has_function_privilege\([\s\S]*?v_role,[\s\S]*?v_routine\.oid,[\s\S]*?'EXECUTE'/u
  )
  assert.match(migration, /routine\.prosecdef/u)
  assert.match(migration, /ILIKE '%trader_daily_snapshots%'/u)
  assert.match(migration, /unreviewed SECURITY DEFINER daily snapshot routine/u)
})

test('PG17 proof covers rollback, preservation, replay and RPC denial', () => {
  assert.match(pg17, /expect_migration_failure unknown_policy/u)
  assert.match(pg17, /unknown-policy preflight did not roll back cleanly/u)
  assert.match(pg17, /expect_migration_failure inherited_operator_path/u)
  assert.match(pg17, /inherited-path postflight did not roll back cleanly/u)
  assert.match(pg17, /expect_migration_failure inherited_column_path/u)
  assert.match(pg17, /inherited-column postflight did not roll back cleanly/u)
  assert.match(pg17, /SELECT WITH GRANT OPTION/u)
  assert.match(pg17, /expect_migration_failure dependent_view_path/u)
  assert.match(pg17, /dependent-view preflight did not preserve live state/u)
  assert.match(pg17, /daily_snapshot_app_view/u)
  assert.match(pg17, /expect_migration_failure security_definer_trigger_path/u)
  assert.match(pg17, /SECURITY DEFINER trigger preflight did not preserve live state/u)
  assert.match(pg17, /daily_snapshot_inbox_writer/u)
  assert.match(pg17, /expect_migration_failure rewrite_rule_path/u)
  assert.match(pg17, /rewrite-rule preflight did not preserve live state/u)
  assert.match(pg17, /expect_migration_failure foreign_key_path/u)
  assert.match(pg17, /foreign-key preflight did not preserve live state/u)
  assert.match(pg17, /expect_migration_failure_in_db partition_child_drift/u)
  assert.match(pg17, /daily_snapshot_partition_drift/u)
  assert.match(pg17, /expect_migration_failure cross_schema_security_definer/u)
  assert.match(pg17, /cross-schema routine preflight did not preserve live state/u)
  assert.match(pg17, /expect_migration_failure unreviewed_security_definer/u)
  assert.match(pg17, /SECURITY DEFINER postflight did not roll back cleanly/u)
  assert.match(pg17, /migration mutated reviewed operator\/backup ACLs/u)
  assert.match(pg17, /relation_oid <> v_relation::oid/u)
  assert.match(pg17, /proof\.row_payload <> current_rows\.row_payload/u)
  assert.equal(
    pg17.match(/psql_cmd -q -f "\$MIGRATION"/gu)?.length,
    2,
    'PG17 proof must apply the migration twice'
  )

  assert.match(pg17, /for role in anon authenticated service_role/u)
  assert.match(pg17, /\$\{role\}_exec_sql/u)
})
