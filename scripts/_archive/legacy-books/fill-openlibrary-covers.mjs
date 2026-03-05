#!/usr/bin/env node
// Fill cover_url for OpenLibrary items missing covers
// Uses OpenLibrary Covers API via edition OLID
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'

const sb = createClient(SUPABASE_URL, SUPABASE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))

let found = 0, notFound = 0, errors = 0

async function getEditionOlid(worksUrl) {
  // Extract works ID from URL like https://openlibrary.org/works/OL12345W
  const match = worksUrl.match(/works\/(OL\d+W)/)
  if (!match) return null

  try {
    const res = await fetch(`https://openlibrary.org/works/${match[1]}/editions.json?limit=1`, {
      headers: { 'User-Agent': 'ArenaBot/1.0 (arena@example.com)' },
    })
    if (!res.ok) return null
    const data = await res.json()
    if (data.entries && data.entries.length > 0) {
      const edKey = data.entries[0].key // e.g. /books/OL12345M
      const edMatch = edKey.match(/(OL\d+M)/)
      return edMatch ? edMatch[1] : null
    }
  } catch {}
  return null
}

function getCoverUrl(olid) {
  return `https://covers.openlibrary.org/b/olid/${olid}-L.jpg`
}

async function main() {
  console.log('=== Fill OpenLibrary Covers ===\n')

  let offset = 0
  const batchSize = 200

  while (true) {
    const { data, error } = await sb
      .from('library_items')
      .select('id, source_url')
      .in('source', ['openlibrary', 'open_library'])
      .is('cover_url', null)
      .not('source_url', 'is', null)
      .range(offset, offset + batchSize - 1)

    if (error) { console.error('Fetch error:', error.message); break }
    if (!data || data.length === 0) break

    console.log(`Processing batch of ${data.length} (offset ${offset})...`)

    for (const item of data) {
      try {
        const olid = await getEditionOlid(item.source_url)
        if (!olid) { notFound++; continue }

        const coverUrl = getCoverUrl(olid)
        // Verify the cover exists (OL returns a 1x1 pixel for missing covers)
        const check = await fetch(coverUrl, { method: 'HEAD', redirect: 'follow' })
        const len = parseInt(check.headers.get('content-length') || '0')
        if (!check.ok || len < 1000) { notFound++; continue }

        await sb.from('library_items').update({ cover_url: coverUrl }).eq('id', item.id)
        found++
        if (found % 50 === 0) console.log(`  found: ${found}, not found: ${notFound}`)
      } catch {
        errors++
      }
      await sleep(200) // respect OL rate limits
    }

    offset += batchSize
    if (data.length < batchSize) break
  }

  console.log('\n=== Summary ===')
  console.log(`Covers found:     ${found}`)
  console.log(`Covers not found: ${notFound}`)
  console.log(`Errors:           ${errors}`)
}

main().catch(console.error)
