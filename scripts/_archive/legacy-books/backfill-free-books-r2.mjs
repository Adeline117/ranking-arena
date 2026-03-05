#!/usr/bin/env node
/**
 * Find free EPUB/PDF books and upload to R2.
 * Sources: Project Gutenberg, Standard Ebooks, OpenLibrary borrowable
 * 
 * Usage: node scripts/backfill-free-books-r2.mjs [limit]
 */
import 'dotenv/config'
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { createClient } from '@supabase/supabase-js'

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY
const R2_BUCKET = process.env.R2_BUCKET || 'arena-cdn'
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || 'https://cdn.arenafi.org'

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://iknktzifjdyujdccyhsv.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
)

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
})

const sleep = ms => new Promise(r => setTimeout(r, ms))
const LIMIT = parseInt(process.argv[2] || '10000')
const MAX_FILE_SIZE = 50 * 1024 * 1024

async function uploadToR2(key, buffer, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: buffer, ContentType: contentType }))
  return `${R2_PUBLIC_URL}/${key}`
}

async function fileExistsInR2(key) {
  try { await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key })); return true } catch { return false }
}

async function fetchJSON(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'RankingArenaBot/1.0 (library@rankingarena.com)' },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

async function downloadFile(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(30000),
      redirect: 'follow',
    })
    if (!res.ok) return null
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('text/html')) return null
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length < 1024 || buffer.length > MAX_FILE_SIZE) return null
    return { buffer, contentType: ct, size: buffer.length }
  } catch { return null }
}

// --- Source 1: Project Gutenberg ---
async function searchGutenberg(title, author) {
  // Gutenberg API - search by title
  const q = encodeURIComponent(title.replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 60))
  const data = await fetchJSON(`https://gutendex.com/books/?search=${q}`)
  if (!data?.results?.length) return null

  // Find best match
  const titleLower = title.toLowerCase()
  const match = data.results.find(b => {
    const bt = b.title?.toLowerCase() || ''
    return bt.includes(titleLower.slice(0, 30)) || titleLower.includes(bt.slice(0, 30))
  }) || data.results[0]

  if (!match?.formats) return null

  // Prefer epub, then pdf
  const epubUrl = match.formats['application/epub+zip']
  const pdfUrl = match.formats['application/pdf']
  
  if (epubUrl) return { url: epubUrl, ext: 'epub', contentType: 'application/epub+zip' }
  if (pdfUrl) return { url: pdfUrl, ext: 'pdf', contentType: 'application/pdf' }
  return null
}

// --- Source 2: Standard Ebooks ---
async function searchStandardEbooks(title) {
  // Standard Ebooks has a predictable URL format
  const slug = title.toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 50)
  
  // Try to find the OPDS feed
  const data = await fetchJSON('https://standardebooks.org/feeds/opds')
  // Standard Ebooks doesn't have a great search API, skip for now
  return null
}

// --- Source 3: OpenLibrary freely readable ---
async function searchOpenLibraryFree(title, author) {
  const q = encodeURIComponent(title + (author ? ' ' + author.split(',')[0] : ''))
  const data = await fetchJSON(
    `https://openlibrary.org/search.json?q=${q}&limit=3&fields=key,title,ia,availability`
  )
  if (!data?.docs?.length) return null

  for (const doc of data.docs) {
    if (!doc.ia?.length) continue
    const iaId = doc.ia[0]
    
    // Check if epub is freely downloadable (not lending-only)
    const meta = await fetchJSON(`https://archive.org/metadata/${iaId}`)
    if (!meta?.files) continue

    // Look for non-private epub or pdf
    for (const f of meta.files) {
      if (f.private === 'true') continue
      if (f.format === 'EPUB' || f.name?.endsWith('.epub')) {
        return { url: `https://archive.org/download/${iaId}/${f.name}`, ext: 'epub', contentType: 'application/epub+zip' }
      }
    }
    for (const f of meta.files) {
      if (f.private === 'true') continue
      if ((f.format === 'PDF' || f.name?.endsWith('.pdf')) && !f.name?.includes('encrypted')) {
        return { url: `https://archive.org/download/${iaId}/${f.name}`, ext: 'pdf', contentType: 'application/pdf' }
      }
    }
  }
  return null
}

async function processBook(book) {
  // Try sources in order
  let source = null

  // 1. Try Project Gutenberg (fastest, most reliable for public domain)
  source = await searchGutenberg(book.title, book.author)
  if (source) {
    const file = await downloadFile(source.url)
    if (file) return { ...source, file, via: 'gutenberg' }
  }

  await sleep(500)

  // 2. Try OpenLibrary free downloads
  source = await searchOpenLibraryFree(book.title, book.author)
  if (source) {
    const file = await downloadFile(source.url)
    if (file) return { ...source, file, via: 'openlibrary' }
  }

  return null
}

async function main() {
  console.log(`=== Free Book Download & Upload to R2 ===`)
  console.log(`Limit: ${LIMIT}\n`)

  let offset = 0, total = 0, uploaded = 0, failed = 0

  while (total < LIMIT) {
    const { data: books, error } = await sb
      .from('library_items')
      .select('id, title, author')
      .in('category', ['book', 'finance'])
      .is('file_key', null)
      .order('view_count', { ascending: false })
      .range(offset, offset + 49)

    if (error) { console.error('DB error:', error.message); break }
    if (!books?.length) { console.log('No more books'); break }

    for (const book of books) {
      if (total >= LIMIT) break
      total++

      const result = await processBook(book)
      if (!result) {
        failed++
        if (total % 20 === 0) console.log(`  [${total}] no free source: ${book.title.slice(0, 50)}`)
        await sleep(1500)
        continue
      }

      const key = `library/${book.id}/content.${result.ext}`
      
      if (await fileExistsInR2(key)) {
        console.log(`⊘ [${total}] ${book.title.slice(0, 50)} (already in R2)`)
        continue
      }

      const cdnUrl = await uploadToR2(key, result.file.buffer, result.contentType)
      const sizeMB = (result.file.size / 1024 / 1024).toFixed(1)

      const updates = { file_key: key, file_size_bytes: result.file.size }
      if (result.ext === 'epub') {
        updates.epub_url = cdnUrl
      } else {
        updates.pdf_url = cdnUrl
      }
      await sb.from('library_items').update(updates).eq('id', book.id)
      uploaded++
      console.log(`✓ [${total}] ${book.title.slice(0, 50)} → ${result.ext} (${sizeMB}MB) [${result.via}]`)

      await sleep(1000)
    }

    offset += 50
    if (total % 200 === 0) {
      console.log(`\n--- Progress: ${total} | ${uploaded} uploaded | ${failed} no source ---\n`)
    }
  }

  console.log(`\n=== DONE: ${total} processed | ${uploaded} uploaded | ${failed} no free source ===`)
}

main().catch(console.error)
