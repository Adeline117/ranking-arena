/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Database } from '@/lib/supabase/database.types'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

const migration = read(
  'supabase/migrations/20261123021904_public_ranked_leaderboard_window_flags.sql'
)
const baseline = read(
  'supabase/migrations/20260816184500_public_ranked_leaderboard_source_freshness_gate.sql'
)
const proof = read('supabase/migrations/__tests__/public-ranked-leaderboard-window-flags.pg17.sh')
const seasonProof = read('supabase/migrations/__tests__/public-ranking-season-publication.pg17.sh')
const scoreTraders = read('lib/rankings/publication/score-traders.ts')
const packageJson = read('package.json')
const ciWorkflow = read('.github/workflows/ci.yml')

const PRODUCTION_VIEW_SHA256 = 'e7a040df0d437b2885ccad4f31108b260999f8421dd10c737466a756e3b6d0a7'
const NEW_VIEW_SHA256 = '452bf1c819abc3b8b5f94405fc9168782dfca445cd6430e8474498b900641140'

/** The view statement of a migration, from CREATE OR REPLACE VIEW to its end. */
function viewStatement(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE VIEW public.public_ranked_leaderboard\n')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = sql.indexOf('\n  );', start)
  return sql.slice(start, end + '\n  );'.length)
}

describe('public_ranked_leaderboard window flags (20261123021904)', () => {
  it('is the previous view statement with two columns appended, and nothing else', () => {
    const before = viewStatement(baseline)
    const after = viewStatement(migration)
    const appended = `  rank_row.is_new,
  COALESCE(
    (rank_row.score_factors -> 'idle_window') = 'true'::pg_catalog.jsonb,
    false
  ) AS idle_window,
  COALESCE(
    (rank_row.score_factors -> 'mdd_contradiction') = 'true'::pg_catalog.jsonb,
    false
  ) AS mdd_contradiction
FROM public.leaderboard_ranks AS rank_row`
    expect(before).toContain('  rank_row.is_new\nFROM public.leaderboard_ranks AS rank_row')
    expect(after).toBe(
      before.replace('  rank_row.is_new\nFROM public.leaderboard_ranks AS rank_row', appended)
    )
    expect(after).toContain('WITH (security_barrier = true, security_invoker = false)')
  })

  it('reads the marks without a cast that could raise', () => {
    const statement = viewStatement(migration)
    // jsonb equality with the JSON boolean true: a string, number, null, array
    // or a non-object score_factors is simply not equal.
    expect(statement).not.toMatch(/::\s*(?:pg_catalog\.)?bool(?:ean)?\b/)
    expect(statement).not.toContain('->>')
    expect(statement.match(/COALESCE\(/g)).toHaveLength(2)
  })

  it('accepts only the production definition or itself, and drops nothing', () => {
    expect(migration.match(/'[0-9a-f]{64}'/g)).toEqual([
      `'${PRODUCTION_VIEW_SHA256}'`,
      `'${NEW_VIEW_SHA256}'`,
      `'${NEW_VIEW_SHA256}'`,
    ])
    const statements = migration.replace(/--.*$/gm, '')
    expect(statements).not.toMatch(
      /\b(?:DROP|ALTER|GRANT|REVOKE|COMMENT ON|TRUNCATE|CREATE (?:OR REPLACE )?FUNCTION|CREATE (?:TEMP(?:ORARY)? )?TABLE)\b/
    )
    expect(statements.match(/CREATE OR REPLACE VIEW/g)).toHaveLength(1)
    expect(statements.match(/^DO \$migration\$/gm)).toHaveLength(1)
    // The digest is taken with public visible and arena not, as in the export.
    expect(migration).toContain('SET LOCAL search_path = public, pg_temp;')
    expect(migration.match(/^SET LOCAL (\S+)/gm)).toEqual([
      'SET LOCAL lock_timeout',
      'SET LOCAL statement_timeout',
      'SET LOCAL search_path',
    ])
  })

  it('names the marks exactly as the scoring worker writes them', () => {
    for (const key of ['idle_window', 'mdd_contradiction']) {
      expect(scoreTraders).toContain(`${key}?: true`)
      expect(scoreTraders).toContain(`${key}: true`)
      expect(viewStatement(migration)).toContain(`rank_row.score_factors -> '${key}'`)
    }
  })

  it('is typed in database.types.ts, appended to the view row only', () => {
    type Row = Database['public']['Views']['public_ranked_leaderboard']['Row']
    const row: Pick<Row, 'idle_window' | 'mdd_contradiction' | 'arena_score' | 'max_drawdown'> = {
      idle_window: false,
      mdd_contradiction: false,
      arena_score: 0.01,
      max_drawdown: null,
    }
    expect(Object.keys(row)).toEqual([
      'idle_window',
      'mdd_contradiction',
      'arena_score',
      'max_drawdown',
    ])
    // The base table does not get these columns: they are projections.
    const types = read('lib/supabase/database.types.ts')
    expect(types.match(/^ {10}idle_window: boolean \| null$/gm)).toHaveLength(1)
    expect(types.match(/^ {10}mdd_contradiction: boolean \| null$/gm)).toHaveLength(1)
  })

  it('is proven on PostgreSQL 17 as a non-superuser, in CI, and end to end', () => {
    expect(proof).toContain('CREATE ROLE postgres LOGIN NOSUPERUSER')
    expect(proof).toContain(`PRODUCTION_VIEW_SHA256='${PRODUCTION_VIEW_SHA256}'`)
    expect(proof).toContain(`NEW_VIEW_SHA256='${NEW_VIEW_SHA256}'`)
    for (const covered of [
      'the repository definition is the production definition',
      'flags per served row',
      'the flags are never NULL',
      'the 35 original columns of every served row, and the row set',
      'options, owner, ACL and comment',
      'old-rule rows: both flags false everywhere',
      'unreviewed definition',
      'security_invoker turned on',
      'another owner',
      'missing view',
    ]) {
      expect(proof).toContain(covered)
    }
    expect(packageJson).toContain(
      '"qa:ranked-view-window-flags-pg17": "bash supabase/migrations/__tests__/public-ranked-leaderboard-window-flags.pg17.sh"'
    )
    expect(ciWorkflow).toContain('run: npm run qa:ranked-view-window-flags-pg17')
    // The real orchestrator publishes an idle row and a refused drawdown and
    // the view serves the marks.
    expect(seasonProof).toContain('20261123021904_public_ranked_leaderboard_window_flags.sql')
    expect(seasonProof).toContain('the idle row is served last at 0.01 with its own metrics')
    expect(seasonProof).toContain('the refused drawdown is served NULL, marked')
  })
})
