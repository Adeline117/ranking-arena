import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260729071000_leaderboard_metric_trust_projection_v2.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const publicationPlan = readFileSync(
  resolve(
    root,
    'supabase/migrations/20260729064500_leaderboard_rank_generation_publication_plan.sql'
  ),
  'utf8'
)
const fixture = readFileSync(
  resolve(
    root,
    'supabase/migrations/__tests__/fixtures/leaderboard-metric-trust-projection-v2.pg17.inc.sh'
  ),
  'utf8'
)
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/leaderboard-metric-trust-projection-v2.pg17.sh'),
  'utf8'
)
const atomicWriter = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/leaderboard-rank-generation-atomic-writer.pg17.sh'),
  'utf8'
)
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const packageJson = readFileSync(resolve(root, 'package.json'), 'utf8')
const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')

describe('versioned leaderboard metric-trust projection v2', () => {
  it('derives a hash-fenced v2 function without rewriting projection v1', () => {
    expect(migration).toContain('pg_catalog.pg_get_functiondef')
    expect(migration).toContain('build_leaderboard_metric_trust_projection_v1')
    expect(migration).toContain('build_leaderboard_metric_trust_projection_v2')
    expect(migration).toContain('projection v2 function-name anchor drifted: %/1')
    expect(migration).toContain('projection v2 ranking-method anchors drifted: %/3')
    expect(migration).toContain('projection v2 semantic anchor drifted: %/1')
    expect(migration).toContain('6047c43ac685bb54a006cae1f3989e61c3a07236c71d03941ddeefd9c4338234')
    expect(migration).toContain('b223a5c81a01d6e3a9b83d34dd4552d86f14124442f48359b11e81b4cd77957c')
    expect(migration).not.toMatch(
      /CREATE OR REPLACE FUNCTION\s+arena\.build_leaderboard_metric_trust_projection_v1/i
    )
    expect(fixture).toContain('projection v2 changed historical projection v1')
  })

  it('retains only trusted zero and keeps unknown or capped risk out of rank inputs', () => {
    expect(migration).toContain('candidate.win_rate >= 0')
    expect(migration).toContain('candidate.win_rate <= 100')
    expect(migration).toContain('candidate.max_drawdown >= 0')
    expect(migration).toContain('candidate.max_drawdown < 100')
    expect(migration).toContain('candidate.max_drawdown > 0')
    expect(migration).toContain('candidate.max_drawdown < 1')
    expect(migration).toContain('candidate.max_drawdown >= 99')
    expect(migration).toContain('Trusted WR/MDD zero is retained')
    for (const proof of [
      'trusted zero did not separate projection v1/v2',
      'untrusted raw zero entered projection v2',
      'null raw win rate entered projection v2',
      '100 percent MDD cap entered projection v2',
      'tiny positive MDD sentinel entered projection v2',
      'trusted zero was confused with tiny positive MDD',
      'expired MDD evidence entered projection v2',
      'missing win-rate evidence entered projection v2',
    ]) {
      expect(fixture).toContain(proof)
    }
  })

  it('versions only the contracts whose meaning changed', () => {
    expect(migration).toContain('leaderboard-score-metric-trust-projection@2')
    expect(migration).toContain('leaderboard-score-trusted-roi-pnl-win-mdd-usdt@2')
    expect(migration).toContain('arena-v5-roi-pnl-win-mdd-')
    expect(fixture).toContain('leaderboard-score-metric-trust-core-projection@1')
    expect(publicationPlan).toContain('leaderboard-score-metric-trust-source-pairs@1')
    expect(publicationPlan).toContain('leaderboard-score-metric-trust-pair-chunks@1')
    expect(publicationPlan).toContain('leaderboard-score-publish-bundle@1')
    expect(publicationPlan).toContain('leaderboard-score-excluded-off-board-identities@1')
  })

  it('is owner-only, replay-safe and closed against dependency drift', () => {
    expect(migration).toContain('noncanonical metric-trust projection v2 overload detected')
    expect(migration).toContain('projection v2 prerequisite authority boundary drifted')
    expect(migration).toContain('projection v2 dependency changed during installation')
    expect(migration).toContain('metric-trust projection v2 leaked execution authority')
    expect(migration).toContain('privilege_row.grantee <> function_row.proowner')
    expect(migration).toContain('pg_catalog.has_function_privilege')
    expect(migration).toContain('ALTER FUNCTION arena.build_leaderboard_metric_trust_projection_v2')
    expect(migration).toContain('OWNER TO postgres')
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION arena\.build_leaderboard_metric_trust_projection_v2\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(fixture).toContain('failed projection v2 preflight left partial state')
    expect(fixture).toContain('projection v2 replay changed identity or leaked ACL')
    expect(fixture).toContain('projection v2 migration accepted catalog drift')
    expect(fixture).toContain('RETURNS NULL ON NULL INPUT')
  })

  it('remains inert until the complete versioned publication chain exists', () => {
    expect(migration).toContain('No writer calls this version yet')
    expect(migration).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION\s+public\./i)
    expect(migration).not.toMatch(
      /(?:INSERT|UPDATE|DELETE)\s+(?:INTO|FROM)?\s*public\.leaderboard_ranks/i
    )
    expect(publicationPlan).toContain(
      'arena.build_leaderboard_metric_trust_projection_v1(text,jsonb,jsonb)'
    )
    expect(publicationPlan).toContain('arena.verify_leaderboard_score_input_manifest_v1(uuid)')
    expect(publicationPlan).not.toContain('build_leaderboard_metric_trust_projection_v2')
    expect(publicationPlan).not.toContain('verify_leaderboard_score_input_manifest_v2')
    expect(fixture).toContain('projection v2 did not compose with manifest v2')
  })

  it('runs the production-shaped PG17 proof and ordered predeploy checks in CI', () => {
    const predeploy = runner.slice(
      runner.indexOf('PREDEPLOY_MIGRATIONS=('),
      runner.indexOf('QUARANTINED_PREDEPLOY_MIGRATIONS=(')
    )
    const recovery = runner.slice(
      runner.indexOf('RECOVERY_PREREQUISITE_MIGRATIONS=('),
      runner.indexOf('CONCURRENT_RECOVERY_MIGRATIONS=(')
    )
    expect(predeploy).toContain(migrationName)
    expect(
      predeploy.indexOf('20260729070500_leaderboard_score_input_manifest_v2.sql')
    ).toBeLessThan(predeploy.indexOf(migrationName))
    expect(runner.match(new RegExp(migrationName.replace('.', '\\.'), 'g'))).toHaveLength(1)
    expect(recovery).not.toContain(migrationName)
    expect(pg17).toContain('ARENA_ATOMIC_WRITER_PROJECTION_V2=1')
    expect(atomicWriter).toContain('run_metric_trust_projection_v2_proof')
    expect(atomicWriter).toContain('PostgreSQL 17 metric-trust projection v2 proof passed.')
    expect(packageJson).toContain('"qa:score-projection-v2-pg17"')
    expect(ci).toContain('name: Prove Arena Score v5 trust projection')
    expect(ci).toContain('run: npm run qa:score-projection-v2-pg17')
  })
})
