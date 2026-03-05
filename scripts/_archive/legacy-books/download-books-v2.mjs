#!/usr/bin/env node
/**
 * Book downloader V2 — multi-mirror HTML search + download
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_KEY) { console.error('Set SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const CONCURRENCY = 15
const BATCH_SIZE = 30
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const LIBGEN_MIRRORS = ['https://libgen.li', 'https://libgen.vg']
let mirrorIdx = 0
function nextMirror() { return LIBGEN_MIRRORS[mirrorIdx++ % LIBGEN_MIRRORS.length] }

// Search LibGen HTML for MD5s
async function searchLibgen(query) {
  const q = encodeURIComponent(query.slice(0, 80))
  for (const mirror of LIBGEN_MIRRORS) {
    try {
      const r = await fetch(`${mirror}/index.php?req=${q}&columns=t&res=25`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(12000),
      })
      if (!r.ok) continue
      const html = await r.text()
      const matches = html.match(/md5=([a-f0-9]{32})/gi)
      if (matches?.length) {
        return [...new Set(matches.map(m => m.replace('md5=', '').toLowerCase()))]
      }
    } catch {}
  }
  return []
}

// Search by ISBN on LibGen
async function searchByIsbn(isbn) {
  const clean = isbn.replace(/[-\s]/g, '')
  for (const mirror of LIBGEN_MIRRORS) {
    try {
      const r = await fetch(`${mirror}/index.php?req=${clean}&columns=i&res=25`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(12000),
      })
      if (!r.ok) continue
      const html = await r.text()
      const matches = html.match(/md5=([a-f0-9]{32})/gi)
      if (matches?.length) {
        return [...new Set(matches.map(m => m.replace('md5=', '').toLowerCase()))]
      }
    } catch {}
  }
  return []
}

// Download file from LibGen via ads.php → get.php
async function downloadFromMd5(md5) {
  for (const mirror of LIBGEN_MIRRORS) {
    try {
      const r = await fetch(`${mirror}/ads.php?md5=${md5}`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(10000),
      })
      if (!r.ok) continue
      const html = await r.text()
      const m = html.match(/get\.php\?md5=([a-f0-9]+)&(?:amp;)?key=([A-Z0-9]+)/i)
      if (!m) continue
      
      const url = `${mirror}/get.php?md5=${m[1]}&key=${m[2]}`
      const dl = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(180000),
        redirect: 'follow',
      })
      if (!dl.ok) continue
      const buf = Buffer.from(await dl.arrayBuffer())
      if (buf.length > 5000) return buf
    } catch {}
  }
  return null
}

async function processBook(book, idx) {
  const tag = `[${idx}]`
  try {
    let md5s = []
    
    // 1. ISBN search
    if (book.isbn) {
      md5s = await searchByIsbn(book.isbn)
    }
    
    // 2. Title search
    if (!md5s.length) {
      const q = `${book.title} ${book.author || ''}`.trim()
      md5s = await searchLibgen(q)
    }
    
    if (!md5s.length) return false
    
    // Try top 3 results
    for (const md5 of md5s.slice(0, 3)) {
      try {
        const buf = await downloadFromMd5(md5)
        if (!buf) continue
        
        const isEpub = buf[0] === 0x50 && buf[1] === 0x4B
        const isPdf = buf[0] === 0x25 && buf[1] === 0x50
        if (!isEpub && !isPdf) continue
        
        const ext = isEpub ? 'epub' : 'pdf'
        const fileKey = `library/${ext}/${book.id}.${ext}`
        
        const { error } = await supabase.storage.from('library-files').upload(fileKey, buf, {
          contentType: ext === 'epub' ? 'application/epub+zip' : 'application/pdf',
          upsert: true,
        })
        if (error) continue
        
        const { data: { publicUrl } } = supabase.storage.from('library-files').getPublicUrl(fileKey)
        const update = { file_key: fileKey }
        if (ext === 'epub') update.epub_url = publicUrl; else update.pdf_url = publicUrl
        await supabase.from('library_items').update(update).eq('id', book.id)
        
        console.log(`${tag} ✓ ${book.title.slice(0,50)} (${ext} ${(buf.length/1024/1024).toFixed(1)}MB)`)
        return true
      } catch {}
    }
    return false
  } catch { return false }
}

async function main() {
  const max = parseInt(process.argv[2] || '29000')
  let offset = 0, total = 0, success = 0, notFound = 0, startTime = Date.now()
  
  console.log(`=== Book Downloader V2 ===`)
  console.log(`Concurrency: ${CONCURRENCY}, Target: ${max}`)
  console.log(`Mirrors: ${LIBGEN_MIRRORS.join(', ')}`)
  console.log(`Start: ${new Date().toISOString()}\n`)
  
  while (total < max) {
    const { data: books, error: qErr } = await supabase
      .from('library_items')
      .select('id, title, author, isbn')
      .is('file_key', null)
      .eq('category', 'book')
      .order('created_at', { ascending: true })
      .range(offset, offset + BATCH_SIZE - 1)
    
    if (qErr) { console.error('Query error:', qErr.message); break }
    if (!books?.length) { console.log('No more books'); break }
    
    for (let i = 0; i < books.length && total < max; i += CONCURRENCY) {
      const batch = books.slice(i, i + CONCURRENCY)
      const results = await Promise.allSettled(
        batch.map((b, j) => processBook(b, total + j + 1))
      )
      
      for (const r of results) {
        total++
        if (r.status === 'fulfilled' && r.value) success++
        else notFound++
      }
      
      const elapsed = (Date.now() - startTime) / 1000 / 60
      const rate = success / Math.max(elapsed, 0.1)
      const remaining = rate > 0 ? ((max - total) * (success/total) / rate / 60) : 999
      console.log(`--- ${success}/${total} (${(success/total*100).toFixed(0)}% hit) | ${rate.toFixed(1)}/min | ETA ${remaining.toFixed(0)}h ---\n`)
      
      // Delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 2000))
    }
    
    // Don't re-query same offset if all failed — move forward
    offset += books.length
  }
  
  console.log(`\n=== DONE: ${success}/${total} in ${((Date.now()-startTime)/60000).toFixed(0)} min ===`)
}

main().catch(console.error)
