#!/usr/bin/env node
/**
 * Phase 1: Batch search Anna's Archive for MD5 hashes
 * Runs on Mac Mini (only machine that can access Anna's Archive)
 * Outputs JSON file for VPS downloaders to consume
 */

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_KEY) { console.error('Set SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const CONCURRENCY = 5 // Parallel searches
const OUTPUT = '/tmp/book-md5-tasks.json'

function extractMd5(html) {
  const m = html.match(/\/md5\/([a-f0-9]{32})/g)
  return m ? [...new Set(m.map(x => x.replace('/md5/', '')))] : []
}

async function searchAnnas(title, author) {
  const q = encodeURIComponent(`${title} ${author || ''}`.trim().slice(0, 100))
  try {
    const r = await fetch(`https://annas-archive.li/search?q=${q}&ext=epub&sort=`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(12000),
    })
    return r.ok ? extractMd5(await r.text()) : []
  } catch { return [] }
}

async function main() {
  const max = parseInt(process.argv[2] || '5000')
  const tasks = []
  let offset = 0, searched = 0, found = 0
  
  console.log(`Batch MD5 search: target ${max} books`)
  
  while (searched < max) {
    const { data: books } = await supabase
      .from('library_items')
      .select('id, title, author')
      .is('epub_url', null).is('pdf_url', null).is('file_key', null)
      .eq('category', 'book')
      .order('view_count', { ascending: false, nullsFirst: false })
      .range(offset, offset + 50 - 1)
    
    if (!books?.length) break
    
    // Search in parallel batches
    for (let i = 0; i < books.length && searched < max; i += CONCURRENCY) {
      const batch = books.slice(i, i + CONCURRENCY)
      const results = await Promise.allSettled(
        batch.map(async b => {
          const md5s = await searchAnnas(b.title, b.author)
          return { book: b, md5s }
        })
      )
      
      for (const r of results) {
        searched++
        if (r.status === 'fulfilled' && r.value.md5s.length > 0) {
          found++
          tasks.push({
            bookId: r.value.book.id,
            title: r.value.book.title,
            md5s: r.value.md5s.slice(0, 3),
          })
        }
      }
      
      // Save incrementally every 50 finds
      if (found % 50 === 0 && found > 0) {
        fs.writeFileSync(OUTPUT, JSON.stringify(tasks, null, 2))
        console.log(`${found}/${searched} found (${(found/searched*100).toFixed(0)}% hit rate)`)
      }
      
      await new Promise(r => setTimeout(r, 1000))
    }
    
    offset += 50
  }
  
  fs.writeFileSync(OUTPUT, JSON.stringify(tasks, null, 2))
  console.log(`\nDone! ${found}/${searched} found. Saved to ${OUTPUT}`)
}

main().catch(console.error)
