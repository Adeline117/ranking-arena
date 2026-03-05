/**
 * Backfill cover_url for library_items using Google Books API and Open Library API.
 * Usage: node /tmp/backfill_covers.mjs [--limit N] [--batch N]
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const args = process.argv.slice(2)
const TOTAL_LIMIT = parseInt(args.find((_, i, a) => a[i - 1] === '--limit') || '500')
const BATCH_SIZE = parseInt(args.find((_, i, a) => a[i - 1] === '--batch') || '50')

let stats = { total: 0, google: 0, openlib: 0, notFound: 0, errors: 0 }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function searchGoogleBooks(title, author) {
  try {
    let q = `intitle:${title}`
    if (author) q += `+inauthor:${author}`
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=1&fields=items(volumeInfo/imageLinks)`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    const links = data.items?.[0]?.volumeInfo?.imageLinks
    if (!links) return null
    // Prefer larger image, strip edge=curl, use https
    let img = links.thumbnail || links.smallThumbnail
    if (!img) return null
    img = img.replace('&edge=curl', '').replace('http://', 'https://')
    // Request larger zoom
    img = img.replace('zoom=1', 'zoom=2')
    return img
  } catch { return null }
}

async function searchOpenLibrary(title, author) {
  try {
    let q = `title=${encodeURIComponent(title)}`
    if (author) q += `&author=${encodeURIComponent(author)}`
    const url = `https://openlibrary.org/search.json?${q}&limit=1&fields=cover_i`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    const coverId = data.docs?.[0]?.cover_i
    if (!coverId) return null
    return `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`
  } catch { return null }
}

async function processBatch(items) {
  const updates = []

  for (const item of items) {
    stats.total++
    const title = (item.title || '').trim()
    if (!title) { stats.notFound++; continue }
    const author = (item.author || '').trim() || null

    // Try Google Books first
    let coverUrl = await searchGoogleBooks(title, author)
    if (coverUrl) {
      stats.google++
    } else {
      // Rate limit between APIs
      await sleep(200)
      coverUrl = await searchOpenLibrary(title, author)
      if (coverUrl) {
        stats.openlib++
      } else {
        stats.notFound++
      }
    }

    if (coverUrl) {
      updates.push({ id: item.id, cover_url: coverUrl })
    }

    // Rate limit: ~200ms between items
    await sleep(200)
  }

  // Batch update to Supabase
  if (updates.length > 0) {
    for (const u of updates) {
      const { error } = await supabase
        .from('library_items')
        .update({ cover_url: u.cover_url })
        .eq('id', u.id)
      if (error) {
        console.error(`  [ERROR] Failed to update ${u.id}: ${error.message}`)
        stats.errors++
      }
    }
  }

  return updates.length
}

async function main() {
  console.log(`Backfill covers: limit=${TOTAL_LIMIT}, batch=${BATCH_SIZE}`)
  console.log()

  let offset = 0
  let processed = 0

  while (processed < TOTAL_LIMIT) {
    const batchSize = Math.min(BATCH_SIZE, TOTAL_LIMIT - processed)
    const { data: items, error } = await supabase
      .from('library_items')
      .select('id, title, author')
      .is('cover_url', null)
      .order('view_count', { ascending: false })
      .range(offset, offset + batchSize - 1)

    if (error) {
      console.error(`Query error: ${error.message}`)
      break
    }
    if (!items || items.length === 0) {
      console.log('No more items without covers.')
      break
    }

    const found = await processBatch(items)
    processed += items.length
    // Don't increment offset by items.length since updated items drop out of the null filter
    // Only increment by items not found (they stay null)
    offset += (items.length - found)

    console.log(`[${processed}/${TOTAL_LIMIT}] Batch done: ${found}/${items.length} covers found | Google: ${stats.google}, OpenLib: ${stats.openlib}, NotFound: ${stats.notFound}, Errors: ${stats.errors}`)
  }

  console.log()
  console.log('=== Final Stats ===')
  console.log(`Processed: ${stats.total}`)
  console.log(`Google Books: ${stats.google}`)
  console.log(`Open Library: ${stats.openlib}`)
  console.log(`Not Found: ${stats.notFound}`)
  console.log(`Errors: ${stats.errors}`)
  console.log(`Hit Rate: ${((stats.google + stats.openlib) / Math.max(stats.total, 1) * 100).toFixed(1)}%`)
}

main().catch(console.error)
