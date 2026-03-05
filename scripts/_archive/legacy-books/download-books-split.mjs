#!/usr/bin/env node
/**
 * Split architecture: 
 * - Mac Mini: searches Anna's Archive (not blocked) → generates download tasks
 * - Japan VPS: downloads from LibGen (fast) → uploads to Supabase
 * 
 * Phase 1 (this script on Mac Mini): Search + get download URLs → write tasks.json
 * Phase 2 (vps-downloader.mjs on Japan VPS): Read tasks.json → download + upload
 */

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_KEY) { console.error('Set SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const SEARCH_DELAY = 2500

function extractMd5FromSearch(html) {
  const matches = html.match(/\/md5\/([a-f0-9]{32})/g)
  if (!matches) return []
  return [...new Set(matches.map(m => m.replace('/md5/', '')))]
}

async function searchAnnasArchive(title, author) {
  const query = encodeURIComponent(`${title} ${author || ''}`.trim())
  try {
    const res = await fetch(`https://annas-archive.li/search?q=${query}&ext=epub`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return []
    const html = await res.text()
    return extractMd5FromSearch(html)
  } catch {
    return []
  }
}

async function getDownloadUrl(md5) {
  try {
    const res = await fetch(`https://libgen.li/ads.php?md5=${md5}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh)' },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const html = await res.text()
    const match = html.match(/get\.php\?md5=([a-f0-9]+)&amp;key=([A-Z0-9]+)/i) 
      || html.match(/get\.php\?md5=([a-f0-9]+)&key=([A-Z0-9]+)/i)
    if (!match) return null
    return `https://libgen.li/get.php?md5=${match[1]}&key=${match[2]}`
  } catch {
    return null
  }
}

async function main() {
  const maxBooks = parseInt(process.argv[2] || '500')
  console.log(`Searching up to ${maxBooks} books...`)
  
  const tasks = []
  let offset = 0
  let searched = 0
  const BATCH = 50
  
  while (searched < maxBooks) {
    const { data: books, error } = await supabase
      .from('library_items')
      .select('id, title, author')
      .is('epub_url', null)
      .is('pdf_url', null)
      .is('file_key', null)
      .eq('category', 'book')
      .order('view_count', { ascending: false, nullsFirst: false })
      .range(offset, offset + BATCH - 1)
    
    if (error) { console.error('DB error:', error); break }
    if (!books.length) break
    
    for (const book of books) {
      if (searched >= maxBooks) break
      searched++
      
      console.log(`[${searched}] ${book.title}`)
      try {
        const md5s = await searchAnnasArchive(book.title, book.author)
        
        if (!md5s.length) {
          console.log('  ✗ Not found')
          await new Promise(r => setTimeout(r, SEARCH_DELAY))
          continue
        }
        
        // Try to get download URL for first 3 MD5s
        for (const md5 of md5s.slice(0, 3)) {
          const url = await getDownloadUrl(md5)
          if (url) {
            tasks.push({ bookId: book.id, title: book.title, md5, downloadUrl: url })
            // Save incrementally
            fs.writeFileSync('/tmp/book-download-tasks.json', JSON.stringify(tasks, null, 2))
            console.log(`  ✓ Found: ${md5} (${tasks.length} total)`)
            break
          }
        }
      } catch (e) {
        console.log(`  ✗ Error: ${e.message}`)
      }
      
      await new Promise(r => setTimeout(r, SEARCH_DELAY))
    }
    
    offset += BATCH
  }
  
  // Write tasks file (also saved incrementally during search)
  const outPath = '/tmp/book-download-tasks.json'
  fs.writeFileSync(outPath, JSON.stringify(tasks, null, 2))
  console.log(`\nDone! ${tasks.length}/${searched} books found. Tasks saved to ${outPath}`)
}

main().catch(console.error)
