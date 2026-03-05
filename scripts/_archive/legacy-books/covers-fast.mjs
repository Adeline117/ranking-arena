#!/usr/bin/env node
/**
 * Fast cover backfill — no Google API dependency.
 * 
 * Strategy:
 * 1. Open Library search by title (no rate limit, generous)
 * 2. For papers: generate deterministic cover URL using a placeholder service
 * 3. Batch update 500 at a time
 */
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  'https://iknktzifjdyujdccyhsv.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const DRY_RUN = !process.argv.includes('--apply')
const BATCH = 1000

// Deterministic color from string hash
function hashColor(str) {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash)
  }
  const h = Math.abs(hash) % 360
  return `hsl(${h}, 45%, 35%)`
}

// Generate a placeholder cover URL using placehold.co or similar
// These are real URLs that return images
function generatePlaceholderCover(title, author, category) {
  // Use DiceBear API for deterministic, unique covers
  const seed = encodeURIComponent((title || '').slice(0, 50))
  // Shapes style gives abstract, book-cover-like patterns
  return `https://api.dicebear.com/7.x/shapes/svg?seed=${seed}&size=300&backgroundColor=0f172a,1e293b,312e81,1e3a5f,3b0764`
}

async function searchOpenLibrary(title) {
  try {
    const q = encodeURIComponent(title.slice(0, 100))
    const res = await fetch(`https://openlibrary.org/search.json?title=${q}&limit=1&fields=cover_i`, {
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) return null
    const data = await res.json()
    if (data.docs?.[0]?.cover_i) {
      return `https://covers.openlibrary.org/b/id/${data.docs[0].cover_i}-L.jpg`
    }
    return null
  } catch {
    return null
  }
}

async function main() {
  console.log(`=== Fast Cover Backfill ${DRY_RUN ? '(DRY RUN)' : ''} ===`)
  console.log(`Started: ${new Date().toISOString()}\n`)

  let offset = 0
  let totalUpdated = 0
  let totalOL = 0
  let totalGenerated = 0

  while (true) {
    const { data: items, error } = await sb
      .from('library_items')
      .select('id, title, author, category')
      .is('cover_url', null)
      .order('id')
      .range(offset, offset + BATCH - 1)

    if (error) { console.error('Fetch error:', error.message); break }
    if (!items || items.length === 0) break

    console.log(`Batch ${offset}-${offset + items.length}: ${items.length} items`)

    const updates = []

    for (const item of items) {
      let cover_url = null

      // Try Open Library first for books
      if (item.category === 'book' && item.title) {
        cover_url = await searchOpenLibrary(item.title)
        if (cover_url) {
          totalOL++
        }
        await sleep(500) // gentle rate limit for OL
      }

      // If no real cover found, use DiceBear generated
      if (!cover_url && item.title) {
        cover_url = generatePlaceholderCover(item.title, item.author, item.category)
        totalGenerated++
      }

      if (cover_url) {
        updates.push({ id: item.id, cover_url })
      }
    }

    // Batch update
    if (!DRY_RUN && updates.length > 0) {
      for (const u of updates) {
        await sb.from('library_items').update({ cover_url: u.cover_url }).eq('id', u.id)
      }
    }

    totalUpdated += updates.length
    console.log(`  Updated: ${updates.length} (OL: ${totalOL}, Generated: ${totalGenerated})`)
    
    offset += BATCH
    if (items.length < BATCH) break
  }

  console.log(`\nDone. Total: ${totalUpdated} (OpenLibrary: ${totalOL}, Generated: ${totalGenerated})`)
  console.log(`Finished: ${new Date().toISOString()}`)
}

main().catch(console.error)
