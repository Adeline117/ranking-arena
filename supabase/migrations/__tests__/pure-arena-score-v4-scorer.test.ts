import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260722041000_pure_arena_score_v4_scorer.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/pure-arena-score-v4-scorer.pg17.sh'),
  'utf8'
)
const golden = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/fixtures/arena-score-v4-golden-vectors.json'),
  'utf8'
)

describe('pure Arena Score v4 PostgreSQL scorer migration', () => {
  it('is a private immutable pure-parameter contract', () => {
    expect(migration).toMatch(
      /FUNCTION arena\.compute_arena_scores_v4_json\(\s*p_period text,\s*p_inputs jsonb\s*\)/
    )
    expect(migration).not.toContain('CREATE OR REPLACE FUNCTION arena.compute_arena_scores_v4_json')
    expect(migration).toContain('scorer signature already exists; audit before install')
    expect(migration).toMatch(/RETURNS jsonb[\s\S]*LANGUAGE plpgsql[\s\S]*IMMUTABLE/)
    expect(migration).toMatch(/SECURITY INVOKER/)
    expect(migration).toContain('SET search_path = pg_catalog, pg_temp')
    expect(migration).toContain('extensions.digest(')
    expect(migration).toContain('pg_catalog.cbrt(')
    expect(migration).toContain('PostgreSQL 17 is the future single authoritative')
    expect(migration).toContain('does not promise bit-exact equivalence')
    expect(migration).toContain('output/rank/digest canary must pass; any drift fails closed')
    expect(migration).toContain(
      'Cutover requires an exact live-cohort output/rank/digest canary and fails closed on drift.'
    )
    expect(migration).toMatch(
      /FUNCTION arena\.arena_score_v4_round2\(p_value double precision\)[\s\S]*IMMUTABLE[\s\S]*STRICT[\s\S]*PARALLEL SAFE[\s\S]*SECURITY INVOKER/
    )
    expect(migration).not.toContain('CREATE OR REPLACE FUNCTION arena.arena_score_v4_round2')
    expect(migration).toContain('round2 helper signature already exists; audit before install')
    expect(migration).toContain('OR p_value > 100')
    expect(migration).toContain('pg_catalog.float8send(v_scaled)')
    expect(migration).toContain('pg_catalog.get_byte(v_bits, 0)')
    expect(migration).toMatch(
      /RETURN pg_catalog\.floor\(v_fixed4 \+ 0\.5::numeric\)::double precision\s+\/ 100::double precision;/
    )
    expect(migration).toContain('arena.arena_score_v4_round2(unrounded_outputs.total_score)')
    expect(migration).not.toMatch(/FROM\s+(?:public|arena)\.[a-z_]+/i)
    expect(migration).not.toMatch(/(?:INSERT|UPDATE|DELETE)\s+(?:INTO|FROM)?\s*(?:public|arena)\./i)
  })

  it('freezes strict keys, unique identity, resource bounds, canonical order, and digests', () => {
    for (const key of [
      'source',
      'source_trader_id',
      'roi',
      'pnl',
      'max_drawdown',
      'win_rate',
      'sharpe_ratio',
      'profit_factor',
      'trades_count',
    ]) {
      expect(migration).toContain(`'${key}'`)
    }
    expect(migration).toContain('64000')
    expect(migration).toContain('67108864')
    expect(migration).toMatch(/duplicate Arena Score v4 input key/)
    expect(migration).toMatch(/COLLATE "C"/)
    expect(migration).toContain("'inputDigest'")
    expect(migration).toContain("'outputDigest'")
    expect(migration).toContain("'arena-score-v4-pg17-input@1'")
    expect(migration).toContain("'arena-score-v4-pg17-output@1'")
    expect(migration).toContain("'arena-score-v4-pg17@1'")
    expect(migration).not.toContain("'arena-score-v4-pure-input@1'")
    expect(migration).not.toContain("'arena-score-v4-pure-output@1'")
    expect(migration).not.toContain("'arena-score-v4-pure@1'")
  })

  it('revokes every API role and is wired into both predeploy paths', () => {
    expect(migration).toMatch(
      /REVOKE ALL\s+ON FUNCTION arena\.compute_arena_scores_v4_json\(text, jsonb\)\s+FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(migration).toMatch(
      /REVOKE ALL\s+ON FUNCTION arena\.arena_score_v4_round2\(double precision\)\s+FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(migration).toContain('privilege_row.grantee NOT IN (0, function_row.proowner)')
    expect(migration).toContain('privilege_row.grantee <> function_row.proowner')
    expect(runner.match(new RegExp(migrationName.replace('.', '\\.'), 'g'))).toHaveLength(2)
    expect(pg17).toContain("provolatile <> 'i'")
    expect(pg17).toContain('prosecdef')
    expect(pg17).toContain("'service_role'")
    expect(pg17).toContain("'leaked_default_role'")
    expect(pg17).toContain('order-invariant input digest changed')
    expect(pg17).toContain('numeric-spelling invariant canonical digest changed')
    expect(pg17).toContain('currency.js round2 boundary parity drifted')
    expect(pg17).toContain('PG17 authoritative ln math boundary factor drifted')
    expect(pg17).toContain('30954907556599436::double precision')
    expect(pg17).toContain('out-of-domain round2 input unexpectedly succeeded')
    expect(pg17).toContain('dense seeded TS/PostgreSQL cent digest drifted')
    expect(pg17).toContain('duplicate Arena Score v4 input key')
    expect(pg17).toContain('pure scorer round2-helper preflight failed for the wrong reason')
    expect(golden).toContain('"input": 0.2549995, "expected": 0.25')
    expect(golden).toContain('"input": 0.014999499999999999, "expected": 0.01')
    expect(golden).toContain('"contract": "arena-score-v4-pg17-math-boundary@1"')
    expect(golden).toContain('"pnl": 2630.2558790915355')
    expect(golden).toContain('"expectedPg17FactorPnl": 0.1')
    expect(golden).toContain('"expectedLegacyV8FactorPnl": 0.11')
  })
})
