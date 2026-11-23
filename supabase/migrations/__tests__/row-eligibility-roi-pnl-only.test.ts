/**
 * @jest-environment node
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  hasConcretePublicRankingMetrics,
  isPublicRankingRowEligible,
} from '@/lib/rankings/publication-policy'
import { classifyPublishableRow } from '@/lib/rankings/publication/publish-season'
import type { ScoredTrader } from '@/lib/rankings/publication/score-traders'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

const MIGRATION_PATH = 'supabase/migrations/20261122201611_row_eligibility_roi_pnl_only.sql'
const migration = read(MIGRATION_PATH)
const baseline = read(
  'supabase/migrations/20261111140053_leaderboard_ranks_codec_layout_rebuild.sql'
)
const proof = read('supabase/migrations/__tests__/row-eligibility-roi-pnl-only.pg17.sh')
const packageJson = read('package.json')
const ciWorkflow = read('.github/workflows/ci.yml')

const OLD_BODY_SHA256 = 'aa87e8343569cccdeeea84bee66fbf9cd20b8b75e39b1a6d63e78f110e4bf0df'
const NEW_BODY_SHA256 = '1a9fd63c3a986c44bc8cc39a25d4e1962b2f09b34c89cabdc63eba2567601429'

/** prosrc of the policy function as a migration file defines it. */
function policyBody(sql: string, createStatement: string): string {
  const start = sql.indexOf(createStatement)
  expect(start).toBeGreaterThanOrEqual(0)
  const open = sql.indexOf('AS $function$', start) + 'AS $function$'.length
  const close = sql.indexOf('$function$;', open)
  return sql.slice(open, close)
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

interface MatrixRow {
  source: string
  source_trader_id: string
  score_completeness: string | null
  metrics_estimated: boolean | null
  is_outlier: boolean | null
  arena_score: number | null
  roi: number | null
  pnl: number | null
  win_rate: number | null
  max_drawdown: number | null
  computed_age_hours: number
}

interface MatrixCase {
  label: string
  row: Partial<MatrixRow>
  before: boolean
  after: boolean
  worker: 'same' | 'empties_metric' | 'not_applicable'
  /** Reader verdict where it differs from `after` (no ROI / PnL range re-check). */
  reader?: boolean
}

const matrix = JSON.parse(
  read('supabase/migrations/__tests__/fixtures/row-eligibility-roi-pnl-cases.json')
) as { base: MatrixRow; cases: MatrixCase[] }

const NOW_MS = Date.parse('2026-11-22T12:00:00.000Z')
const HOUR_MS = 60 * 60 * 1000

function matrixRow(entry: MatrixCase): MatrixRow {
  return { ...matrix.base, ...entry.row }
}

/** The row as a reader receives it from public_ranked_leaderboard. */
function readerRow(row: MatrixRow): Record<string, unknown> {
  const { computed_age_hours: ageHours, ...columns } = row
  return {
    ...columns,
    computed_at: new Date(NOW_MS - ageHours * HOUR_MS).toISOString(),
  }
}

/** The row as the scorer hands it to the writer projection. */
function scoredTrader(row: MatrixRow): ScoredTrader {
  return {
    source: row.source,
    source_trader_id: row.source_trader_id,
    source_as_of: '2026-11-22T11:00:00.000Z',
    arena_score: row.arena_score,
    arena_score_v3: null,
    arena_score_v4: row.arena_score,
    score_factors: null,
    roi: row.roi as number,
    pnl: row.pnl,
    win_rate: row.win_rate,
    max_drawdown: row.max_drawdown,
    followers: 0,
    copiers: null,
    trades_count: null,
    handle: null,
    avatar_url: '/logo.png',
    profitability_score: 0,
    risk_control_score: 0,
    execution_score: null,
    score_completeness: row.score_completeness as ScoredTrader['score_completeness'],
    trading_style: null,
    avg_holding_hours: null,
    style_confidence: null,
    sharpe_ratio: null,
    sortino_ratio: null,
    profit_factor: null,
    calmar_ratio: null,
    trader_type: null,
    metrics_estimated: row.metrics_estimated as boolean,
    is_outlier: row.is_outlier ?? undefined,
  }
}

describe('row eligibility: ROI and PnL only (20261122201611)', () => {
  it('replaces only the body, and pins both the body it replaces and its own', () => {
    expect(
      sha256(policyBody(baseline, 'CREATE FUNCTION arena.leaderboard_rank_row_is_public_eligible('))
    ).toBe(OLD_BODY_SHA256)
    expect(
      sha256(
        policyBody(
          migration,
          'CREATE OR REPLACE FUNCTION arena.leaderboard_rank_row_is_public_eligible('
        )
      )
    ).toBe(NEW_BODY_SHA256)

    // Accepted bodies: production and itself (replay); nothing else.
    expect(migration.match(/'[0-9a-f]{64}'/g)).toEqual([
      `'${OLD_BODY_SHA256}'`,
      `'${NEW_BODY_SHA256}'`,
      `'${NEW_BODY_SHA256}'`,
    ])
    expect(migration).not.toContain('__NEW_BODY_SHA256__')

    // One object: no other function, table, view, index, grant or owner change.
    expect(migration.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1)
    const statements = migration.replace(/--.*$/gm, '')
    expect(statements).toContain('ON COMMIT DROP')
    expect(statements.replace('ON COMMIT DROP', '')).not.toMatch(
      /\b(?:ALTER|DROP|GRANT|REVOKE|COMMENT ON|CREATE (?:OR REPLACE )?VIEW|CREATE (?:UNIQUE )?INDEX)\b/
    )
    expect(statements.match(/CREATE (?:TEMPORARY )?TABLE/g)).toEqual(['CREATE TEMPORARY TABLE'])
    expect(statements).not.toContain('encode_leaderboard_rank_row')
  })

  it('keeps the declaration and never attaches a custom parameter to the function', () => {
    const start = migration.indexOf('\nCREATE OR REPLACE FUNCTION')
    const declaration = migration.slice(start, migration.indexOf('AS $function$', start))
    expect(declaration).toContain('RETURNS boolean')
    expect(declaration).toContain('LANGUAGE sql')
    expect(declaration).toContain('IMMUTABLE')
    expect(declaration).toContain('PARALLEL SAFE')
    expect(declaration).not.toContain('SECURITY DEFINER')
    // The Supabase postgres role is not a superuser: only built-in settings.
    expect(declaration.match(/\bSET\s+\S+/g)).toEqual(['SET search_path'])
    expect(migration.match(/^SET LOCAL (\S+)/gm)).toEqual([
      'SET LOCAL lock_timeout',
      'SET LOCAL statement_timeout',
      'SET LOCAL search_path',
    ])
    expect(migration).not.toMatch(/set_config|current_setting/)
  })

  it('relaxes only the win rate, drawdown and completeness predicates', () => {
    const before = policyBody(
      baseline,
      'CREATE FUNCTION arena.leaderboard_rank_row_is_public_eligible('
    )
    const after = policyBody(
      migration,
      'CREATE OR REPLACE FUNCTION arena.leaderboard_rank_row_is_public_eligible('
    )
    const predicates = (body: string) =>
      body
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    const removed = predicates(before).filter((line) => !predicates(after).includes(line))
    expect(removed).toEqual([
      "AND (p_rank).score_completeness IS NOT DISTINCT FROM 'full'",
      'AND (p_rank).win_rate IS NOT NULL',
      'AND (p_rank).win_rate >= 0',
      'AND (p_rank).win_rate <= 100',
      'AND (p_rank).max_drawdown IS NOT NULL',
      'AND (p_rank).max_drawdown >= 0',
      'AND (p_rank).max_drawdown < 100',
    ])
    for (const kept of [
      'AND (p_rank).metrics_estimated IS NOT DISTINCT FROM false',
      'AND (p_rank).is_outlier IS NOT TRUE',
      'AND (p_rank).arena_score > 0',
      'AND (p_rank).arena_score <= 100',
      'AND (p_rank).roi IS NOT NULL',
      'AND (p_rank).roi >= -10000',
      'AND (p_rank).roi <= 10000',
      'AND (p_rank).pnl IS NOT NULL',
      'AND (p_rank).pnl >= -100000000',
      'AND (p_rank).pnl <= 1000000000',
      "AND (p_rank).computed_at >= p_observed_at - interval '48 hours'",
    ]) {
      expect(predicates(after)).toContain(kept)
    }
    expect(after).toContain('OR ((p_rank).win_rate >= 0 AND (p_rank).win_rate <= 100)')
    expect(after).toContain('OR ((p_rank).max_drawdown >= 0 AND (p_rank).max_drawdown < 100)')
  })

  it('is proven on PostgreSQL 17 as a non-superuser, in CI', () => {
    expect(proof).toContain('CREATE ROLE postgres LOGIN NOSUPERUSER')
    expect(proof).toContain('migrations must run as a non-superuser postgres role')
    expect(proof).toContain(`OLD_BODY_SHA256='${OLD_BODY_SHA256}'`)
    expect(proof).toContain(`NEW_BODY_SHA256='${NEW_BODY_SHA256}'`)
    expect(proof).toContain('fixtures/row-eligibility-roi-pnl-cases.json')
    for (const drift of [
      'unreviewed body',
      'foreign grant',
      'security definer',
      'volatility',
      'extra function setting',
      'another owner',
      'missing function',
    ]) {
      expect(proof).toContain(drift)
    }
    expect(packageJson).toContain(
      '"qa:row-eligibility-roi-pnl-pg17": "bash supabase/migrations/__tests__/row-eligibility-roi-pnl-only.pg17.sh"'
    )
    expect(ciWorkflow).toContain('run: npm run qa:row-eligibility-roi-pnl-pg17')
  })
})

/**
 * Four layers decide whether one row is ranked: the scorer's cohort admission,
 * the writer projection, the database policy and the reader. The database is
 * checked against this same matrix by the PG17 proof (`after` column).
 */
describe('row eligibility matrix: every layer gives the same verdict', () => {
  it('covers both verdicts and the cases the decision turns on', () => {
    expect(matrix.cases.length).toBeGreaterThanOrEqual(40)
    expect(new Set(matrix.cases.map((entry) => entry.label)).size).toBe(matrix.cases.length)
    // The relaxed policy is a superset of the previous one.
    for (const entry of matrix.cases) {
      if (entry.before) expect(entry.after).toBe(true)
    }
    expect(matrix.cases.filter((entry) => !entry.before && entry.after).length).toBeGreaterThan(5)
  })

  it.each(matrix.cases.map((entry) => [entry.label, entry] as const))(
    'reader (isPublicRankingRowEligible): %s',
    (_label, entry) => {
      expect(
        isPublicRankingRowEligible(readerRow(matrixRow(entry)), {
          nowMs: NOW_MS,
          expectedPeriod: undefined,
        })
      ).toBe(entry.reader ?? entry.after)
    }
  )

  it.each(
    matrix.cases
      .filter((entry) => entry.worker === 'same')
      .map((entry) => [entry.label, entry] as const)
  )('writer (classifyPublishableRow): %s', (_label, entry) => {
    const verdict = classifyPublishableRow(scoredTrader(matrixRow(entry)), 'roi_pnl')
    expect('row' in verdict).toBe(entry.after)
    if ('row' in verdict) {
      const row = matrixRow(entry)
      expect(verdict.row).toMatchObject({
        roi: row.roi,
        pnl: row.pnl,
        win_rate: row.win_rate,
        max_drawdown: row.max_drawdown,
        score_completeness: row.score_completeness,
        arena_score: row.arena_score,
      })
      expect(verdict).not.toHaveProperty('emptied')
    }
  })

  it.each(
    matrix.cases
      .filter((entry) => entry.worker === 'empties_metric')
      .map((entry) => [entry.label, entry] as const)
  )('writer empties the metric instead of writing an ineligible row: %s', (_label, entry) => {
    // The raw row is ineligible everywhere...
    expect(entry.after).toBe(false)
    const verdict = classifyPublishableRow(scoredTrader(matrixRow(entry)), 'roi_pnl')
    // ...so the writer publishes it without the offending metric, with a trace.
    expect(verdict).toHaveProperty('row')
    expect(verdict).toHaveProperty('emptied')
  })

  it('whatever the writer produces is a row the reader (and the database policy) accepts', () => {
    let written = 0
    for (const entry of matrix.cases) {
      const verdict = classifyPublishableRow(scoredTrader(matrixRow(entry)), 'roi_pnl')
      if (!('row' in verdict)) continue
      written += 1
      const persisted = { ...verdict.row, computed_at: new Date(NOW_MS).toISOString() }
      expect([entry.label, isPublicRankingRowEligible(persisted, { nowMs: NOW_MS })]).toEqual([
        entry.label,
        true,
      ])
      // The written row is itself a member of the accepted shape: label
      // matches columns, optional metrics null or in range.
      const hasWinRate = persisted.win_rate !== null
      const hasDrawdown = persisted.max_drawdown !== null
      expect(persisted.score_completeness).toBe(
        hasWinRate && hasDrawdown ? 'full' : hasWinRate || hasDrawdown ? 'partial' : 'minimal'
      )
    }
    expect(written).toBeGreaterThan(10)
  })

  it.each(
    matrix.cases
      // Cohort admission runs before a score or computed_at exists.
      .filter(
        (entry) =>
          !('arena_score' in entry.row && entry.after === false) &&
          !('computed_age_hours' in entry.row)
      )
      .map((entry) => [entry.label, entry] as const)
  )('scorer cohort admission (hasConcretePublicRankingMetrics): %s', (_label, entry) => {
    expect(hasConcretePublicRankingMetrics(readerRow(matrixRow(entry)))).toBe(
      entry.reader ?? entry.after
    )
  })

  it("the 'four_metrics' rollback rule equals the previous database policy", () => {
    for (const entry of matrix.cases) {
      if (entry.worker === 'not_applicable') continue
      const verdict = classifyPublishableRow(scoredTrader(matrixRow(entry)), 'four_metrics')
      expect([entry.label, 'row' in verdict]).toEqual([entry.label, entry.before])
    }
  })
})
