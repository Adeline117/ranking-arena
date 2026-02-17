#!/usr/bin/env node
/**
 * Batch download books from Anna's Archive → LibGen
 * Flow: search annas-archive.li → get MD5 → download from libgen.li → upload to Supabase Storage
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_KEY) { console.error('Set SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const BATCH_SIZE = 20
const SEARCH_DELAY = 2000  // Be nice
const DOWNLOAD_DELAY = 3000

function extractMd5FromSearch(html) {
  // Extract MD5 hashes from Anna's Archive search results
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
    
    // Extract download link: get.php?md5=xxx&key=xxx
    const match = html.match(/get\.php\?md5=([a-f0-9]+)&amp;key=([A-Z0-9]+)/i) 
      || html.match(/get\.php\?md5=([a-f0-9]+)&key=([A-Z0-9]+)/i)
    if (!match) return null
    
    return `https://libgen.li/get.php?md5=${match[1]}&key=${match[2]}`
  } catch {
    return null
  }
}

async function downloadFile(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh)' },
    signal: AbortSignal.timeout(60000),
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`Download ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  return buf
}

async function uploadToStorage(buffer, libraryItemId, ext = 'epub') {
  const fileKey = `library/${ext}/${libraryItemId}.${ext}`
  
  const { error } = await supabase.storage
    .from('library-files')
    .upload(fileKey, buffer, {
      contentType: ext === 'epub' ? 'application/epub+zip' : 'application/pdf',
      upsert: true,
    })
  
  if (error) throw error
  
  const { data: { publicUrl } } = supabase.storage
    .from('library-files')
    .getPublicUrl(fileKey)
  
  return { fileKey, publicUrl }
}

async function main() {
  const maxBooks = parseInt(process.argv[2] || '100')
  console.log(`Processing up to ${maxBooks} books...`)
  
  let offset = 0
  let downloaded = 0
  let searched = 0
  let failed = 0
  
  while (downloaded < maxBooks) {
    const { data: books, error } = await supabase
      .from('library_items')
      .select('id, title, author, isbn, category')
      .is('epub_url', null)
      .is('pdf_url', null)
      .is('file_key', null)
      .eq('category', 'book')
      .order('view_count', { ascending: false, nullsFirst: false })
      .range(offset, offset + BATCH_SIZE - 1)
    
    if (error) { console.error('DB error:', error); break }
    if (!books.length) { console.log('No more books'); break }
    
    for (const book of books) {
      if (downloaded >= maxBooks) break
      searched++
      
      console.log(`[${searched}] Searching: "${book.title}"`)
      
      // Search Anna's Archive
      const md5s = await searchAnnasArchive(book.title, book.author)
      if (!md5s.length) {
        console.log(`  ✗ Not found on Anna's Archive`)
        await new Promise(r => setTimeout(r, SEARCH_DELAY))
        continue
      }
      
      // Try each MD5 until one works
      let success = false
      for (const md5 of md5s.slice(0, 3)) {
        try {
          console.log(`  Trying MD5: ${md5}`)
          const downloadUrl = await getDownloadUrl(md5)
          if (!downloadUrl) {
            console.log(`  ✗ No download link for ${md5}`)
            continue
          }
          
          console.log(`  Downloading...`)
          const buffer = await downloadFile(downloadUrl)
          
          if (buffer.length < 1000) {
            console.log(`  ✗ File too small (${buffer.length}B), skipping`)
            continue
          }
          
          // Detect format from content
          const isEpub = buffer[0] === 0x50 && buffer[1] === 0x4B  // ZIP/EPUB magic bytes
          const isPdf = buffer[0] === 0x25 && buffer[1] === 0x50   // %P (PDF)
          const ext = isEpub ? 'epub' : isPdf ? 'pdf' : 'epub'
          
          console.log(`  Uploading ${ext} (${(buffer.length/1024/1024).toFixed(1)}MB)...`)
          const { fileKey, publicUrl } = await uploadToStorage(buffer, book.id, ext)
          
          // Update DB
          const update = { file_key: fileKey }
          if (ext === 'epub') update.epub_url = publicUrl
          else update.pdf_url = publicUrl
          
          await supabase.from('library_items').update(update).eq('id', book.id)
          
          downloaded++
          success = true
          console.log(`  ✓ Done! (${downloaded} total)`)
          break
        } catch (e) {
          console.log(`  ✗ Error: ${e.message}`)
          failed++
        }
      }
      
      if (!success) failed++
      await new Promise(r => setTimeout(r, DOWNLOAD_DELAY))
    }
    
    offset += BATCH_SIZE
  }
  
  console.log(`\n=== Summary ===`)
  console.log(`Searched: ${searched}`)
  console.log(`Downloaded: ${downloaded}`)
  console.log(`Failed: ${failed}`)
}

main().catch(console.error)
