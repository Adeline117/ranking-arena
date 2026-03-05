#!/usr/bin/env node
/**
 * Comprehensive cover backfill for library_items.
 * Strategy:
 *   1. ISBN → Open Library covers (fast, reliable)
 *   2. Books → Google Books API (title+author)
 *   3. Books → Open Library search (title+author)
 *   4. Papers → Crossref (sometimes has links/cover)
 * 
 * Papers/whitepapers without covers use the frontend BookCover.tsx fallback.
 * 
 * Usage:
 *   node scripts/backfill-covers-v2.mjs                    # dry run, 100 items
 *   node scripts/backfill-covers-v2.mjs --apply             # apply all
 *   node scripts/backfill-covers-v2.mjs --apply --limit 500
 *   node scripts/backfill-covers-v2.mjs --apply --category book
 *   node scripts/backfill-covers-v2.mjs --apply --isbn-only
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'

const sb = createClient(SUPABASE_URL, SUPABASE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const args = process.argv.slice(2)
const DRY_RUN = !args.includes('--apply')
const ISBN_ONLY = args.includes('--isbn-only')
const LIMIT_IDX = args.indexOf('--limit')
const MAX_ITEMS = LIMIT_IDX !== -1 ? parseInt(args[LIMIT_IDX + 1]) : (DRY_RUN ? 100 : 999999)
const NO_GOOGLE = args.includes('--no-google')
const CAT_IDX = args.indexOf('--category')
const CATEGORY_FILTER = CAT_IDX !== -1 ? args[CAT_IDX + 1] : null
const BATCH_SIZE = 200
const GOOGLE_DELAY = 3000  // ms between Google API calls  
const OL_DELAY = 1000

const stats = { processed: 0, google: 0, openlib: 0, isbn: 0, crossref: 0, skipped: 0, errors: 0 }

// ---- API helpers ----

async function fetchWithRetry(url, opts = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000), ...opts })
      if (res.status === 429) {
        const wait = Math.min(120000, (i + 1) * 30000)
        console.warn(`  ⚠ 429 rate limited, waiting ${wait/1000}s...`)
        await sleep(wait)
        continue
      }
      return res
    } catch (e) {
      if (i === retries) return null
      await sleep(2000)
    }
  }
  return null
}

async function tryIsbnCover(isbn) {
  // Use Open Library search API to check if ISBN has a cover
  const url = `https://openlibrary.org/search.json?isbn=${encodeURIComponent(isbn)}&limit=1&fields=cover_i`
  const res = await fetchWithRetry(url, { headers: { 'User-Agent': 'ArenaBot/1.0' } })
  if (!res || !res.ok) return null
  try {
    const data = await res.json()
    const coverId = data.docs?.[0]?.cover_i
    if (coverId) return `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`
    // Fallback: just use ISBN URL directly (openlibrary will serve it if exists)
    return `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`
  } catch {}
  return null
}

async function searchGoogleBooks(title, author) {
  const cleanTitle = title.replace(/[""''「」『』\[\]()（）]/g, '').trim()
  if (!cleanTitle) return null
  
  let q = `intitle:${cleanTitle}`
  if (author) {
    const cleanAuthor = author.split(/[,;，；&]/).map(a => a.trim()).filter(Boolean)[0]
    if (cleanAuthor) q += `+inauthor:${cleanAuthor}`
  }
  
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=3&fields=items(volumeInfo(title,authors,imageLinks))`
  const res = await fetchWithRetry(url)
  if (!res || !res.ok) return null
  
  const data = await res.json()
  if (!data.items?.length) return null
  
  // Find best match
  const titleLower = cleanTitle.toLowerCase()
  for (const item of data.items) {
    const img = item.volumeInfo?.imageLinks
    if (!img) continue
    let cover = img.thumbnail || img.smallThumbnail
    if (!cover) continue
    cover = cover.replace('&edge=curl', '').replace('http://', 'https://').replace('zoom=1', 'zoom=2')
    return cover
  }
  return null
}

async function searchOpenLibrary(title, author) {
  const cleanTitle = title.replace(/[""''「」『』\[\]()（）]/g, '').trim()
  if (!cleanTitle) return null
  
  let q = `title=${encodeURIComponent(cleanTitle)}`
  if (author) {
    const cleanAuthor = author.split(/[,;，；&]/).map(a => a.trim()).filter(Boolean)[0]
    if (cleanAuthor) q += `&author=${encodeURIComponent(cleanAuthor)}`
  }
  
  const url = `https://openlibrary.org/search.json?${q}&limit=1&fields=cover_i`
  const res = await fetchWithRetry(url, { headers: { 'User-Agent': 'ArenaBot/1.0' } })
  if (!res || !res.ok) return null
  
  const data = await res.json()
  const coverId = data.docs?.[0]?.cover_i
  if (!coverId) return null
  return `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`
}

// ---- Main logic ----

async function fetchItems(offset) {
  let query = sb
    .from('library_items')
    .select('id, title, author, category, isbn, doi')
    .is('cover_url', null)
    .order('id')
    .range(offset, offset + BATCH_SIZE - 1)
  
  if (CATEGORY_FILTER) query = query.eq('category', CATEGORY_FILTER)
  if (ISBN_ONLY) query = query.not('isbn', 'is', null)
  
  const { data, error } = await query
  if (error) { console.error('DB error:', error.message); return [] }
  return data || []
}

async function processItem(item) {
  const { title, author, category, isbn } = item
  if (!title?.trim()) { stats.skipped++; return null }
  
  // 1. Try ISBN first (fastest)
  if (isbn) {
    const cover = await tryIsbnCover(isbn.trim())
    if (cover) { stats.isbn++; return cover }
    await sleep(200)
  }
  
  if (ISBN_ONLY) { stats.skipped++; return null }
  
  const isBook = !category || category === 'book'
  
  if (isBook || category === 'finance') {
    // 2. Open Library first (more generous rate limits)
    await sleep(OL_DELAY)
    const olCover = await searchOpenLibrary(title, author)
    if (olCover) { stats.openlib++; return olCover }
    
    // 3. Google Books as fallback
    if (!NO_GOOGLE) {
      await sleep(GOOGLE_DELAY)
      const gCover = await searchGoogleBooks(title, author)
      if (gCover) { stats.google++; return gCover }
    }
  }
  
  // Papers/whitepapers: skip API search, rely on frontend fallback
  stats.skipped++
  return null
}

async function main() {
  console.log(`\n📚 Library Cover Backfill v2`)
  console.log(`   Mode: ${DRY_RUN ? 'DRY RUN' : 'APPLY'}`)
  console.log(`   Limit: ${MAX_ITEMS}`)
  if (CATEGORY_FILTER) console.log(`   Category: ${CATEGORY_FILTER}`)
  if (ISBN_ONLY) console.log(`   ISBN only mode`)
  console.log()
  
  let offset = 0
  let totalUpdated = 0
  const pendingUpdates = []
  
  while (stats.processed < MAX_ITEMS) {
    const items = await fetchItems(offset)
    if (!items.length) break
    offset += BATCH_SIZE
    
    for (const item of items) {
      if (stats.processed >= MAX_ITEMS) break
      stats.processed++
      
      const cover = await processItem(item)
      if (cover) {
        pendingUpdates.push({ id: item.id, cover_url: cover })
      }
      
      // Flush updates every 50
      if (pendingUpdates.length >= 50) {
        if (!DRY_RUN) {
          for (const u of pendingUpdates) {
            const { error } = await sb.from('library_items').update({ cover_url: u.cover_url }).eq('id', u.id)
            if (error) stats.errors++
          }
        }
        totalUpdated += pendingUpdates.length
        pendingUpdates.length = 0
      }
      
      // Progress
      if (stats.processed % 50 === 0) {
        const found = stats.google + stats.openlib + stats.isbn + stats.crossref
        console.log(`  [${stats.processed}] found=${found} (isbn=${stats.isbn} google=${stats.google} ol=${stats.openlib}) skipped=${stats.skipped} errors=${stats.errors}`)
      }
    }
  }
  
  // Flush remaining
  if (pendingUpdates.length > 0) {
    if (!DRY_RUN) {
      for (const u of pendingUpdates) {
        const { error } = await sb.from('library_items').update({ cover_url: u.cover_url }).eq('id', u.id)
        if (error) stats.errors++
      }
    }
    totalUpdated += pendingUpdates.length
  }
  
  const found = stats.google + stats.openlib + stats.isbn + stats.crossref
  console.log(`\n✅ Done!`)
  console.log(`   Processed: ${stats.processed}`)
  console.log(`   Found covers: ${found}`)
  console.log(`     - ISBN: ${stats.isbn}`)
  console.log(`     - Google Books: ${stats.google}`)
  console.log(`     - Open Library: ${stats.openlib}`)
  console.log(`   Skipped (papers/no match): ${stats.skipped}`)
  console.log(`   Errors: ${stats.errors}`)
  console.log(`   ${DRY_RUN ? 'Would update' : 'Updated'}: ${totalUpdated}`)
}

main().catch(console.error)
