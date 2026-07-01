/**
 * Field-coverage canary (plan M5) — detects SILENT field loss.
 *
 * Root lesson this guards against: a parser edit, an upstream API change, or a
 * key-name typo can zero out a field that used to populate, and nobody notices
 * because nothing errors — the column just goes NULL. This canary samples
 * production fill rates and compares them to a committed baseline
 * (docs/field-coverage-baseline.json). A field that regresses from "populated"
 * to "empty" fails the run (exit 1 + Telegram alert), so the discovery cost is
 * 24h/zero-human instead of "a user eventually notices a blank stat".
 *
 * It is the write-side twin of the schema-contract canary (schema drift) — this
 * one catches DATA drift.
 *
 * Usage:
 *   npx tsx scripts/openclaw/field-coverage-canary.mts                 # check
 *   npx tsx scripts/openclaw/field-coverage-canary.mts --update-baseline  # re-baseline
 *
 * Env: INGEST_DATABASE_URL / DATABASE_URL (+ TELEGRAM_* for alerts, optional).
 */

import { getIngestPool, closeIngestPool } from '../../lib/ingest/db'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const BASELINE_PATH = join(process.cwd(), 'docs', 'field-coverage-baseline.json')

// A field must be at least this fill rate in the baseline to be "watched", and
// drop below the floor now to count as a regression. Below MIN_ROWS a source is
// ignored (too little data to judge).
const WATCH_MIN = 0.1 // baseline ≥10% fill = an established field
const REGRESS_FLOOR = 0.02 // now <2% fill = considered lost
const MIN_ROWS = 200

const TYPED_COLS = [
  'sharpe', 'mdd', 'win_rate', 'copier_pnl', 'copier_count', 'aum', 'volume',
  'profit_share_rate', 'holding_duration_avg',
] as const

interface Cell {
  total: number
  rates: Record<string, number> // fieldKey -> fill rate 0..1
}
type Snapshot = Record<string, Cell> // "slug|tf" -> Cell

async function sample(): Promise<Snapshot> {
  const pool = getIngestPool()
  const typedSelect = TYPED_COLS.map((c) => `count(ts.${c}) AS ${c}`).join(', ')
  const { rows: typed } = await pool.query<Record<string, unknown>>(
    `SELECT s.slug, ts.timeframe, count(*)::int AS total, ${typedSelect}
       FROM arena.sources s
       JOIN arena.traders t ON t.source_id = s.id
       JOIN arena.trader_stats ts ON ts.trader_id = t.id
      WHERE s.serving_mode = 'serving'
      GROUP BY s.slug, ts.timeframe`
  )
  const { rows: extras } = await pool.query<{
    slug: string; timeframe: number; key: string; n: number
  }>(
    `SELECT s.slug, ts.timeframe, kv.key, count(*)::int AS n
       FROM arena.sources s
       JOIN arena.traders t ON t.source_id = s.id
       JOIN arena.trader_stats ts ON ts.trader_id = t.id
       JOIN LATERAL jsonb_each(ts.extras) kv ON true
      WHERE s.serving_mode = 'serving' AND ts.extras IS NOT NULL
        AND jsonb_typeof(kv.value) IN ('number','string','boolean')
      GROUP BY s.slug, ts.timeframe, kv.key`
  )

  const snap: Snapshot = {}
  for (const r of typed) {
    const total = Number(r.total)
    const rates: Record<string, number> = {}
    for (const c of TYPED_COLS) rates[`col:${c}`] = total ? Number(r[c] ?? 0) / total : 0
    snap[`${r.slug}|${r.timeframe}`] = { total, rates }
  }
  for (const r of extras) {
    const cell = snap[`${r.slug}|${r.timeframe}`]
    if (cell && cell.total) cell.rates[`ext:${r.key}`] = r.n / cell.total
  }
  return snap
}

interface Regression {
  cell: string
  field: string
  was: number
  now: number
}

function diff(baseline: Snapshot, current: Snapshot): Regression[] {
  const out: Regression[] = []
  for (const [cell, base] of Object.entries(baseline)) {
    if (base.total < MIN_ROWS) continue
    const cur = current[cell]
    if (!cur || cur.total < MIN_ROWS) continue
    for (const [field, wasRate] of Object.entries(base.rates)) {
      if (wasRate < WATCH_MIN) continue
      const nowRate = cur.rates[field] ?? 0
      if (nowRate < REGRESS_FLOOR) {
        out.push({ cell, field, was: wasRate, now: nowRate })
      }
    }
  }
  return out
}

async function alert(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chat = process.env.TELEGRAM_CHAT_ID
  if (!token || !chat) {
    console.error('[field-canary] (no TELEGRAM_* — console only)')
    return
  }
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (e) {
    console.error('[field-canary] telegram send failed:', (e as Error).message)
  }
}

async function main() {
  const update = process.argv.includes('--update-baseline')
  const current = await sample()

  if (update || !existsSync(BASELINE_PATH)) {
    writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 0) + '\n', 'utf8')
    console.log(`✓ baseline written (${Object.keys(current).length} cells) → ${BASELINE_PATH}`)
    await closeIngestPool()
    return
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Snapshot
  const regressions = diff(baseline, current)
  await closeIngestPool()

  if (regressions.length === 0) {
    console.log('✅ field-coverage canary: no regressions')
    return
  }

  const lines = regressions
    .slice(0, 40)
    .map((r) => `• ${r.cell} ${r.field}: ${(r.was * 100).toFixed(0)}% → ${(r.now * 100).toFixed(1)}%`)
  const msg =
    `🕳️ <b>Field-coverage regression</b> (${regressions.length})\n` +
    `Fields that were populated dropped to ~0 (silent field loss):\n` +
    lines.join('\n') +
    (regressions.length > 40 ? `\n…+${regressions.length - 40} more` : '') +
    `\n\nInvestigate the parser / upstream for those sources. If intentional, ` +
    `re-baseline: npx tsx scripts/openclaw/field-coverage-canary.mts --update-baseline`
  console.error(msg)
  await alert(msg)
  process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
