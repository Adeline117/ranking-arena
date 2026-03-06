#!/usr/bin/env node
/**
 * Robust library file downloader → R2 uploader.
 * Handles: papers (arxiv), whitepapers, books (archive.org).
 * 
 * Usage:
 *   node scripts/download-library-r2.mjs paper 1000
 *   node scripts/download-library-r2.mjs whitepaper 200
 *   node scripts/download-library-r2.mjs book 500
 */
import 'dotenv/config'
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
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

const CATEGORY = process.argv[2] || 'paper'
const LIMIT = parseInt(process.argv[3] || '5000')
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '8')
const MAX_FILE_SIZE = 50 * 1024 * 1024
const DOWNLOAD_TIMEOUT = 15000

const sleep = ms => new Promise(r => setTimeout(r, ms))

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
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT)
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/pdf,application/epub+zip,*/*',
      },
      signal: controller.signal,
      redirect: 'follow',
    })
    clearTimeout(timer)
    if (!res.ok) return null
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('text/html')) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 1024 || buf.length > MAX_FILE_SIZE) return null
    return { buffer: buf, contentType: ct, size: buf.length }
  } catch { return null }
}

// For archive.org/details/ URLs, find the actual PDF download link
async function resolveArchiveOrgPdf(detailsUrl) {
  const id = detailsUrl.split('/details/')[1]?.split(/[?/#]/)[0]
  if (!id) return null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    const res = await fetch(`https://archive.org/metadata/${id}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    clearTimeout(timer)
    if (!res.ok) return null
    const data = await res.json()
    if (data?.metadata?.access_restricted_item === 'true') return null
    const files = data?.files || []
    const pdfs = files
      .filter(f => f.name?.endsWith('.pdf') && !f.name?.includes('_abbyy'))
      .map(f => ({ ...f, sizeNum: parseInt(f.size || '0') }))
      .filter(f => f.sizeNum > 10000 && f.sizeNum <= MAX_FILE_SIZE)
      .sort((a, b) => b.sizeNum - a.sizeNum)
    if (!pdfs.length) return null
    return `https://archive.org/download/${id}/${encodeURIComponent(pdfs[0].name)}`
  } catch { return null }
}

function getExt(url, ct) {
  if (ct?.includes('epub') || url?.includes('.epub')) return 'epub'
  return 'pdf'
}

async function processItem(item) {
  let url = item.pdf_url
  if (!url) return { status: 'skip' }

  // Skip already-on-CDN URLs
  if (url.includes('cdn.arenafi.org')) return { status: 'skip' }

  // Resolve archive.org detail pages to direct PDF links
  if (url.includes('archive.org/details/') && !url.endsWith('.pdf')) {
    url = await resolveArchiveOrgPdf(url)
    if (!url) return { status: 'fail', reason: 'archive.org no downloadable PDF' }
  }

  // Skip non-downloadable URLs
  if (url.includes('docs.') || url.includes('/cgi-bin/')) return { status: 'skip' }

  const file = await downloadFile(url)
  if (!file) return { status: 'fail', reason: 'download failed' }

  const ext = getExt(url, file.contentType)
  const key = `library/${item.id}/content.${ext}`
  const cdnUrl = await uploadToR2(key, file.buffer, file.contentType || 'application/pdf')

  const updates = { file_key: key, file_size_bytes: file.size, pdf_url: cdnUrl }
  await sb.from('library_items').update(updates).eq('id', item.id)

  return { status: 'ok', key, size: file.size, ext }
}

async function main() {
  console.log(`=== Library Download → R2 | ${CATEGORY} | limit=${LIMIT} ===\n`)
  let offset = 0, total = 0, ok = 0, skip = 0, fail = 0
  const startTime = Date.now()

  while (total < LIMIT) {
    const { data: items, error } = await sb
      .from('library_items')
      .select('id, title, pdf_url')
      .eq('category', CATEGORY)
      .is('file_key', null)
      .not('pdf_url', 'is', null)
      .not('pdf_url', 'like', '%cdn.arenafi.org%')
      .order('view_count', { ascending: false, nullsFirst: false })
      .range(offset, offset + 99)

    if (error) { console.error('DB error:', error.message); break }
    if (!items?.length) { console.log('No more items to process'); break }

    // Process items with concurrency limit using a simple semaphore
    let active = 0
    const queue = [...items]
    
    await new Promise(resolve => {
      function tryNext() {
        while (active < CONCURRENCY && queue.length > 0 && total < LIMIT) {
          const item = queue.shift()
          active++
          const itemNum = ++total
          const title = (item.title || 'untitled').slice(0, 60)
          
          Promise.race([
            processItem(item),
            sleep(25000).then(() => ({ status: 'fail', reason: 'timeout' }))
          ]).then(r => {
            if (r.status === 'ok') {
              ok++
              const mb = (r.size / 1024 / 1024).toFixed(1)
              console.log(`✓ [${itemNum}] ${title} → ${r.ext} (${mb}MB)`)
            } else if (r.status === 'skip') {
              skip++
            } else {
              fail++
              if (itemNum <= 20 || itemNum % 100 === 0) console.log(`✗ [${itemNum}] ${title} (${r.reason || 'error'})`)
            }
          }).catch(() => { fail++ }).finally(() => {
            active--
            if (queue.length === 0 && active === 0) resolve()
            else tryNext()
          })
        }
        if (queue.length === 0 && active === 0) resolve()
      }
      tryNext()
    })
    offset += 100

    if (total % 100 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
      console.log(`\n--- ${total} processed | ${ok} uploaded | ${skip} skipped | ${fail} failed | ${elapsed}s ---\n`)
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
  console.log(`\n${'='.repeat(60)}`)
  console.log(`DONE: ${total} processed | ${ok} uploaded | ${skip} skipped | ${fail} failed | ${elapsed}s`)
  console.log(`${'='.repeat(60)}`)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
