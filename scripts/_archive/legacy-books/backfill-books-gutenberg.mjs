#!/usr/bin/env node
/**
 * Fast book backfill via Project Gutenberg (gutendex API).
 * Gutenberg has ~70K free public domain books with EPUBs.
 * 
 * Usage: node scripts/backfill-books-gutenberg.mjs [limit]
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
const LIMIT = parseInt(process.argv[2] || '30000')
const CONCURRENCY = 3

async function uploadToR2(key, buffer, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: buffer, ContentType: contentType }))
  return `${R2_PUBLIC_URL}/${key}`
}

async function downloadFile(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    })
    if (!res.ok) return null
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('text/html')) return null
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length < 1024 || buffer.length > 30 * 1024 * 1024) return null
    return { buffer, contentType: ct, size: buffer.length }
  } catch { return null }
}

async function searchGutenberg(title) {
  const q = encodeURIComponent(title.replace(/[^a-zA-Z0-9\u4e00-\u9fff ]/g, '').slice(0, 80))
  try {
    const res = await fetch(`https://gutendex.com/books/?search=${q}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const data = await res.json()
    if (!data?.results?.length) return null

    const titleLower = title.toLowerCase().slice(0, 40)
    const match = data.results.find(b => {
      const bt = (b.title || '').toLowerCase()
      return bt.includes(titleLower) || titleLower.includes(bt.slice(0, 30))
    }) || data.results[0]

    if (!match?.formats) return null
    const epubUrl = match.formats['application/epub+zip']
    if (epubUrl) return { url: epubUrl, ext: 'epub', contentType: 'application/epub+zip' }
    const pdfUrl = match.formats['application/pdf']
    if (pdfUrl) return { url: pdfUrl, ext: 'pdf', contentType: 'application/pdf' }
    return null
  } catch { return null }
}

async function processBook(book) {
  const source = await searchGutenberg(book.title)
  if (!source) return null

  const file = await downloadFile(source.url)
  if (!file) return null

  const key = `library/${book.id}/content.${source.ext}`
  const cdnUrl = await uploadToR2(key, file.buffer, source.contentType)

  const updates = { file_key: key, file_size_bytes: file.size }
  if (source.ext === 'epub') {
    updates.epub_url = cdnUrl
  } else {
    updates.pdf_url = cdnUrl
  }
  await sb.from('library_items').update(updates).eq('id', book.id)

  return { key, size: file.size, ext: source.ext }
}

async function main() {
  console.log(`=== Gutenberg Book Backfill → R2 ===`)
  console.log(`Limit: ${LIMIT}, Concurrency: ${CONCURRENCY}\n`)

  let offset = 0, total = 0, uploaded = 0, failed = 0

  while (total < LIMIT) {
    const { data: books, error } = await sb
      .from('library_items')
      .select('id, title, author')
      .in('category', ['book', 'finance'])
      .is('file_key', null)
      .order('view_count', { ascending: false })
      .range(offset, offset + 49)

    if (error || !books?.length) break

    for (let i = 0; i < books.length; i += CONCURRENCY) {
      const chunk = books.slice(i, i + CONCURRENCY)
      const results = await Promise.all(chunk.map(async (book) => {
        const result = await processBook(book)
        return { book, result }
      }))

      for (const { book, result } of results) {
        if (total >= LIMIT) break
        total++
        if (result) {
          uploaded++
          const sizeMB = (result.size / 1024 / 1024).toFixed(1)
          console.log(`✓ [${total}] ${book.title.slice(0, 55)} → ${result.ext} (${sizeMB}MB)`)
        } else {
          failed++
          if (total % 50 === 0) console.log(`  [${total}] no match: ${book.title.slice(0, 50)}`)
        }
      }

      await sleep(500)
    }

    offset += 50
    if (total % 200 === 0) {
      console.log(`\n--- [${new Date().toISOString()}] ${total} processed | ${uploaded} uploaded | ${failed} no match ---\n`)
    }
  }

  console.log(`\n=== DONE: ${total} processed | ${uploaded} uploaded | ${failed} no match ===`)
}

main().catch(console.error)
