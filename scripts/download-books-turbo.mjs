#!/usr/bin/env node
/**
 * TURBO book downloader — 10 concurrent, multiple mirrors, ISBN/title search
 * Maximizes throughput for bulk download
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_KEY) { console.error('Set SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const CONCURRENCY = 15
const DOWNLOAD_TIMEOUT = 180000 // 3 min per file
const BATCH_SIZE = 30

// Multiple LibGen mirrors to rotate
const MIRRORS = [
  'https://libgen.li',
  'https://libgen.gs', 
  'https://libgen.vg',
]
let mirrorIdx = 0
function nextMirror() { return MIRRORS[mirrorIdx++ % MIRRORS.length] }

function extractMd5(html) {
  const m = html.match(/\/md5\/([a-f0-9]{32})/g)
  return m ? [...new Set(m.map(x => x.replace('/md5/', '')))] : []
}

async function searchAnnas(title, author) {
  const q = encodeURIComponent(`${title} ${author || ''}`.trim().slice(0, 100))
  try {
    const r = await fetch(`https://annas-archive.li/search?q=${q}&ext=epub&sort=`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(12000),
    })
    return r.ok ? extractMd5(await r.text()) : []
  } catch { return [] }
}

async function getDownloadUrl(md5) {
  const mirror = nextMirror()
  try {
    const r = await fetch(`${mirror}/ads.php?md5=${md5}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) return null
    const html = await r.text()
    const m = html.match(/get\.php\?md5=([a-f0-9]+)&(?:amp;)?key=([A-Z0-9]+)/i)
    return m ? `${mirror}/get.php?md5=${m[1]}&key=${m[2]}` : null
  } catch { return null }
}

async function downloadFile(url) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT)
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      signal: ctrl.signal, redirect: 'follow',
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return Buffer.from(await r.arrayBuffer())
  } finally { clearTimeout(t) }
}

async function processBook(book, idx) {
  const tag = `[${idx}]`
  try {
    const md5s = await searchAnnas(book.title, book.author)
    if (!md5s.length) { return false }
    
    for (const md5 of md5s.slice(0, 2)) {
      try {
        const url = await getDownloadUrl(md5)
        if (!url) continue
        
        const buf = await downloadFile(url)
        if (buf.length < 1000) continue
        
        const isEpub = buf[0] === 0x50 && buf[1] === 0x4B
        const isPdf = buf[0] === 0x25 && buf[1] === 0x50
        const ext = isEpub ? 'epub' : isPdf ? 'pdf' : 'epub'
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
      } catch (e) {
        // Try next md5
      }
    }
    return false
  } catch { return false }
}

async function main() {
  const max = parseInt(process.argv[2] || '5000')
  let offset = 0, total = 0, success = 0, startTime = Date.now()
  
  console.log(`Turbo downloader: ${CONCURRENCY} concurrent, target ${max} books`)
  console.log(`Mirrors: ${MIRRORS.join(', ')}`)
  console.log(`Start time: ${new Date().toISOString()}\n`)
  
  while (total < max) {
    const { data: books } = await supabase
      .from('library_items')
      .select('id, title, author')
      .is('epub_url', null).is('pdf_url', null).is('file_key', null)
      .eq('category', 'book')
      .order('view_count', { ascending: false, nullsFirst: false })
      .range(offset, offset + BATCH_SIZE - 1)
    
    if (!books?.length) break
    
    // Process in parallel batches
    for (let i = 0; i < books.length && total < max; i += CONCURRENCY) {
      const batch = books.slice(i, i + CONCURRENCY)
      const results = await Promise.allSettled(
        batch.map((b, j) => processBook(b, total + j + 1))
      )
      
      for (const r of results) {
        total++
        if (r.status === 'fulfilled' && r.value) success++
      }
      
      const elapsed = (Date.now() - startTime) / 1000 / 60
      const rate = success / elapsed
      const eta = max > success ? ((max - success) / rate / 60).toFixed(1) : '0'
      console.log(`--- ${success}/${total} done (${rate.toFixed(1)}/min, ETA ${eta}h) ---\n`)
      
      // Small delay between batches
      await new Promise(r => setTimeout(r, 1500))
    }
    
    offset += books.length
  }
  
  const elapsed = (Date.now() - startTime) / 1000 / 60
  console.log(`\n=== FINAL: ${success}/${total} in ${elapsed.toFixed(1)} min ===`)
}

main().catch(console.error)
