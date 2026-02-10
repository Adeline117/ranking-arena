#!/usr/bin/env node
/**
 * Match library_items books to Internet Archive and download PDFs/EPUBs.
 * Strategy: search IA by title+author, fuzzy match, download to R2.
 * 
 * Usage: node scripts/backfill-books-ia-match.mjs [limit] [offset]
 */
import 'dotenv/config'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
})
const R2_BUCKET = process.env.R2_BUCKET || 'arena-cdn'
const R2_PUBLIC = process.env.R2_PUBLIC_URL || 'https://cdn.arenafi.org'

const LIMIT = parseInt(process.argv[2] || '5000')
const OFFSET = parseInt(process.argv[3] || '0')
const sleep = ms => new Promise(r => setTimeout(r, ms))

let found = 0, checked = 0, errors = 0

async function fetchJSON(url, timeout = 12000) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'RankingArenaBot/1.0 (library@arenafi.org)' },
      signal: AbortSignal.timeout(timeout),
    })
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

async function downloadFile(url, maxMB = 50) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(60000),
      redirect: 'follow',
    })
    if (!r.ok) return null
    const ct = r.headers.get('content-type') || ''
    if (ct.includes('text/html')) return null
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length < 1024 || buf.length > maxMB * 1024 * 1024) return null
    return { buffer: buf, contentType: ct, size: buf.length }
  } catch { return null }
}

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
}

function titleMatch(dbTitle, iaTitle) {
  const a = normalize(dbTitle)
  const b = normalize(iaTitle)
  if (!a || !b) return false
  // Exact or contains
  if (a === b || b.includes(a) || a.includes(b)) return true
  // First N words match
  const wa = a.split(' ').slice(0, 4).join(' ')
  const wb = b.split(' ').slice(0, 4).join(' ')
  if (wa.length > 10 && wa === wb) return true
  return false
}

async function searchIA(title, author) {
  // Build query
  const cleanTitle = title.replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim()
  let q = `title:(${encodeURIComponent(cleanTitle.slice(0, 80))})`
  if (author && author !== 'Unknown') {
    q += `+creator:(${encodeURIComponent(author.split(',')[0].split('(')[0].trim().slice(0, 40))})`
  }
  q += '+AND+mediatype:texts'

  const data = await fetchJSON(
    `https://archive.org/advancedsearch.php?q=${q}&fl[]=identifier,title,creator&rows=5&output=json`
  )
  return data?.response?.docs || []
}

async function getDownloadableFiles(identifier) {
  const data = await fetchJSON(`https://archive.org/metadata/${identifier}/files`, 8000)
  if (!data?.result) return []
  return data.result
    .filter(f => f.name && (f.name.endsWith('.pdf') || f.name.endsWith('.epub')))
    .filter(f => parseInt(f.size || 0) > 1024 && parseInt(f.size || 0) < 50 * 1024 * 1024)
    .sort((a, b) => {
      // Prefer EPUB over PDF, then smaller
      const aEpub = a.name.endsWith('.epub') ? 0 : 1
      const bEpub = b.name.endsWith('.epub') ? 0 : 1
      if (aEpub !== bEpub) return aEpub - bEpub
      return parseInt(a.size) - parseInt(b.size)
    })
}

async function processBook(book) {
  checked++
  const { id, title, author } = book
  
  // Search IA
  const results = await searchIA(title, author)
  if (!results.length) return false

  // Find matching result
  const match = results.find(r => titleMatch(title, r.title))
  if (!match) return false

  // Get downloadable files
  const files = await getDownloadableFiles(match.identifier)
  if (!files.length) return false

  // Try to download best file
  for (const f of files.slice(0, 2)) {
    const ext = f.name.endsWith('.epub') ? 'epub' : 'pdf'
    const url = `https://archive.org/download/${match.identifier}/${encodeURIComponent(f.name)}`
    const file = await downloadFile(url)
    if (!file) continue

    // Upload to R2
    const key = `library/${id}/content.${ext}`
    const ct = ext === 'epub' ? 'application/epub+zip' : 'application/pdf'
    await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: file.buffer, ContentType: ct }))
    const cdnUrl = `${R2_PUBLIC}/${key}`

    // Update DB
    const updates = { file_key: key, file_size_bytes: file.size }
    if (ext === 'epub') updates.epub_url = cdnUrl
    else updates.pdf_url = cdnUrl
    await sb.from('library_items').update(updates).eq('id', id)

    found++
    console.log(`✅ [${found}/${checked}] ${title.slice(0,50)} → ${ext} (${(file.size/1024/1024).toFixed(1)}MB) via ${match.identifier}`)
    return true
  }
  return false
}

async function main() {
  console.log(`📚 IA Book Content Backfill — limit=${LIMIT} offset=${OFFSET}`)
  
  const { data: books, error } = await sb
    .from('library_items')
    .select('id, title, author')
    .eq('category', 'book')
    .is('file_key', null)
    .is('pdf_url', null)
    .is('epub_url', null)
    .order('view_count', { ascending: false, nullsFirst: false })
    .range(OFFSET, OFFSET + LIMIT - 1)

  if (error) { console.error('DB error:', error); process.exit(1) }
  console.log(`Found ${books.length} books without content`)

  for (let i = 0; i < books.length; i++) {
    try {
      await processBook(books[i])
    } catch (e) {
      errors++
      if (errors > 50) { console.log('Too many errors, stopping'); break }
    }

    // Rate limit: 1 search per second (IA is generous but be polite)
    await sleep(1200)

    if (i > 0 && i % 100 === 0) {
      console.log(`--- Progress: ${checked} checked, ${found} found (${(100*found/checked).toFixed(1)}%), ${errors} errors ---`)
    }
  }

  console.log(`\n🏁 Done: ${checked} checked, ${found} found (${(100*found/checked).toFixed(1)}%), ${errors} errors`)
}

main().catch(console.error)
