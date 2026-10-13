import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase/migrations/20260816130000_quarantine_v1_trader_alert_browser_mutations.sql'),
  'utf8'
)
const pg17Proof = readFileSync(
  join(root, 'supabase/migrations/__tests__/v1-trader-alert-browser-mutations.pg17.sh'),
  'utf8'
)

describe('V1 trader-alert browser mutation quarantine', () => {
  it('is an atomic, forward-only ACL/RLS boundary', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("'public:v1-trader-alert-browser-mutation-quarantine'")
    expect(migration).toContain('LOCK TABLE\n  public.trader_alerts,')
    expect(migration).toContain('IN ACCESS EXCLUSIVE MODE;')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")

    for (const table of ['trader_alerts', 'alert_history', 'user_preferences']) {
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`)
    }
    expect(migration).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+public\.(?:trader_alerts|alert_history|user_preferences|user_profiles)\b/iu
    )
  })

  it('fails closed on roles, owner-assumption, and exact V1 schema drift', () => {
    for (const role of ['postgres', 'anon', 'authenticated', 'service_role']) {
      expect(migration).toContain(`'${role}'`)
    }
    expect(migration).toContain('auth.uid() must exist and return uuid')
    expect(migration).toContain(
      'must be an ordinary postgres-owned table before V1 trader-alert browser quarantine'
    )
    expect(migration).toContain('can assume owner')
    expect(migration).toContain('can assume service_role')
    expect(migration).toContain('V1 trader-alert browser quarantine requires compatible columns')

    for (const column of [
      'enabled',
      'alert_id',
      'watched_traders',
      'ranking_change_threshold',
      'notify_trader_events',
      'email_digest',
    ]) {
      expect(migration).toContain(`'${column}'`)
    }
  })

  it('removes overlapping browser grants while retaining only legacy owner capabilities', () => {
    expect(migration).toContain('DO $revoke_browser_notification_table_and_column_grants$')
    expect(migration).toContain(
      "'REVOKE ALL PRIVILEGES ON TABLE %s FROM PUBLIC, anon, authenticated'"
    )
    expect(migration).toContain(
      "'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '"
    )
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE ON TABLE public\.user_profiles[\s\S]*?FROM PUBLIC, anon, authenticated;/
    )
    expect(migration).toMatch(
      /REVOKE INSERT \(notify_trader_events, email_digest\),[\s\S]*?UPDATE \(notify_trader_events, email_digest\),[\s\S]*?FROM PUBLIC, anon, authenticated;/
    )

    expect(migration).toContain(
      'GRANT SELECT, DELETE ON TABLE public.trader_alerts TO authenticated;'
    )
    expect(migration).toContain('GRANT SELECT ON TABLE public.alert_history TO authenticated;')
    expect(migration).toContain('GRANT SELECT ON TABLE public.user_preferences TO authenticated;')
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.trader_alerts TO service_role;'
    )
    expect(migration).toContain(
      'browser role retains V1 trader notification profile mutation authority'
    )
  })

  it('converges every legacy policy to owner inventory/cleanup plus service authority', () => {
    expect(migration).toContain('DO $replace_retired_notification_policies$')
    expect(migration).toContain("'DROP POLICY %I ON %s'")

    for (const policy of [
      'trader_alerts_v1_legacy_owner_select',
      'trader_alerts_v1_legacy_owner_delete',
      'trader_alerts_v1_service_mutation',
      'alert_history_v1_legacy_owner_select',
      'alert_history_v1_service_mutation',
      'user_preferences_v1_legacy_owner_select',
      'user_preferences_v1_service_mutation',
    ]) {
      expect(migration).toContain(policy)
    }

    expect(migration).toMatch(
      /CREATE POLICY trader_alerts_v1_legacy_owner_delete[\s\S]*?FOR DELETE[\s\S]*?TO authenticated[\s\S]*?user_id = \(SELECT auth\.uid\(\)\)/
    )
    expect(migration).toMatch(
      /CREATE POLICY alert_history_v1_legacy_owner_select[\s\S]*?FOR SELECT[\s\S]*?TO authenticated/
    )
    expect(migration).toMatch(
      /CREATE POLICY user_preferences_v1_legacy_owner_select[\s\S]*?FOR SELECT[\s\S]*?TO authenticated/
    )
    expect(migration).toContain(
      'The exact user_preferences schema has no independent ranking subscription'
    )
  })

  it('ships a focused PG17 proof for raw PostgREST-equivalent writes and replay', () => {
    expect(pg17Proof).toContain('This integration proof requires PostgreSQL 17')
    expect(pg17Proof).toContain('expect_migration_failure')
    expect(pg17Proof).toContain(
      'column-drift preflight did not revoke historical browser authority'
    )
    expect(pg17Proof).toContain('browser-trader-alert-insert')
    expect(pg17Proof).toContain('browser-trader-alert-reenable')
    expect(pg17Proof).toContain('browser-alert-history-insert')
    expect(pg17Proof).toContain('browser-ranking-threshold-update')
    expect(pg17Proof).toContain('browser-trader-event-opt-in')
    expect(pg17Proof).toContain('browser-digest-opt-in')
    expect(pg17Proof).toContain('owner legacy alert delete remains available')
    expect(pg17Proof).toContain('server-gated notification opt-out remains available')
    expect(pg17Proof).toContain('replay converges direct browser grants and policy drift')
    // Exactly one successful apply plus one replay; the third invocation lives
    // inside expect_migration_failure and must fail.
    expect(pg17Proof.match(/^psql_cmd -f "\$MIGRATION" >\/dev\/null$/gm)).toHaveLength(2)
    expect(pg17Proof).toContain('if psql_cmd -f "$MIGRATION" >"$failure_log" 2>&1; then')
  })
})
