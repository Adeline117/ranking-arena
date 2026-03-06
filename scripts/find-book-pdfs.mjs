#!/usr/bin/env node
/**
 * Find downloadable PDFs for books without pdf_url.
 * Sources: Internet Archive (open/community uploads), Open Library.
 * Downloads and uploads to R2.
 */
import 'dotenv/config'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { createClient } from '@supabase/supabase-js'

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY
const R2_BUCKET = process.env.R2_BUCKET || 'arena-cdn'
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || 'https://cdn.arenafi.org'
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const sb = createClient(SUPABASE_URL, SUPABASE_KEY)
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
})

const LIMIT = parseInt(process.argv[2] || '500')
const MAX_FILE_SIZE = 50 * 1024 * 1024
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchJSON(url, timeoutMs = 10000) {
  try {
    const c = new AbortController()
    const t = setTimeout(() => c.abort(), timeoutMs)
    const r = await fetch(url, { signal: c.signal, headers: { 'User-Agent': 'Mozilla/5.0' } })
    clearTimeout(t)
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

async function uploadToR2(key, buffer, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET, Key: key, Body: buffer,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }))
  return `${R2_PUBLIC_URL}/${key}`
}

async function downloadFile(url) {
  try {
    const c = new AbortController()
    const t = setTimeout(() => c.abort(), 20000)
    const r = await fetch(url, { signal: c.signal, headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' })
    clearTimeout(t)
    if (!r.ok) return null
    const ct = r.headers.get('content-type') || ''
    if (ct.includes('text/html')) return null
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length < 5000 || buf.length > MAX_FILE_SIZE) return null
    return { buffer: buf, contentType: ct, size: buf.length }
  } catch { return null }
}

// Search Internet Archive for open/community PDFs
async function searchIA(title, author) {
  const clean = title.replace(/[:'*"]/g, ' ').replace(/\s+/g, ' ').trim()
  const shortTitle = clean.split(' ').slice(0, 6).join(' ')
  const exclude = '-collection:printdisabled -collection:internetarchivebooks -collection:inlibrary'
  
  const queries = [
    `title:"${shortTitle}" format:PDF ${exclude}`,
    `${shortTitle} ${(author || '').split(',')[0]} format:PDF ${exclude}`,
  ]

  for (const q of queries) {
    const data = await fetchJSON(
      `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&rows=5&output=json`
    )
    const docs = data?.response?.docs || []
    for (const doc of docs) {
      // Check for downloadable PDF
      const meta = await fetchJSON(`https://archive.org/metadata/${doc.identifier}`)
      if (meta?.metadata?.access_restricted_item === 'true') continue
      const pdfs = (meta?.files || [])
        .filter(f => f.name?.endsWith('.pdf') && !f.name?.includes('_abbyy'))
        .map(f => ({ ...f, sizeNum: parseInt(f.size || '0') }))
        .filter(f => f.sizeNum > 10000 && f.sizeNum <= MAX_FILE_SIZE)
        .sort((a, b) => b.sizeNum - a.sizeNum)
      if (pdfs.length) {
        return `https://archive.org/download/${doc.identifier}/${encodeURIComponent(pdfs[0].name)}`
      }
      await sleep(500)
    }
    await sleep(1000)
  }
  return null
}

// Search by ISBN via Open Library → find IA identifier
async function searchByISBN(isbn) {
  if (!isbn) return null
  const data = await fetchJSON(`https://openlibrary.org/isbn/${isbn}.json`)
  if (!data?.ocaid) return null
  const meta = await fetchJSON(`https://archive.org/metadata/${data.ocaid}`)
  if (meta?.metadata?.access_restricted_item === 'true') return null
  const pdfs = (meta?.files || [])
    .filter(f => f.name?.endsWith('.pdf'))
    .map(f => ({ ...f, sizeNum: parseInt(f.size || '0') }))
    .filter(f => f.sizeNum > 10000 && f.sizeNum <= MAX_FILE_SIZE)
    .sort((a, b) => b.sizeNum - a.sizeNum)
  if (pdfs.length) {
    return `https://archive.org/download/${data.ocaid}/${encodeURIComponent(pdfs[0].name)}`
  }
  return null
}

async function processBook(book) {
  // Try ISBN first, then title search
  let pdfUrl = await searchByISBN(book.isbn)
  if (!pdfUrl) {
    pdfUrl = await searchIA(book.title, book.author)
  }
  if (!pdfUrl) return null

  const file = await downloadFile(pdfUrl)
  if (!file) return null

  const key = `library/${book.id}/content.pdf`
  const cdnUrl = await uploadToR2(key, file.buffer, 'application/pdf')
  await sb.from('library_items').update({
    file_key: key, file_size_bytes: file.size, pdf_url: cdnUrl,
  }).eq('id', book.id)

  return { size: file.size }
}

async function main() {
  console.log(`=== Find & Download Book PDFs | limit=${LIMIT} ===\n`)
  let offset = 0, total = 0, ok = 0, fail = 0
  const startTime = Date.now()

  while (total < LIMIT) {
    const { data: books, error } = await sb
      .from('library_items')
      .select('id, title, author, isbn')
      .eq('category', 'book')
      .is('file_key', null)
      .or('pdf_url.is.null,pdf_url.not.like.%cdn.arenafi.org%')
      .order('view_count', { ascending: false, nullsFirst: false })
      .range(offset, offset + 49)

    if (error) { console.error('DB error:', error.message); break }
    if (!books?.length) { console.log('No more books'); break }

    for (const book of books) {
      if (total >= LIMIT) break
      total++
      try {
        const r = await Promise.race([
          processBook(book),
          sleep(60000).then(() => null)
        ])
        if (r) {
          ok++
          const mb = (r.size / 1024 / 1024).toFixed(1)
          console.log(`✓ [${total}] ${book.title?.slice(0, 60)} (${mb}MB)`)
        } else {
          fail++
          if (total <= 20 || total % 50 === 0) console.log(`✗ [${total}] ${book.title?.slice(0, 60)}`)
        }
      } catch (e) {
        fail++
      }
      await sleep(500) // Rate limit for IA
    }
    offset += 50

    if (total % 50 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
      console.log(`\n--- ${total} done | ${ok} found | ${fail} missed | ${elapsed}s ---\n`)
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
  console.log(`\nDONE: ${total} processed | ${ok} uploaded | ${fail} not found | ${elapsed}s`)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
