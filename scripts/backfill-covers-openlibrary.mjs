#!/usr/bin/env node
/**
 * Backfill cover_url for library_items where source='openlibrary'
 * using Open Library Covers API.
 *
 * Strategy: Extract OL work ID from source_url, try covers API.
 * The API returns a 1x1 transparent gif (43 bytes) when no cover exists,
 * so we check Content-Length to filter those out.
 *
 * Usage:
 *   node scripts/backfill-covers-openlibrary.mjs              # dry run
 *   node scripts/backfill-covers-openlibrary.mjs --apply       # apply updates
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'

const sb = createClient(SUPABASE_URL, SUPABASE_KEY)
const apply = process.argv.includes('--apply')
const CONCURRENCY = 20
const BATCH = 500

const sleep = ms => new Promise(r => setTimeout(r, ms))

function extractOlid(sourceUrl) {
  // https://openlibrary.org/works/OL17505565W → OL17505565W
  const m = sourceUrl?.match(/(OL\d+[WMA])/i)
  return m ? m[1] : null
}

async function checkCover(olid) {
  // Use HEAD request to check if cover exists (avoid downloading image)
  // Try work OLID first; covers API also indexes by work ID
  const url = `https://covers.openlibrary.org/b/olid/${olid}-M.jpg`
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const len = parseInt(res.headers.get('content-length') || '0', 10)
    // 1x1 placeholder is 43 bytes; real covers are much larger
    if (len > 1000) return url
    return null
  } catch {
    return null
  }
}

async function main() {
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}`)

  let offset = 0
  let total = 0, found = 0, skipped = 0, noOlid = 0, updated = 0

  while (true) {
    const { data: rows, error } = await sb
      .from('library_items')
      .select('id, source_url')
      .eq('source', 'openlibrary')
      .is('cover_url', null)
      .range(offset, offset + BATCH - 1)

    if (error) { console.error('DB error:', error.message); break }
    if (!rows?.length) break

    console.log(`\nBatch ${Math.floor(offset / BATCH) + 1}: ${rows.length} items (offset ${offset})`)

    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const chunk = rows.slice(i, i + CONCURRENCY)
      const results = await Promise.all(chunk.map(async row => {
        const olid = extractOlid(row.source_url)
        if (!olid) return { id: row.id, url: null, noOlid: true }
        const url = await checkCover(olid)
        return { id: row.id, url, noOlid: false }
      }))

      const toUpdate = []
      for (const r of results) {
        total++
        if (r.noOlid) { noOlid++; continue }
        if (r.url) {
          found++
          toUpdate.push(r)
        } else {
          skipped++
        }
      }

      if (apply && toUpdate.length > 0) {
        // Batch update
        for (const r of toUpdate) {
          const { error: uerr } = await sb
            .from('library_items')
            .update({ cover_url: r.url })
            .eq('id', r.id)
          if (uerr) console.error(`  ✗ ${r.id}: ${uerr.message}`)
          else updated++
        }
      }

      // Progress
      if (total % 200 === 0 || i + CONCURRENCY >= rows.length) {
        const pct = found ? ((found / (total - noOlid)) * 100).toFixed(1) : '0.0'
        console.log(`  processed=${total} found=${found} miss=${skipped} noOlid=${noOlid} hitRate=${pct}%${apply ? ` updated=${updated}` : ''}`)
      }
    }

    offset += BATCH
    // Small delay between batches to be polite
    await sleep(200)
  }

  console.log('\n=== Final Stats ===')
  console.log(`Total processed: ${total}`)
  console.log(`Covers found:    ${found}`)
  console.log(`No cover:        ${skipped}`)
  console.log(`No OLID:         ${noOlid}`)
  console.log(`Hit rate:        ${total - noOlid > 0 ? ((found / (total - noOlid)) * 100).toFixed(1) : 0}%`)
  if (apply) console.log(`Updated in DB:   ${updated}`)
}

main().catch(e => { console.error(e); process.exit(1) })
