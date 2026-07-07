#!/usr/bin/env node
/**
 * Backfill flash_news multilingual titles (U7-5).
 *
 * Fills missing title_zh / title_ja / title_ko (and title_en = original when
 * empty) for recent rows using the shared free-gtx translate helper in
 * lib/services/translate-server.ts — the SAME path the ingest cron uses.
 *
 * Scope-limited to the last N days (default 30, --days=N) so we never translate
 * the full 13k+ backlog in one shot. Idempotent + resume-friendly: only NULL
 * fields are filled, so re-running picks up where a previous run left off.
 * Rate-aware (gtx 429s easily): rows are processed serially with a small delay,
 * translating a row's missing targets concurrently. DRY-RUN by default.
 *
 * Must be run with tsx (it imports the TS translate helper):
 *   npx tsx scripts/backfill-flash-news-translate.mjs                 # dry-run, last 30d
 *   npx tsx scripts/backfill-flash-news-translate.mjs --days=7        # dry-run, last 7d
 *   npx tsx scripts/backfill-flash-news-translate.mjs --apply         # write, last 30d
 *   npx tsx scripts/backfill-flash-news-translate.mjs --days=14 --apply --limit=200
 */
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { translateText } from '../lib/services/translate-server.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadEnv() {
  const envPath = join(__dirname, '..', '.env.local')
  try {
    const content = readFileSync(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const match = line.match(/^([^=]+)=["']?(.+?)["']?$/)
      if (match) process.env[match[1]] = match[2]
    }
  } catch (e) {
    console.error('Failed to load .env.local:', e.message)
  }
}
loadEnv()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const DAYS = parseInt(args.find((a) => a.startsWith('--days='))?.split('=')[1] || '30', 10)
const LIMIT = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] || '0', 10)
const DELAY_MS = parseInt(args.find((a) => a.startsWith('--delay='))?.split('=')[1] || '200', 10)

const REST = `${SUPABASE_URL}/rest/v1`
const authHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
}

const PAGE = 500
const TARGETS = ['zh', 'ja', 'ko']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Fetch recent rows missing at least one of title_zh/ja/ko.
async function fetchRowsNeedingTitles(sinceISO) {
  const rows = []
  const filter =
    `published_at=gte.${sinceISO}` +
    `&or=(title_zh.is.null,title_ja.is.null,title_ko.is.null)` +
    `&order=published_at.desc`
  for (let from = 0; ; from += PAGE) {
    const to = from + PAGE - 1
    const url = `${REST}/flash_news?select=id,title,title_en,title_zh,title_ja,title_ko&${filter}`
    const res = await fetch(url, {
      headers: { ...authHeaders, Range: `${from}-${to}`, Prefer: 'count=none' },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`GET flash_news ${res.status}: ${body}`)
    }
    const batch = await res.json()
    rows.push(...batch)
    if (batch.length < PAGE) break
    if (LIMIT && rows.length >= LIMIT) break
  }
  return LIMIT ? rows.slice(0, LIMIT) : rows
}

async function patchRow(id, update) {
  const url = `${REST}/flash_news?id=eq.${encodeURIComponent(id)}`
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(update),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`PATCH flash_news ${res.status}: ${body}`)
  }
}

const isEmpty = (v) => v === null || v === undefined || String(v).trim() === ''

async function main() {
  const sinceISO = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString()
  console.log(
    `[translate-backfill] mode=${APPLY ? 'APPLY' : 'DRY-RUN'} days=${DAYS} since=${sinceISO}` +
      `${LIMIT ? ` limit=${LIMIT}` : ''} delay=${DELAY_MS}ms`
  )

  const rows = await fetchRowsNeedingTitles(sinceISO)
  console.log(`[translate-backfill] ${rows.length} rows missing ≥1 of title_zh/ja/ko`)

  // Missing-target tally for the plan summary.
  const missing = { zh: 0, ja: 0, ko: 0, title_en: 0 }
  for (const r of rows) {
    if (isEmpty(r.title_zh)) missing.zh++
    if (isEmpty(r.title_ja)) missing.ja++
    if (isEmpty(r.title_ko)) missing.ko++
    if (isEmpty(r.title_en)) missing.title_en++
  }
  console.log(
    `[translate-backfill] missing fields — zh:${missing.zh} ja:${missing.ja} ko:${missing.ko}` +
      ` title_en:${missing.title_en}`
  )

  if (!APPLY) {
    console.log('[translate-backfill] DRY-RUN — no gtx calls, no writes. Re-run with --apply.')
    return
  }

  let updated = 0
  let filled = { zh: 0, ja: 0, ko: 0 }
  let failed = 0
  for (const row of rows) {
    const source = !isEmpty(row.title_en) ? row.title_en : row.title
    if (isEmpty(source)) continue

    const update = {}
    // title_en = English original when missing (frontend fallback anchor).
    if (isEmpty(row.title_en)) update.title_en = row.title

    const wanted = TARGETS.filter((tl) => isEmpty(row[`title_${tl}`]))
    const results = await Promise.all(
      wanted.map(async (tl) => [tl, await translateText(source, tl, 'en')])
    )
    for (const [tl, text] of results) {
      if (text) {
        update[`title_${tl}`] = text
        filled[tl]++
      } else {
        failed++
      }
    }

    if (Object.keys(update).length > 0) {
      await patchRow(row.id, update)
      updated++
      if (updated % 25 === 0) {
        console.log(`[translate-backfill] progress ${updated}/${rows.length} rows written`)
      }
    }
    await sleep(DELAY_MS)
  }

  console.log(
    `[translate-backfill] done. rows updated=${updated}` +
      ` filled zh:${filled.zh} ja:${filled.ja} ko:${filled.ko} translate-failures=${failed}`
  )
  if (failed > 0) {
    console.log(
      '[translate-backfill] some translations failed (gtx null) — safe to re-run to fill them.'
    )
  }
}

main().catch((e) => {
  console.error('[translate-backfill] FAILED:', e.message)
  process.exit(1)
})
