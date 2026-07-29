import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260725017250_normalize_leaderboard_rank_max_drawdown.sql'
  ),
  'utf8'
)
const pg17Proof = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/__tests__/leaderboard-rank-max-drawdown-normalization.pg17.sh'
  ),
  'utf8'
)
const foundation = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/__tests__/fixtures/leaderboard-rank-atomic-writer-foundation.pg17.inc'
  ),
  'utf8'
)

describe('leaderboard max-drawdown convention repair', () => {
  it('targets only the exact partitioned v37 rank parent', () => {
    expect(migration).toContain("pg_catalog.pg_get_partkeydef(table_row.oid) = 'LIST (season_id)'")
    expect(migration).toContain('v_column_count <> 37')
    expect(migration).toContain('153127c5850e4f841b32bb3809b78bb815bed23643caf8394fb92997d6535514')
    expect(migration).toContain('LOCK TABLE public.leaderboard_ranks IN ACCESS EXCLUSIVE MODE')
    expect(foundation).toContain('CREATE TABLE public.leaderboard_ranks (')
    expect(foundation).toContain(') PARTITION BY LIST (season_id);')
    expect(foundation.match(/PARTITION OF public\.leaderboard_ranks/g)).toHaveLength(4)
  })

  it('fails closed before changing non-finite or impossible observations', () => {
    expect(migration).toContain("ARRAY['NaN', 'Infinity', '-Infinity']")
    expect(migration).toContain('pg_catalog.abs(rank_row.max_drawdown) > 100')
    expect(migration).toContain(
      'leaderboard max-drawdown contains non-finite or out-of-range values'
    )
    expect(migration).toContain(
      'unexpected or drifted leaderboard max-drawdown constraint requires audit'
    )
    expect(pg17Proof).toContain('max-drawdown migration deleted a same-name drifted constraint')
    expect(migration).not.toMatch(/LEAST|GREATEST/)
  })

  it('converts only the obsolete sign and installs one validated positive check', () => {
    expect(migration).toContain('SET max_drawdown = pg_catalog.abs(rank_row.max_drawdown)')
    expect(migration).toContain('WHERE rank_row.max_drawdown < 0;')
    expect(migration).toContain('ADD CONSTRAINT leaderboard_ranks_max_drawdown_positive_check')
    expect(migration).toContain('max_drawdown >= 0 AND max_drawdown <= 100')
    expect(migration).toContain('NOT VALID;')
    expect(migration).toContain('VALIDATE CONSTRAINT leaderboard_ranks_max_drawdown_positive_check')
    expect(pg17Proof).toContain('legacy drawdown magnitudes were not normalized exactly')
    expect(pg17Proof).toContain('canonical max-drawdown constraint accepted a negative value')
    expect(pg17Proof).toContain('canonical max-drawdown constraint accepted a value over 100')
    expect(pg17Proof).toContain('max-drawdown migration clamped impossible stored values')
    expect(pg17Proof).toContain(
      'drawdown normalization did not advance exact source mutation fences'
    )
  })

  it('keeps total-loss profile data but leaves public eligibility narrower', () => {
    expect(migration).toContain('Public rank eligibility is narrower and rejects 100.')
    expect(pg17Proof).toContain('90D:beta:total_loss:100.00')
    expect(migration).not.toContain('max_drawdown < 100) NOT VALID')
  })

  it('is replay-stable and rejects canonical or descendant constraint drift', () => {
    expect(migration).toContain('canonical leaderboard max-drawdown constraint drifted')
    expect(migration).toContain('v_descendant_mdd_total <> v_partition_count')
    expect(migration).toContain('Run this candidate in the leaderboard maintenance window.')
    expect(migration).toContain('lock_timeout=10s')
    expect(pg17Proof).toContain(
      'max-drawdown migration replay changed constraint, rows, or sequence'
    )
    expect(pg17Proof).toContain('max-drawdown replay accepted a weakened canonical constraint')
    expect(pg17Proof).toContain('max-drawdown replay accepted a child-only constraint')
    expect(pg17Proof).toContain('max-drawdown replay silently repaired a child-only constraint')
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true)
  })
})
