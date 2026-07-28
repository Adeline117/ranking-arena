import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260725015500_bound_leaderboard_rank_generation_batches.sql'
  ),
  'utf8'
)
const scorerMigration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260722041000_pure_arena_score_v4_scorer.sql'),
  'utf8'
)

describe('bounded leaderboard rank generation batches', () => {
  it('serializes against claims and installs one validated finite-capacity constraint', () => {
    expect(migration).toContain(
      'LOCK TABLE ONLY arena.leaderboard_rank_generation_heads\n  IN SHARE ROW EXCLUSIVE MODE'
    )
    expect(migration).toContain(
      'LOCK TABLE ONLY arena.leaderboard_rank_generation_claims\n  IN SHARE ROW EXCLUSIVE MODE'
    )
    expect(
      migration.indexOf('LOCK TABLE ONLY arena.leaderboard_rank_generation_heads')
    ).toBeLessThan(migration.indexOf('LOCK TABLE ONLY arena.leaderboard_rank_generation_claims'))
    expect(migration).toContain('expected_batch_count <= 4096')
    expect(migration).toContain('expected_rank_count <= 64000')
    expect(scorerMigration).toContain('IF v_input_count > 64000 THEN')
    expect(scorerMigration).toContain('Arena Score v4 accepts at most 64000 rows')
    expect(migration).toContain(
      'expected_rank_count::bigint <=\n          expected_batch_count::bigint * 1000'
    )
    expect(migration).toContain(
      'ADD CONSTRAINT leaderboard_rank_generation_claims_batch_capacity_check'
    )
    expect(migration).toContain(
      'VALIDATE CONSTRAINT\n        leaderboard_rank_generation_claims_batch_capacity_check'
    )
    expect(
      migration.match(/ADD CONSTRAINT leaderboard_rank_generation_claims_batch_capacity_check/g)
    ).toHaveLength(1)
  })

  it('fails closed on prior state, catalog, ACL, inheritance, or constraint drift', () => {
    expect(migration).toContain('existing generation claim exceeds bounded batch capacity')
    expect(migration).toContain('generation claim foundational count constraints drifted')
    expect(migration).toContain('generation batch capacity constraint drifted')
    expect(migration).toContain('generation tables owner, RLS, inheritance, or ACL drifted')
    expect(migration).toContain('generation table trigger, rule, or policy drifted')
    expect(migration).toContain('generation claim RPC body does not match the install state')
    expect(migration).toContain('generation claim RPC EXECUTE ACL drifted')
    expect(migration).toContain('generation foundational constraint contract drifted')
    expect(migration).toContain('generation table index contract drifted')
    expect(migration).toContain('generation table column contract drifted')
    expect(migration).toContain("trigger_row.tgattr = ''::pg_catalog.int2vector")
    expect(migration).toContain('FROM ONLY arena.leaderboard_rank_generation_claims AS claim')
    expect(migration).toContain('pg_catalog.pg_inherits AS inheritance')
    expect(migration).toContain('column_row.attacl')
    expect(migration).toContain('constraint_row.convalidated')
    expect(migration).toContain('constraint_row.conkey = ARRAY[7, 6]')
  })

  it('tightens the same claim RPC in place without mutating existing claims', () => {
    expect(
      migration.match(/CREATE OR REPLACE FUNCTION public\.claim_leaderboard_rank_generation/g)
    ).toHaveLength(1)
    expect(migration).toContain('OR p_expected_rank_count > 64000')
    expect(migration).toContain('OR p_expected_batch_count > 4096')
    expect(migration).toContain(
      'p_expected_rank_count::bigint >\n          p_expected_batch_count::bigint * 1000'
    )
    expect(migration).toContain('09f136557ede5e00ef5c519736c81abf44ea7780f336e216591304a746a746a2')
    expect(migration).not.toMatch(/UPDATE\s+(?:ONLY\s+)?arena\.leaderboard_rank_generation_claims/i)
    expect(migration).not.toMatch(
      /DELETE\s+FROM\s+(?:ONLY\s+)?arena\.leaderboard_rank_generation_claims/i
    )
    expect(migration).not.toMatch(/DROP\s+CONSTRAINT/i)
    expect(migration).not.toMatch(/GRANT\s+/i)
  })

  it('is transactional and has both install and replay postconditions', () => {
    expect(migration.trimStart().startsWith('-- Bound generation claims')).toBe(true)
    expect(migration).toMatch(/\nBEGIN;\n/)
    expect(migration).toContain('DO $preflight$')
    expect(migration).toContain('DO $install$')
    expect(migration).toContain('DO $postflight$')
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true)
  })
})
