import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20261113150757_clean_derived_formal_win_rate.sql'),
  'utf8'
)
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/clean-derived-formal-win-rate.pg17.sh'),
  'utf8'
)
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')

describe('derived formal win-rate cleanup (#441)', () => {
  it('is one locked, time-bounded transaction with a typed schema preflight', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '5min'")
    expect(migration).toContain('expected 16 arena columns with exact types')
    expect(migration.indexOf('$preflight$')).toBeLessThan(migration.indexOf('UPDATE arena.'))
    expect(migration).toContain('exceeds safety cap 20000')
    expect(migration).not.toMatch(/\bEXECUTE\b/)
    expect(migration).not.toMatch(
      /\b(?:DROP\s+(?:TABLE|FUNCTION|VIEW|INDEX|SCHEMA)|TRUNCATE|DELETE\s+FROM)\b/i
    )
  })

  it('reads only the two web3 boards and BTCC, never a sanctioned pure-DEX source', () => {
    const slugs = new Set(
      [...migration.replace(/^--.*$/gm, '').matchAll(/'([a-z0-9]+_[a-z0-9_]+)'/g)]
        .map((m) => m[1])
        .filter((s) =>
          /^(?:okx_web3|binance_web3|btcc_futures$|hyperliquid|gmx|gtrade|gains)/.test(s)
        )
    )
    expect([...slugs].sort()).toEqual(['binance_web3_bsc', 'btcc_futures', 'okx_web3_solana'])
  })

  it('casts JSON values only behind a jsonb_typeof guard', () => {
    const casts = migration.match(/\(ts\.extras[^)]*\)::numeric/g) ?? []
    expect(casts.length).toBeGreaterThan(0)
    for (const cast of casts) {
      const at = migration.indexOf(cast)
      expect(migration.slice(Math.max(0, at - 160), at)).toMatch(
        /CASE WHEN pg_catalog\.jsonb_typeof/
      )
    }
  })

  it('re-checks the previous value on write and asserts exact row counts', () => {
    expect(migration.match(/AND ts\.win_rate = c\.previous_win_rate;/g)).toHaveLength(2)
    expect(migration).toContain("RAISE EXCEPTION 'on-chain cleanup updated % rows, expected %'")
    expect(migration).toContain("RAISE EXCEPTION 'btcc cleanup updated % rows, expected %'")
  })

  it('has a PG17 proof covering scope, idempotency and drift', () => {
    expect(pg17).toContain('20261113150757_clean_derived_formal_win_rate.sql')
    expect(pg17).toContain("'hyperliquid'")
    expect(pg17).toContain("'gmx'")
    expect(pg17).toContain('cleanup touched % rows outside the provable dirty set')
    expect(pg17).toContain('rerun was not a no-op')
    expect(pg17).toContain('preflight failure still wrote rows')
  })

  it('is classified postdeploy only, after the writers that re-dirty it are replaced', () => {
    // Old writers (pre-60f4cc288 BTCC parser, pre-bf3fa8a4d on-chain enrich)
    // rewrite the cleaned values, so it never runs before the deploy.
    const array = (name: string) => {
      const start = runner.indexOf(`${name}=(\n`)
      return runner
        .slice(start, runner.indexOf('\n)', start))
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^\d{14}_.+\.sql$/.test(line))
    }
    const file = '20261113150757_clean_derived_formal_win_rate.sql'
    const postdeploy = array('POSTDEPLOY_MIGRATIONS')
    expect(array('PREDEPLOY_MIGRATIONS')).not.toContain(file)
    expect(postdeploy).toContain(file)
    expect(postdeploy.indexOf(file)).toBeLessThan(
      postdeploy.indexOf('20261111192134_tier_a_execution_claim_enforcement_later_raw_guards.sql')
    )
  })
})
