#!/usr/bin/env node
/**
 * Backfill cover_url for library_items where source='openlibrary'
 * using Open Library Covers API.
 *
 * Strategy:
 *   1. Extract OL work ID from source_url
 *   2. Fetch /works/{ID}/editions.json to find a cover ID
 *   3. Build cover URL: https://covers.openlibrary.org/b/id/{COVER_ID}-M.jpg
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
const CONCURRENCY = 5  // Be polite to OL API
const BATCH = 500

const sleep = ms => new Promise(r => setTimeout(r, ms))

function extractWorkId(sourceUrl) {
  const m = sourceUrl?.match(/works\/(OL\d+W)/i)
  return m ? m[1] : null
}

async function getCoverUrl(workId) {
  try {
    const res = await fetch(
      `https://openlibrary.org/works/${workId}/editions.json?limit=10`,
      { signal: AbortSignal.timeout(15000) }
    )
    if (!res.ok) return null
    const data = await res.json()
    // Find first edition with a cover
    for (const ed of data.entries || []) {
      if (ed.covers?.length) {
        const coverId = ed.covers.find(c => c > 0)
        if (coverId) return `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`
      }
    }
    return null
  } catch {
    return null
  }
}

async function main() {
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}`)

  let offset = 0
  let total = 0, found = 0, skipped = 0, noId = 0, updated = 0, errors = 0

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
        const workId = extractWorkId(row.source_url)
        if (!workId) return { id: row.id, url: null, noId: true }
        const url = await getCoverUrl(workId)
        return { id: row.id, url, noId: false }
      }))

      const toUpdate = []
      for (const r of results) {
        total++
        if (r.noId) { noId++; continue }
        if (r.url) {
          found++
          toUpdate.push(r)
        } else {
          skipped++
        }
      }

      if (apply && toUpdate.length > 0) {
        for (const r of toUpdate) {
          const { error: uerr } = await sb
            .from('library_items')
            .update({ cover_url: r.url })
            .eq('id', r.id)
          if (uerr) { console.error(`  ✗ ${r.id}: ${uerr.message}`); errors++ }
          else updated++
        }
      }

      if (total % 100 === 0 || i + CONCURRENCY >= rows.length) {
        const valid = total - noId
        const pct = valid > 0 ? ((found / valid) * 100).toFixed(1) : '0.0'
        console.log(`  processed=${total} found=${found} miss=${skipped} noId=${noId} hitRate=${pct}%${apply ? ` updated=${updated}` : ''}`)
      }

      // Rate limit: ~5 req/s to OL API
      await sleep(100)
    }

    offset += BATCH
  }

  console.log('\n=== Final Stats ===')
  console.log(`Total processed: ${total}`)
  console.log(`Covers found:    ${found}`)
  console.log(`No cover:        ${skipped}`)
  console.log(`No work ID:      ${noId}`)
  const valid = total - noId
  console.log(`Hit rate:        ${valid > 0 ? ((found / valid) * 100).toFixed(1) : 0}%`)
  if (apply) console.log(`Updated in DB:   ${updated}`)
  if (errors) console.log(`Errors:          ${errors}`)
}

main().catch(e => { console.error(e); process.exit(1) })
