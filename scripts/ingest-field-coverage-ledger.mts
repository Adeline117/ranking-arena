/**
 * Field-coverage ledger generator (plan Deliverable 0 / M5).
 *
 * "把所有数据字段记下来整理好" — machine-generated from PRODUCTION, so the
 * ledger never drifts from reality (the whole point: a repo doc that claims a
 * field is captured while prod has 0% fill is exactly the failure mode this
 * project keeps hitting).
 *
 * For every serving source it samples arena.trader_stats and reports, per
 * timeframe, the FILL RATE of each typed column and each extras key. A field at
 * 0% is either never emitted (real gap) or the source doesn't expose it; a field
 * that used to be >0 and drops to 0 is a silent regression (see the companion
 * canary, scripts/openclaw/field-coverage-canary.mjs).
 *
 * Usage:  npx tsx scripts/ingest-field-coverage-ledger.mts
 * Writes: docs/EXCHANGE_FIELD_COVERAGE.md
 */

import { getIngestPool, closeIngestPool } from '../lib/ingest/db'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FIELD_COVERAGE_TYPED_COLUMNS,
  renderFieldCoverageLedger,
  type FieldCoverageSourceRow,
} from './lib/field-coverage-ledger'

async function collect(): Promise<FieldCoverageSourceRow[]> {
  const pool = getIngestPool()

  // Typed-column fill counts per (source, timeframe).
  const typedSelect = FIELD_COVERAGE_TYPED_COLUMNS.map((c) => `count(ts.${c}) AS ${c}`).join(', ')
  const { rows: typedRows } = await pool.query<Record<string, unknown>>(
    `SELECT s.slug, ts.timeframe, count(*)::int AS total, ${typedSelect}
       FROM arena.sources s
       JOIN arena.traders t ON t.source_id = s.id
       JOIN arena.trader_stats ts ON ts.trader_id = t.id
      WHERE s.serving_mode = 'serving'
      GROUP BY s.slug, ts.timeframe
      ORDER BY s.slug, ts.timeframe`
  )

  // Extras-key fill counts per (source, timeframe) via lateral key unnest.
  const { rows: extrasRows } = await pool.query<{
    slug: string
    timeframe: number
    key: string
    n: number
  }>(
    `SELECT s.slug, ts.timeframe, kv.key, count(*)::int AS n
       FROM arena.sources s
       JOIN arena.traders t ON t.source_id = s.id
       JOIN arena.trader_stats ts ON ts.trader_id = t.id
       JOIN LATERAL jsonb_each(ts.extras) kv ON true
      WHERE s.serving_mode = 'serving'
        AND ts.extras IS NOT NULL
        AND jsonb_typeof(kv.value) IN ('number','string','boolean')
      GROUP BY s.slug, ts.timeframe, kv.key`
  )

  const byKey = new Map<string, FieldCoverageSourceRow>()
  for (const r of typedRows) {
    const key = `${r.slug}|${r.timeframe}`
    const typed: Record<string, number> = {}
    for (const c of FIELD_COVERAGE_TYPED_COLUMNS) typed[c] = Number(r[c] ?? 0)
    byKey.set(key, {
      slug: String(r.slug),
      timeframe: Number(r.timeframe),
      total: Number(r.total),
      typed,
      extras: {},
    })
  }
  for (const r of extrasRows) {
    const row = byKey.get(`${r.slug}|${r.timeframe}`)
    if (row) row.extras[r.key] = Number(r.n)
  }
  return [...byKey.values()]
}

function cleanGitSha(): string {
  const cwd = process.cwd()
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
    cwd,
    encoding: 'utf8',
  }).trim()
  if (status) {
    throw new Error('Refusing to generate field coverage from a dirty Git worktree')
  }
  return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  }).trim()
}

async function main() {
  const gitSha = cleanGitSha()
  try {
    const rows = await collect()
    const md = renderFieldCoverageLedger(rows, {
      generatedAt: new Date().toISOString(),
      gitSha,
    })
    const outPath = join(process.cwd(), 'docs', 'EXCHANGE_FIELD_COVERAGE.md')
    writeFileSync(outPath, md, 'utf8')
    process.stdout.write(`✓ wrote ${outPath} (${rows.length} source×timeframe rows)\n`)
  } finally {
    await closeIngestPool()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Unknown field-coverage generator error')
  process.exitCode = 1
})
