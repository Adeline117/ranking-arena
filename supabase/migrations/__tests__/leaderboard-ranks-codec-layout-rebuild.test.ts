import { readFileSync } from 'node:fs'
import path from 'node:path'

const MIGRATIONS_DIR = path.resolve(__dirname, '..')
const REBUILD = '20261111140053_leaderboard_ranks_codec_layout_rebuild.sql'

const migration = readFileSync(path.join(MIGRATIONS_DIR, REBUILD), 'utf8')
const typedBatch = readFileSync(
  path.join(MIGRATIONS_DIR, '20260725017000_leaderboard_rank_typed_batch_contract.sql'),
  'utf8'
)
const atomicWriter = readFileSync(
  path.join(MIGRATIONS_DIR, '20260725017500_leaderboard_rank_generation_atomic_batch_writer.sql'),
  'utf8'
)
const fence = readFileSync(
  path.join(MIGRATIONS_DIR, '20260724235000_leaderboard_publication_mutation_fence.sql'),
  'utf8'
)

// The reviewed persisted-codec order 20260725017000 writes positionally.
const CODEC_COLUMNS = [
  'id',
  'season_id',
  'source',
  'source_type',
  'source_trader_id',
  'rank',
  'arena_score',
  'roi',
  'pnl',
  'win_rate',
  'max_drawdown',
  'followers',
  'trades_count',
  'handle',
  'avatar_url',
  'computed_at',
  'profitability_score',
  'risk_control_score',
  'execution_score',
  'score_completeness',
  'trading_style',
  'avg_holding_hours',
  'style_confidence',
  'sharpe_ratio',
  'sortino_ratio',
  'profit_factor',
  'calmar_ratio',
  'trader_type',
  'is_outlier',
  'metrics_estimated',
  'rank_change',
  'is_new',
  'copiers',
  'arena_score_v4',
  'arena_score_v3',
  'score_factors',
  'rank_publication_id',
]

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start)
  expect(from).toBeGreaterThan(-1)
  const to = text.indexOf(end, from)
  expect(to).toBeGreaterThan(from)
  return text.slice(from, to)
}

describe('leaderboard_ranks codec layout rebuild', () => {
  it('runs in one transaction and only from the reviewed production layout', () => {
    expect(migration.trimStart().startsWith('--')).toBe(true)
    expect(migration).toMatch(/^BEGIN;$/mu)
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(migration).toContain('LOCK TABLE public.leaderboard_ranks IN ACCESS EXCLUSIVE MODE;')
    expect(migration).toContain(
      "'7f99948b74bddebc215f119e8131a73e6f9984c0c9b398356e24145bf9a458d4'"
    )
  })

  it('refuses file-name-order replay before touching the table (launch-slot guard)', () => {
    const guard = between(migration, 'DO $launch_slot_guard$', '$launch_slot_guard$;')
    expect(migration.indexOf('DO $launch_slot_guard$')).toBeLessThan(
      migration.indexOf('DO $preflight$')
    )
    expect(guard).toContain('arena.encode_leaderboard_rank_row_v1(public.leaderboard_ranks)')
    expect(guard).toContain('arena.leaderboard_rank_season_mutation_fences')
    expect(guard).toContain('leaderboard\\_rank\\_season\\_%\\_fence')
    expect(guard).toContain('out of its launch slot')
  })

  it('creates the table in the exact column order the typed batch writer uses', () => {
    const createTable = between(
      migration,
      'CREATE TABLE public.leaderboard_ranks (',
      ') PARTITION BY LIST (season_id);'
    )
    const columns = createTable
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/u)[0])
      .filter((name) => name && name !== ')')
    expect(columns).toEqual(CODEC_COLUMNS)
    // The postflight proves both digests the later contracts enforce.
    expect(typedBatch).toContain('153127c5850e4f841b32bb3809b78bb815bed23643caf8394fb92997d6535514')
    expect(migration).toContain('153127c5850e4f841b32bb3809b78bb815bed23643caf8394fb92997d6535514')
    expect(atomicWriter).toContain(
      'df9746fe0917680970f22309413dd082c54d6cb0c43d0f65250ab3bc21c1406a'
    )
    expect(migration).toContain('df9746fe0917680970f22309413dd082c54d6cb0c43d0f65250ab3bc21c1406a')
  })

  it('copies rows by column name and refuses values the codec cannot hold', () => {
    const insert = between(
      migration,
      'INSERT INTO public.leaderboard_ranks (',
      'FROM public.leaderboard_ranks__layout_legacy;'
    )
    for (const column of CODEC_COLUMNS) {
      expect(insert).toMatch(new RegExp(`\\b${column}\\b`, 'u'))
    }
    expect(migration).toContain('rows outside the persisted codec range')
    expect(migration).toContain('leaderboard_ranks rebuild changed the row count')
  })

  it('recreates the eligibility policy byte-for-byte from 20260724235000', () => {
    const body = (sql: string) =>
      between(
        sql,
        'FUNCTION arena.leaderboard_rank_row_is_public_eligible(\n  p_rank public.leaderboard_ranks,',
        '$function$;'
      )
    expect(body(migration)).toBe(body(fence))
    expect(migration).toContain('aa87e8343569cccdeeea84bee66fbf9cd20b8b75e39b1a6d63e78f110e4bf0df')
  })

  it('keeps partitions owner-only and never widens the parent ACL', () => {
    expect(migration).not.toMatch(/GRANT[^;]*ON TABLE public\.lr_/u)
    expect(migration).toContain(
      "child.relacl::text IS DISTINCT FROM '{postgres=arwdDxtm/postgres}'"
    )
    expect(migration).toContain(
      "'{postgres=arwdDxtm/postgres,anon=rm/postgres,authenticated=rm/postgres,service_role=arwd/postgres}'"
    )
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.leaderboard_ranks TO service_role;/u
    )
  })

  it('recreates the three statement-level publication fence triggers', () => {
    for (const trigger of [
      'leaderboard_rank_delete_fence',
      'leaderboard_rank_insert_fence',
      'leaderboard_rank_update_fence',
    ]) {
      expect(migration).toContain(`CREATE TRIGGER ${trigger}`)
      expect(fence).toContain(trigger)
    }
  })
})
