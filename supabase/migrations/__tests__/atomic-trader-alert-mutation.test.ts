import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260729183000_atomic_trader_alert_mutation.sql'),
  'utf8'
)
const pg17Proof = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/atomic-trader-alert-mutation.pg17.sh'),
  'utf8'
)

describe('atomic trader alert mutation migration', () => {
  it('serializes the API writer and the table-level 50-row guard on one user lock', () => {
    expect(migration.match(/atomic-trader-alert-user:/g)).toHaveLength(3)
    expect(migration).toContain('CREATE TRIGGER enforce_trader_alert_insert_limit')
    expect(migration).toContain('IF v_count >= 50 THEN')
    expect(migration).toContain("CONSTRAINT = 'trader_alerts_user_limit'")
    expect(migration).toContain('HAVING pg_catalog.count(*) > 50')
  })

  it('uses exact source-aware identities and a NULL-safe uniqueness preflight', () => {
    expect(migration).toContain('index_row.indnullsnotdistinct')
    expect(migration).toContain("ARRAY['user_id', 'trader_id', 'source']")
    expect(migration.match(/source IS NOT DISTINCT FROM p_source/g)).toHaveLength(2)
  })

  it('closes table DML and exposes only the bounded authenticated RPCs', () => {
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.trader_alerts[\s\S]*FROM anon, authenticated, authenticator/
    )
    for (const rpc of ['upsert_trader_alert_atomic', 'delete_trader_alert_atomic']) {
      expect(migration).toContain(`CREATE OR REPLACE FUNCTION public.${rpc}`)
      expect(migration).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${rpc}[\\s\\S]*service_role`)
      )
      expect(migration).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${rpc}[\\s\\S]*TO authenticated`)
      )
    }
  })

  it('keeps delete acknowledgements exact instead of claiming zero-row success', () => {
    expect(migration).toContain('v_existing_id IS DISTINCT FROM p_expected_alert_id')
    expect(migration).toContain("jsonb_build_object('status', 'conflict')")
    expect(migration).toContain("v_status := 'not_found'")
    expect(migration).toContain("'deleted_count', v_mutated")
    expect(migration).toContain(
      "RAISE EXCEPTION 'trader alert delete mutated an impossible row count'"
    )
  })

  it('has a PostgreSQL 17 replay, capacity, cross-source, and ACL proof', () => {
    for (const marker of [
      'migration replay',
      'concurrent 50-row capacity',
      'cross-source delete isolation',
      'stale alert id conflict',
      'authenticated direct insert revoked',
      'atomic trader alert mutation PostgreSQL 17 proof passed',
    ]) {
      expect(pg17Proof).toContain(marker)
    }
  })
})
