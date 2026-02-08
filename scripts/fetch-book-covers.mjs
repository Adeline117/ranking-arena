#!/usr/bin/env node
/**
 * Fetch book covers from Google Books API for library_items missing cover_url.
 * Usage:
 *   node scripts/fetch-book-covers.mjs              # dry run
 *   node scripts/fetch-book-covers.mjs --apply       # actually update DB
 *   node scripts/fetch-book-covers.mjs --apply --limit 200
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'

const sb = createClient(SUPABASE_URL, SUPABASE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const args = process.argv.slice(2)
const DRY_RUN = !args.includes('--apply')
const LIMIT_ARG = args.indexOf('--limit')
const MAX_ITEMS = LIMIT_ARG !== -1 ? parseInt(args[LIMIT_ARG + 1]) : Infinity
const BATCH_SIZE = 50
const API_DELAY_MS = 500 // conservative rate to avoid 429s

let matched = 0, missed = 0, errors = 0, processed = 0

/**
 * Search Google Books API by title. Returns thumbnail URL or null.
 */
async function searchGoogleBooks(title) {
  const q = encodeURIComponent(title.replace(/[""'']/g, ''))
  const url = `https://www.googleapis.com/books/v1/volumes?q=intitle:${q}&maxResults=3&fields=items(volumeInfo(title,imageLinks))`

  try {
    let res = await fetch(url)
    if (res.status === 429) {
      console.warn('  ⚠ Rate limited, waiting 60s...')
      await sleep(60000)
      res = await fetch(url)
    }
    if (!res.ok) return null

    const data = await res.json()
    if (!data.items || data.items.length === 0) return null

    // Find best match: prefer exact-ish title match
    const titleLower = title.toLowerCase().trim()
    for (const item of data.items) {
      const img = item.volumeInfo?.imageLinks
      if (!img) continue
      const coverUrl = img.thumbnail || img.smallThumbnail
      if (!coverUrl) continue

      const bookTitle = (item.volumeInfo.title || '').toLowerCase().trim()
      if (bookTitle === titleLower || titleLower.includes(bookTitle) || bookTitle.includes(titleLower)) {
        // Upgrade to larger image by replacing zoom parameter
        return coverUrl.replace('zoom=1', 'zoom=2').replace('http://', 'https://')
      }
    }

    // Fallback: return first result with an image
    for (const item of data.items) {
      const img = item.volumeInfo?.imageLinks
      const coverUrl = img?.thumbnail || img?.smallThumbnail
      if (coverUrl) {
        return coverUrl.replace('zoom=1', 'zoom=2').replace('http://', 'https://')
      }
    }

    return null
  } catch (err) {
    errors++
    return null
  }
}

/**
 * Fallback: Search Open Library by title. Returns cover URL or null.
 */
async function searchOpenLibrary(title) {
  const q = encodeURIComponent(title)
  const url = `https://openlibrary.org/search.json?title=${q}&limit=3&fields=key,title,cover_i`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'RankingArena/1.0 (book-cover-fetcher)' },
    })
    if (!res.ok) return null
    const data = await res.json()
    if (!data.docs || data.docs.length === 0) return null

    for (const doc of data.docs) {
      if (doc.cover_i) {
        return `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Combined search: Google Books first, then Open Library fallback.
 */
async function findCover(title) {
  const gCover = await searchGoogleBooks(title)
  if (gCover) return gCover
  await sleep(200)
  return searchOpenLibrary(title)
}

async function processBatch(items) {
  for (const item of items) {
    if (processed >= MAX_ITEMS) return

    const coverUrl = await findCover(item.title)
    processed++

    if (coverUrl) {
      matched++
      if (DRY_RUN) {
        console.log(`  ✓ [${matched}] "${item.title}" → ${coverUrl.substring(0, 80)}...`)
      } else {
        const { error } = await sb
          .from('library_items')
          .update({ cover_url: coverUrl })
          .eq('id', item.id)
        if (error) {
          console.error(`  ✗ DB update failed for "${item.title}":`, error.message)
          errors++
        } else {
          console.log(`  ✓ Updated "${item.title}"`)
        }
      }
    } else {
      missed++
      if (processed <= 200 || missed % 50 === 0) {
        console.log(`  ✗ No cover: "${item.title}"`)
      }
    }

    await sleep(API_DELAY_MS)
  }
}

async function main() {
  console.log(`=== Fetch Book Covers via Google Books API ===`)
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (use --apply to update DB)' : 'APPLY'}`)
  console.log(`Max items: ${MAX_ITEMS === Infinity ? 'all' : MAX_ITEMS}\n`)

  // Count total
  const { count } = await sb
    .from('library_items')
    .select('id', { count: 'exact', head: true })
    .eq('category', 'book')
    .is('cover_url', null)

  console.log(`Books missing covers: ${count}\n`)

  let offset = 0
  while (offset < count && processed < MAX_ITEMS) {
    const { data, error } = await sb
      .from('library_items')
      .select('id, title')
      .eq('category', 'book')
      .is('cover_url', null)
      .order('created_at', { ascending: true })
      .range(offset, offset + BATCH_SIZE - 1)

    if (error || !data || data.length === 0) break

    console.log(`\n--- Batch ${Math.floor(offset / BATCH_SIZE) + 1} (offset ${offset}, ${data.length} items) ---`)
    await processBatch(data)
    offset += BATCH_SIZE
  }

  console.log(`\n=== Results ===`)
  console.log(`Processed: ${processed}`)
  console.log(`Matched:   ${matched} (${(matched / processed * 100).toFixed(1)}%)`)
  console.log(`Missed:    ${missed}`)
  console.log(`Errors:    ${errors}`)

  if (DRY_RUN) {
    console.log(`\nThis was a DRY RUN. Run with --apply to update the database.`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
