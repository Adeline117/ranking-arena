/**
 * Shadow-diff verifier (ARENA_DATA_SPEC v1.2 Phase 0, cutover plan `shadow`).
 *
 * Compares public.trader_latest rows dual-written by the new ingest pipeline
 * (provenance->>'pipeline' = 'arena_ingest_v2') against the arena.* source of
 * truth — the latest PASSED leaderboard snapshot's entries + trader_stats —
 * applying the exact transforms of lib/ingest/serving/compat-trader-latest.ts
 * (roi clamped ±10000, win_rate 0-100, mdd = abs() clamped 0-100).
 *
 * Per (platform, window) it reports row counts, per-field null rates and
 * value deltas for roi_pct / pnl_usd / win_rate / max_drawdown with a 0.01
 * tolerance, then prints a verdict table. Rows written by the LEGACY pipeline
 * for the same platform (different provenance) are diffed too as a semantic
 * sanity check (informational — timing skew expected, never a failure).
 *
 * Usage: npx tsx scripts/ingest-shadow-diff.ts [platform-prefix=bitget]
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config({ path: resolve(process.cwd(), 'worker', '.env') })
config({ path: resolve(process.cwd(), '.env.local') })

const TOLERANCE = 0.01
const FIELDS = ['roi_pct', 'pnl_usd', 'win_rate', 'max_drawdown'] as const
type Field = (typeof FIELDS)[number]
const WINDOW_BY_TF: Record<number, string> = { 7: '7D', 30: '30D', 90: '90D' }

interface SourceRow {
  id: number
  slug: string
  serving_mode: string
  currency: string
  legacy_platform: string | null
  has_legacy_platform_key: boolean
}

interface FieldDiff {
  arena_nulls: number
  shadow_nulls: number
  mismatches: number // |a - s| > tolerance, or null on exactly one side
  max_delta: number | null
}

interface DiffResult {
  arena_count: number
  compared_count: number
  matched_keys: number
  only_arena: number
  only_compared: number
  fields: Record<Field, FieldDiff>
}

async function diffOne(
  pool: import('pg').Pool,
  sourceId: number,
  timeframe: number,
  platform: string,
  window: string,
  pipelineFilter: 'shadow' | 'legacy'
): Promise<DiffResult> {
  const provenanceCond =
    pipelineFilter === 'shadow'
      ? `provenance->>'pipeline' = 'arena_ingest_v2'`
      : `provenance->>'pipeline' IS DISTINCT FROM 'arena_ingest_v2'`

  const { rows } = await pool.query(
    `WITH latest AS (
       SELECT id FROM arena.leaderboard_snapshots
        WHERE source_id = $1 AND timeframe = $2 AND count_check_passed
        ORDER BY scraped_at DESC LIMIT 1
     ),
     arena_rows AS (
       -- NB: GREATEST/LEAST ignore NULL args in Postgres — guard explicitly so
       -- a missing metric stays NULL (matches the JS clamp in compat-trader-latest).
       SELECT t.exchange_trader_id AS trader_key,
              CASE WHEN e.headline_roi IS NULL THEN NULL
                   ELSE GREATEST(-10000, LEAST(10000, e.headline_roi)) END AS roi_pct,
              e.headline_pnl                                              AS pnl_usd,
              CASE WHEN e.headline_win_rate IS NULL THEN NULL
                   ELSE GREATEST(0, LEAST(100, e.headline_win_rate)) END  AS win_rate,
              CASE WHEN st.mdd IS NULL THEN NULL
                   ELSE GREATEST(0, LEAST(100, abs(st.mdd))) END          AS max_drawdown
         FROM latest l
         JOIN arena.leaderboard_entries e ON e.snapshot_id = l.id
         JOIN arena.traders t ON t.id = e.trader_id
         LEFT JOIN arena.trader_stats st
           ON st.trader_id = t.id AND st.timeframe = $2
     ),
     compared AS (
       SELECT trader_key, roi_pct, pnl_usd, win_rate, max_drawdown
         FROM public.trader_latest
        WHERE platform = $3 AND "window" = $4 AND ${provenanceCond}
     ),
     joined AS (
       SELECT a.trader_key AS a_key, c.trader_key AS c_key,
              a.roi_pct AS a_roi, c.roi_pct AS c_roi,
              a.pnl_usd AS a_pnl, c.pnl_usd AS c_pnl,
              a.win_rate AS a_wr, c.win_rate AS c_wr,
              a.max_drawdown AS a_mdd, c.max_drawdown AS c_mdd
         FROM arena_rows a FULL OUTER JOIN compared c USING (trader_key)
     )
     SELECT
       count(*) FILTER (WHERE a_key IS NOT NULL)                  AS arena_count,
       count(*) FILTER (WHERE c_key IS NOT NULL)                  AS compared_count,
       count(*) FILTER (WHERE a_key IS NOT NULL AND c_key IS NOT NULL) AS matched_keys,
       count(*) FILTER (WHERE c_key IS NULL)                      AS only_arena,
       count(*) FILTER (WHERE a_key IS NULL)                      AS only_compared,
       ${(['roi', 'pnl', 'wr', 'mdd'] as const)
         .map(
           (f) => `
       count(*) FILTER (WHERE a_key IS NOT NULL AND a_${f} IS NULL)  AS ${f}_arena_nulls,
       count(*) FILTER (WHERE c_key IS NOT NULL AND c_${f} IS NULL)  AS ${f}_shadow_nulls,
       count(*) FILTER (WHERE a_key IS NOT NULL AND c_key IS NOT NULL AND (
         (a_${f} IS NULL) <> (c_${f} IS NULL)
         OR abs(a_${f} - c_${f}) > ${TOLERANCE}))                    AS ${f}_mismatches,
       max(abs(a_${f} - c_${f})) FILTER (
         WHERE a_key IS NOT NULL AND c_key IS NOT NULL)              AS ${f}_max_delta`
         )
         .join(',')}
     FROM joined`,
    [sourceId, timeframe, platform, window]
  )

  const r = rows[0]
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))
  const fieldDiff = (f: 'roi' | 'pnl' | 'wr' | 'mdd'): FieldDiff => ({
    arena_nulls: Number(r[`${f}_arena_nulls`]),
    shadow_nulls: Number(r[`${f}_shadow_nulls`]),
    mismatches: Number(r[`${f}_mismatches`]),
    max_delta: num(r[`${f}_max_delta`]),
  })

  return {
    arena_count: Number(r.arena_count),
    compared_count: Number(r.compared_count),
    matched_keys: Number(r.matched_keys),
    only_arena: Number(r.only_arena),
    only_compared: Number(r.only_compared),
    fields: {
      roi_pct: fieldDiff('roi'),
      pnl_usd: fieldDiff('pnl'),
      win_rate: fieldDiff('wr'),
      max_drawdown: fieldDiff('mdd'),
    },
  }
}

function pct(n: number, total: number): string {
  if (total === 0) return '-'
  return `${((100 * n) / total).toFixed(1)}%`
}

function fmtDelta(d: number | null): string {
  if (d === null) return '-'
  return d < 0.0001 ? '0' : d.toFixed(4)
}

async function main() {
  const prefix = process.argv[2] ?? 'bitget'
  const { getIngestPool, closeIngestPool } = await import('@/lib/ingest/db')
  const pool = getIngestPool()

  const { rows: sources } = await pool.query<SourceRow>(
    `SELECT id, slug, serving_mode, currency,
            meta->>'legacy_platform' AS legacy_platform,
            meta ? 'legacy_platform' AS has_legacy_platform_key
       FROM arena.sources
      WHERE serving_mode <> 'legacy' AND slug LIKE $1
      ORDER BY id`,
    [`${prefix}%`]
  )

  if (sources.length === 0) {
    console.log(`No non-legacy arena.sources matching '${prefix}%' — nothing to diff.`)
    await closeIngestPool()
    return
  }

  console.log(`Shadow-diff: ${sources.length} source(s), tolerance ${TOLERANCE}\n`)

  const verdictRows: string[][] = []
  let anyFail = false

  for (const src of sources) {
    const platform = src.has_legacy_platform_key ? src.legacy_platform : src.slug
    if (!platform) {
      console.log(`-- ${src.slug}: compat writes disabled (legacy_platform=null), skipping`)
      continue
    }
    if (src.currency !== 'USDT') {
      console.log(`-- ${src.slug}: currency ${src.currency} never compat-written, skipping`)
      continue
    }

    for (const tf of [7, 30, 90]) {
      const window = WINDOW_BY_TF[tf]
      for (const side of ['shadow', 'legacy'] as const) {
        const d = await diffOne(pool, src.id, tf, platform, window, side)
        if (side === 'legacy' && d.compared_count === 0) continue // no legacy rows — skip noise

        const valueMismatches = FIELDS.reduce((s, f) => s + d.fields[f].mismatches, 0)
        // only_compared (rows in trader_latest but not in the latest arena
        // snapshot) is BENIGN: board membership churns and the compat write
        // is upsert-only — exactly the legacy connector's semantics, so
        // ex-board traders linger until their next appearance. Real
        // divergence is only_arena (compat MISSED rows it should have
        // written) or value mismatches on matched keys.
        const verdict =
          side === 'legacy'
            ? 'INFO'
            : d.arena_count === 0 && d.compared_count === 0
              ? 'EMPTY'
              : d.compared_count === 0
                ? 'NO-SHADOW' // dual-write hasn't run for this (source, tf) yet
                : d.only_arena === 0 && valueMismatches === 0
                  ? d.only_compared > 0
                    ? 'PASS*' // * = stale ex-board residue in trader_latest (upsert-only, legacy-equivalent)
                    : 'PASS'
                  : 'FAIL'
        if (verdict === 'FAIL') anyFail = true

        verdictRows.push([
          platform,
          window,
          side.toUpperCase(),
          String(d.arena_count),
          String(d.compared_count),
          String(d.matched_keys),
          `${d.only_arena}/${d.only_compared}`,
          FIELDS.map((f) => pct(d.fields[f].shadow_nulls, d.compared_count)).join(' '),
          FIELDS.map((f) => String(d.fields[f].mismatches)).join('/'),
          FIELDS.map((f) => fmtDelta(d.fields[f].max_delta)).join(' '),
          verdict,
        ])
      }
    }
  }

  const headers = [
    'platform',
    'window',
    'side',
    'arena',
    'rows',
    'matched',
    'onlyA/onlyB',
    'null% (roi pnl wr mdd)',
    'mismatch (roi/pnl/wr/mdd)',
    'maxΔ (roi pnl wr mdd)',
    'verdict',
  ]
  const widths = headers.map((h, i) => Math.max(h.length, ...verdictRows.map((r) => r[i].length)))
  const fmtRow = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join('  ')
  console.log(fmtRow(headers))
  console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const r of verdictRows) console.log(fmtRow(r))

  console.log(
    `\nVerdict: ${anyFail ? 'FAIL — shadow rows diverge from arena.* source of truth' : 'PASS — all written shadow rows match arena.* within tolerance'}`
  )
  console.log(
    '(NO-SHADOW = the compat dual-write has not run for that (source, tf) yet — expected\n during rollout; rows appear at the next Tier-A crawl. LEGACY side is informational:\n written by the old pipeline at a different crawl time, deltas there indicate semantic\n drift only if systematic, not timing skew.)'
  )

  await closeIngestPool()
  process.exit(anyFail ? 1 : 0)
}

main().catch((err) => {
  console.error('FAILED:', err)
  process.exit(1)
})
