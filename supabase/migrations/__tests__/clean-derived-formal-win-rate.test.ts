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

  it('is generated only, not scheduled by the launch runner', () => {
    expect(runner).not.toContain('20261113150757_clean_derived_formal_win_rate.sql')
  })
})
