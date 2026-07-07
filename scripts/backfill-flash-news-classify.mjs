#!/usr/bin/env node
/**
 * Backfill flash_news.category using the shared content classifier (U7-5).
 *
 * Reads every flash_news row and re-classifies it with classifyCategory(title,
 * content, fallback) from lib/flash-news/classify.ts — the SAME classifier the
 * ingest cron uses (single source of truth). Rows whose computed canonical
 * category differs from the stored one are UPDATEd. Legacy values (crypto /
 * market / regulation) normalize to their canonical equivalents.
 *
 * Safety: idempotent (re-running only touches rows still mismatched), batched,
 * rate-aware, and DRY-RUN by default. Nothing is written without --apply.
 *
 * Must be run with tsx (it imports the TS classifier):
 *   npx tsx scripts/backfill-flash-news-classify.mjs             # dry-run (default)
 *   npx tsx scripts/backfill-flash-news-classify.mjs --apply     # actually write
 *   npx tsx scripts/backfill-flash-news-classify.mjs --limit=500 # cap rows scanned
 */
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { classifyCategory } from '../lib/flash-news/classify.ts'

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
const LIMIT = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] || '0', 10)

// Map stored (possibly legacy) category → canonical fallback used when no
// keyword matches, so no-match rows still normalize to a canonical value.
const LEGACY_TO_CANONICAL = {
  crypto: 'btc_eth',
  market: 'altcoin',
  regulation: 'macro',
  btc_eth: 'btc_eth',
  altcoin: 'altcoin',
  defi: 'defi',
  macro: 'macro',
  exchange: 'exchange',
}

const REST = `${SUPABASE_URL}/rest/v1`
const authHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
}

const PAGE = 1000

async function fetchAllRows() {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const to = from + PAGE - 1
    const url = `${REST}/flash_news?select=id,title,content,category&order=published_at.desc`
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

// PATCH one category value onto many ids (chunked to keep the URL bounded).
async function patchCategory(category, ids) {
  const CHUNK = 100
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const inList = chunk.map((id) => `"${id}"`).join(',')
    const url = `${REST}/flash_news?id=in.(${inList})`
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ category }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`PATCH flash_news ${res.status}: ${body}`)
    }
  }
}

async function main() {
  console.log(
    `[classify-backfill] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}${LIMIT ? ` limit=${LIMIT}` : ''}`
  )
  const rows = await fetchAllRows()
  console.log(`[classify-backfill] scanned ${rows.length} rows`)

  // Group changed rows by target category for batched PATCH.
  const changesByCategory = new Map() // newCat -> [id]
  const fromToDist = new Map() // "old→new" -> count
  for (const row of rows) {
    const fallback = LEGACY_TO_CANONICAL[row.category] || 'btc_eth'
    const newCat = classifyCategory(row.title || '', row.content || null, fallback)
    if (newCat !== row.category) {
      if (!changesByCategory.has(newCat)) changesByCategory.set(newCat, [])
      changesByCategory.get(newCat).push(row.id)
      const key = `${row.category ?? 'null'} → ${newCat}`
      fromToDist.set(key, (fromToDist.get(key) || 0) + 1)
    }
  }

  const totalChanges = [...changesByCategory.values()].reduce((a, b) => a + b.length, 0)
  console.log(`[classify-backfill] ${totalChanges} rows would change category`)
  console.log('[classify-backfill] transition distribution:')
  for (const [k, v] of [...fromToDist.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k}: ${v}`)
  }
  console.log('[classify-backfill] resulting new-category totals:')
  for (const [cat, ids] of [...changesByCategory.entries()].sort(
    (a, b) => b[1].length - a[1].length
  )) {
    console.log(`    ${cat}: +${ids.length}`)
  }

  if (!APPLY) {
    console.log('[classify-backfill] DRY-RUN — no writes. Re-run with --apply to persist.')
    return
  }

  let written = 0
  for (const [cat, ids] of changesByCategory) {
    await patchCategory(cat, ids)
    written += ids.length
    console.log(`[classify-backfill] wrote ${ids.length} → ${cat} (${written}/${totalChanges})`)
  }
  console.log(`[classify-backfill] done. Updated ${written} rows.`)
}

main().catch((e) => {
  console.error('[classify-backfill] FAILED:', e.message)
  process.exit(1)
})
