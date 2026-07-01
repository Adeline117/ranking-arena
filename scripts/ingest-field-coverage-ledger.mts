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
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TYPED_COLS = [
  'roi',
  'pnl',
  'sharpe',
  'mdd',
  'win_rate',
  'win_positions',
  'total_positions',
  'copier_pnl',
  'copier_count',
  'aum',
  'volume',
  'profit_share_rate',
  'holding_duration_avg',
] as const

interface SourceRow {
  slug: string
  timeframe: number
  total: number
  typed: Record<string, number>
  extras: Record<string, number>
}

async function collect(): Promise<SourceRow[]> {
  const pool = getIngestPool()

  // Typed-column fill counts per (source, timeframe).
  const typedSelect = TYPED_COLS.map(
    (c) => `count(ts.${c}) AS ${c}`
  ).join(', ')
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

  const byKey = new Map<string, SourceRow>()
  for (const r of typedRows) {
    const key = `${r.slug}|${r.timeframe}`
    const typed: Record<string, number> = {}
    for (const c of TYPED_COLS) typed[c] = Number(r[c] ?? 0)
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

function pct(n: number, total: number): string {
  if (total === 0) return '—'
  return `${Math.round((n / total) * 1000) / 10}%`
}

function render(rows: SourceRow[]): string {
  const stamp = process.env.LEDGER_STAMP ?? '(run date not stamped)'
  const bySource = new Map<string, SourceRow[]>()
  for (const r of rows) {
    if (!bySource.has(r.slug)) bySource.set(r.slug, [])
    bySource.get(r.slug)!.push(r)
  }

  const out: string[] = []
  out.push('# Exchange Field Coverage Ledger')
  out.push('')
  out.push(
    '> **Machine-generated** from production `arena.trader_stats` by ' +
      '`scripts/ingest-field-coverage-ledger.mts`. Do NOT hand-edit. ' +
      `Generated: ${stamp}.`
  )
  out.push('')
  out.push(
    'Fill % = share of a source×timeframe\'s rows where the field is non-NULL. ' +
      'A typed column or extras key at a low/zero rate is either not exposed by ' +
      'that exchange or a promotion gap. A key that regresses to 0 is a silent ' +
      'field loss — see `scripts/openclaw/field-coverage-canary.mjs`.'
  )
  out.push('')

  const sources = [...bySource.keys()].sort()
  out.push(`**${sources.length} serving sources.**`)
  out.push('')

  for (const slug of sources) {
    const tfRows = bySource.get(slug)!.sort((a, b) => a.timeframe - b.timeframe)
    out.push(`## ${slug}`)
    out.push('')
    const tfs = tfRows.map((r) => r.timeframe)
    out.push(`Timeframes: ${tfs.join(', ')} · rows: ${tfRows.map((r) => r.total).join(' / ')}`)
    out.push('')

    // Typed columns table
    out.push('**Typed columns** (fill % per timeframe)')
    out.push('')
    out.push(`| column | ${tfRows.map((r) => `${r.timeframe}d`).join(' | ')} |`)
    out.push(`|---|${tfRows.map(() => '---').join('|')}|`)
    for (const c of TYPED_COLS) {
      const cells = tfRows.map((r) => pct(r.typed[c] ?? 0, r.total))
      // skip columns that are 0% everywhere (not exposed) to keep the ledger tight
      if (cells.every((x) => x === '0%' || x === '—')) continue
      out.push(`| ${c} | ${cells.join(' | ')} |`)
    }
    out.push('')

    // Extras keys table (union of keys across timeframes)
    const allExtras = new Set<string>()
    for (const r of tfRows) for (const k of Object.keys(r.extras)) allExtras.add(k)
    if (allExtras.size > 0) {
      out.push('**Extras keys** (fill % per timeframe)')
      out.push('')
      out.push(`| extras key | ${tfRows.map((r) => `${r.timeframe}d`).join(' | ')} |`)
      out.push(`|---|${tfRows.map(() => '---').join('|')}|`)
      for (const k of [...allExtras].sort()) {
        const cells = tfRows.map((r) => pct(r.extras[k] ?? 0, r.total))
        out.push(`| ${k} | ${cells.join(' | ')} |`)
      }
      out.push('')
    }
  }

  return out.join('\n') + '\n'
}

async function main() {
  const rows = await collect()
  const md = render(rows)
  const outPath = join(process.cwd(), 'docs', 'EXCHANGE_FIELD_COVERAGE.md')
  writeFileSync(outPath, md, 'utf8')
  console.log(`✓ wrote ${outPath} (${rows.length} source×timeframe rows)`)
  await closeIngestPool()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
