#!/usr/bin/env node
/**
 * Search Open Library for book covers. Runs on VPS for better connectivity.
 * Only processes category='book' items without covers.
 */
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  'https://iknktzifjdyujdccyhsv.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const BATCH = 100

async function searchOL(title) {
  try {
    const q = encodeURIComponent(title.slice(0, 80))
    const res = await fetch(`https://openlibrary.org/search.json?title=${q}&limit=1&fields=cover_i`, {
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) return null
    const data = await res.json()
    if (data.docs?.[0]?.cover_i) {
      return `https://covers.openlibrary.org/b/id/${data.docs[0].cover_i}-L.jpg`
    }
  } catch {}
  return null
}

async function main() {
  console.log('=== Open Library Book Cover Search ===\n')
  let offset = 0, found = 0, checked = 0

  while (true) {
    const { data, error } = await sb
      .from('library_items')
      .select('id, title')
      .is('cover_url', null)
      .eq('category', 'book')
      .order('id')
      .range(offset, offset + BATCH - 1)

    if (error || !data?.length) break

    for (const item of data) {
      const url = await searchOL(item.title)
      checked++
      if (url) {
        await sb.from('library_items').update({ cover_url: url }).eq('id', item.id)
        found++
      }
      if (checked % 50 === 0) console.log(`  ${checked} checked, ${found} found`)
      await sleep(600)
    }

    offset += BATCH
    if (data.length < BATCH) break
  }

  console.log(`\nDone: ${checked} checked, ${found} covers found`)
}

main().catch(console.error)
