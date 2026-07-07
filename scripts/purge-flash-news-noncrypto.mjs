#!/usr/bin/env node
/**
 * Purge historical non-crypto flash_news rows (U7-3 companion).
 *
 * The reclassify backfill only *recategorizes*; it cannot fix rows that are not
 * about crypto at all (funerals / World Cup / geopolitics that generic RSS feeds
 * dumped in). Those have no crypto keyword, so classifyCategory returns the
 * source fallback (defi) — which is why /flash-news "defi" was full of garbage.
 * The ingest-side isNonCrypto filter drops these going FORWARD; this one-time
 * script removes the historical ones using the SAME shared predicate.
 *
 * Usage (from repo root, needs .env.local):
 *   npx tsx scripts/purge-flash-news-noncrypto.mjs            # dry-run: count + sample
 *   npx tsx scripts/purge-flash-news-noncrypto.mjs --backup   # dry-run + export JSON
 *   npx tsx scripts/purge-flash-news-noncrypto.mjs --apply --backup   # delete (backup first)
 *
 * Conservative by construction: isNonCrypto returns true ONLY when the text has
 * ZERO crypto terms AND hits an obvious off-topic marker — real crypto news is
 * never touched.
 */
import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import { isNonCrypto } from '../lib/flash-news/classify.ts'

const U = process.env.NEXT_PUBLIC_SUPABASE_URL
const K = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!U || !K) throw new Error('missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')

const APPLY = process.argv.includes('--apply')
const BACKUP = process.argv.includes('--backup')
const H = { apikey: K, Authorization: `Bearer ${K}`, 'Content-Type': 'application/json' }

async function main() {
  const doomed = []
  const PAGE = 1000
  let from = 0
  for (;;) {
    const r = await fetch(
      `${U}/rest/v1/flash_news?select=id,title,content,category&order=id&offset=${from}&limit=${PAGE}`,
      { headers: H }
    )
    const rows = await r.json()
    if (!Array.isArray(rows) || rows.length === 0) break
    for (const row of rows) {
      if (isNonCrypto(row.title || '', row.content || null)) doomed.push(row)
    }
    if (rows.length < PAGE) break
    from += PAGE
  }

  console.log(`[purge-noncrypto] scanned all flash_news → ${doomed.length} non-crypto rows`)
  const byCat = {}
  for (const d of doomed) byCat[d.category] = (byCat[d.category] || 0) + 1
  console.log('[purge-noncrypto] by current category:', JSON.stringify(byCat))
  console.log('[purge-noncrypto] sample (up to 15):')
  for (const d of doomed.slice(0, 15)) console.log('   ✗', (d.title || '').slice(0, 80))

  if (BACKUP && doomed.length) {
    const dir = process.env.SCRATCHPAD || '/tmp'
    const path = `${dir}/flash-news-noncrypto-backup-${doomed.length}.json`
    writeFileSync(path, JSON.stringify(doomed, null, 2))
    console.log(`[purge-noncrypto] backup written: ${path}`)
  }

  if (!APPLY) {
    console.log('[purge-noncrypto] DRY-RUN — no deletes. Re-run with --apply (and --backup).')
    return
  }
  if (BACKUP === false) throw new Error('refusing --apply without --backup')

  let done = 0
  const BATCH = 50
  for (let i = 0; i < doomed.length; i += BATCH) {
    const ids = doomed.slice(i, i + BATCH).map((d) => d.id)
    const inList = `(${ids.map((x) => `"${x}"`).join(',')})`
    const res = await fetch(`${U}/rest/v1/flash_news?id=in.${inList}`, {
      method: 'DELETE',
      headers: H,
    })
    if (!res.ok) throw new Error(`delete failed at ${i}: ${res.status} ${await res.text()}`)
    done += ids.length
    process.stdout.write(`\r  deleted ${done}/${doomed.length}`)
    await new Promise((r) => setTimeout(r, 200))
  }
  console.log(`\n[purge-noncrypto] done. deleted ${done} non-crypto rows.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
