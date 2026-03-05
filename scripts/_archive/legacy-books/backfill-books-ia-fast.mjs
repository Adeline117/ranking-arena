#!/usr/bin/env node
/**
 * Fast book backfill: Search OpenLibrary, check IA metadata for free files.
 * Optimized: Skip metadata check if IA item is in lending library.
 * Tries Gutenberg first (fast), then IA.
 */
import 'dotenv/config'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://iknktzifjdyujdccyhsv.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
)
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
})
const R2_BUCKET = process.env.R2_BUCKET || 'arena-cdn'
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || 'https://cdn.arenafi.org'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const LIMIT = parseInt(process.argv[2] || '30000')

async function fetchJSON(url, timeout = 8000) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'RankingArenaBot/1.0' },
      signal: AbortSignal.timeout(timeout),
    })
    return res.ok ? await res.json() : null
  } catch { return null }
}

async function downloadFile(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    })
    if (!res.ok) return null
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('text/html')) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 1024 || buf.length > 30 * 1024 * 1024) return null
    return { buffer: buf, contentType: ct, size: buf.length }
  } catch { return null }
}

async function uploadAndUpdate(bookId, file, ext) {
  const key = `library/${bookId}/content.${ext}`
  const ct = ext === 'epub' ? 'application/epub+zip' : 'application/pdf'
  await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: file.buffer, ContentType: ct }))
  const cdnUrl = `${R2_PUBLIC_URL}/${key}`
  const updates = { file_key: key, file_size_bytes: file.size }
  if (ext === 'epub') updates.epub_url = cdnUrl; else updates.pdf_url = cdnUrl
  await sb.from('library_items').update(updates).eq('id', bookId)
  return { key, cdnUrl, size: file.size }
}

async function tryGutenberg(title) {
  const q = encodeURIComponent(title.replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 60))
  const data = await fetchJSON(`https://gutendex.com/books/?search=${q}`)
  if (!data?.results?.length) return null
  const tl = title.toLowerCase().slice(0, 35)
  const m = data.results.find(b => (b.title||'').toLowerCase().includes(tl)) || data.results[0]
  const epub = m.formats?.['application/epub+zip']
  if (epub) return { url: epub, ext: 'epub' }
  const pdf = m.formats?.['application/pdf']
  if (pdf) return { url: pdf, ext: 'pdf' }
  return null
}

async function tryInternetArchive(title, author) {
  const q = encodeURIComponent(title + (author ? ' ' + author.split(',')[0].split('(')[0].trim() : ''))
  const data = await fetchJSON(`https://openlibrary.org/search.json?q=${q}&limit=2&fields=key,title,ia`)
  if (!data?.docs) return null

  for (const doc of data.docs) {
    if (!doc.ia?.length) continue
    const iaId = doc.ia[0]
    
    // Quick check: try direct epub download (works for non-lending items)
    const epubUrl = `https://archive.org/download/${iaId}/${iaId}.epub`
    const pdfUrl = `https://archive.org/download/${iaId}/${iaId}.pdf`
    
    // Try epub first
    try {
      const res = await fetch(epubUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000), redirect: 'follow' })
      if (res.ok && !res.headers.get('content-type')?.includes('html')) {
        return { url: epubUrl, ext: 'epub' }
      }
    } catch {}
    
    // Try pdf
    try {
      const res = await fetch(pdfUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000), redirect: 'follow' })
      if (res.ok && !res.headers.get('content-type')?.includes('html')) {
        return { url: pdfUrl, ext: 'pdf' }
      }
    } catch {}
  }
  return null
}

async function main() {
  console.log(`=== Book Backfill (Gutenberg + IA) → R2 ===`)
  console.log(`Limit: ${LIMIT}\n`)
  
  let offset = 0, total = 0, uploaded = 0

  while (total < LIMIT) {
    const { data: books, error } = await sb
      .from('library_items')
      .select('id, title, author')
      .in('category', ['book', 'finance'])
      .is('file_key', null)
      .order('view_count', { ascending: false })
      .range(offset, offset + 49)

    if (error || !books?.length) break

    for (const book of books) {
      if (total >= LIMIT) break
      total++

      // Try Gutenberg first
      let source = await tryGutenberg(book.title)
      
      // Then try IA
      if (!source) {
        await sleep(800)
        source = await tryInternetArchive(book.title, book.author)
      }

      if (source) {
        const file = await downloadFile(source.url)
        if (file) {
          const result = await uploadAndUpdate(book.id, file, source.ext)
          uploaded++
          console.log(`✓ [${total}] ${book.title.slice(0, 55)} → ${source.ext} (${(file.size/1024/1024).toFixed(1)}MB)`)
          continue
        }
      }

      if (total % 50 === 0) console.log(`  [${total}] ${uploaded} uploaded so far`)
      await sleep(500)
    }

    offset += 50
    if (total % 500 === 0) {
      console.log(`\n--- [${new Date().toISOString()}] ${total} processed | ${uploaded} uploaded ---\n`)
    }
  }

  console.log(`\n=== DONE: ${total} processed | ${uploaded} uploaded ===`)
}

main().catch(console.error)
