#!/usr/bin/env node
/**
 * Concurrent book downloader — runs 3 downloads in parallel
 * Searches Anna's Archive, downloads from LibGen, uploads to Supabase Storage
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_KEY) { console.error('Set SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const CONCURRENCY = 5
const SEARCH_DELAY = 2000
const DOWNLOAD_TIMEOUT = 300000 // 5 min

function extractMd5(html) {
  const m = html.match(/\/md5\/([a-f0-9]{32})/g)
  return m ? [...new Set(m.map(x => x.replace('/md5/', '')))] : []
}

async function searchAnnas(title, author) {
  const q = encodeURIComponent(`${title} ${author || ''}`.trim())
  try {
    const r = await fetch(`https://annas-archive.li/search?q=${q}&ext=epub`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(15000),
    })
    return r.ok ? extractMd5(await r.text()) : []
  } catch { return [] }
}

async function getDownloadUrl(md5) {
  try {
    const r = await fetch(`https://libgen.li/ads.php?md5=${md5}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    })
    if (!r.ok) return null
    const html = await r.text()
    const m = html.match(/get\.php\?md5=([a-f0-9]+)&(?:amp;)?key=([A-Z0-9]+)/i)
    return m ? `https://libgen.li/get.php?md5=${m[1]}&key=${m[2]}` : null
  } catch { return null }
}

async function downloadFile(url) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT)
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal, redirect: 'follow' })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return Buffer.from(await r.arrayBuffer())
  } finally { clearTimeout(t) }
}

async function processBook(book, idx) {
  const tag = `[${idx}]`
  console.log(`${tag} "${book.title}"`)
  
  try {
    const md5s = await searchAnnas(book.title, book.author)
    if (!md5s.length) { console.log(`${tag} ✗ Not found`); return false }
    
    for (const md5 of md5s.slice(0, 3)) {
      try {
        const url = await getDownloadUrl(md5)
        if (!url) continue
        
        console.log(`${tag} Downloading (${md5})...`)
        const buf = await downloadFile(url)
        if (buf.length < 1000) continue
        
        const isEpub = buf[0] === 0x50 && buf[1] === 0x4B
        const isPdf = buf[0] === 0x25 && buf[1] === 0x50
        const ext = isEpub ? 'epub' : isPdf ? 'pdf' : 'epub'
        const fileKey = `library/${ext}/${book.id}.${ext}`
        
        console.log(`${tag} Uploading ${ext} (${(buf.length/1024/1024).toFixed(1)}MB)...`)
        const { error } = await supabase.storage.from('library-files').upload(fileKey, buf, {
          contentType: ext === 'epub' ? 'application/epub+zip' : 'application/pdf',
          upsert: true,
        })
        if (error) { console.log(`${tag} ✗ Upload: ${error.message}`); continue }
        
        const { data: { publicUrl } } = supabase.storage.from('library-files').getPublicUrl(fileKey)
        const update = { file_key: fileKey }
        if (ext === 'epub') update.epub_url = publicUrl; else update.pdf_url = publicUrl
        await supabase.from('library_items').update(update).eq('id', book.id)
        
        console.log(`${tag} ✓ Done!`)
        return true
      } catch (e) {
        console.log(`${tag} ✗ ${e.message}`)
      }
    }
    return false
  } catch (e) {
    console.log(`${tag} ✗ ${e.message}`)
    return false
  }
}

async function main() {
  const max = parseInt(process.argv[2] || '200')
  let offset = 0, total = 0, success = 0
  
  while (total < max) {
    const { data: books } = await supabase
      .from('library_items')
      .select('id, title, author')
      .is('epub_url', null).is('pdf_url', null).is('file_key', null)
      .eq('category', 'book')
      .order('view_count', { ascending: false, nullsFirst: false })
      .range(offset, offset + CONCURRENCY * 2 - 1)
    
    if (!books?.length) break
    
    // Process in batches of CONCURRENCY
    for (let i = 0; i < books.length && total < max; i += CONCURRENCY) {
      const batch = books.slice(i, i + CONCURRENCY)
      const results = await Promise.allSettled(
        batch.map((b, j) => processBook(b, total + j + 1))
      )
      
      for (const r of results) {
        total++
        if (r.status === 'fulfilled' && r.value) success++
      }
      
      // Delay between batches to not hammer Anna's Archive
      await new Promise(r => setTimeout(r, SEARCH_DELAY))
    }
    
    offset += books.length
    console.log(`\n--- Progress: ${success}/${total} downloaded ---\n`)
  }
  
  console.log(`\n=== DONE: ${success}/${total} books downloaded ===`)
}

main().catch(console.error)
