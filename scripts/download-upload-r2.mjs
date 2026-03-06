#!/usr/bin/env node
/**
 * Download existing pdf_url files and upload to R2 storage.
 * Updates file_key + keeps pdf_url pointing to CDN.
 * 
 * Usage:
 *   node scripts/download-upload-r2.mjs [category] [limit]
 *   node scripts/download-upload-r2.mjs paper 500
 *   node scripts/download-upload-r2.mjs whitepaper 200
 *   node scripts/download-upload-r2.mjs book 100
 */
import 'dotenv/config'
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY
const R2_BUCKET = process.env.R2_BUCKET || 'arena-cdn'
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || 'https://cdn.arenafi.org'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY

import { createClient } from '@supabase/supabase-js'
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
})

const sleep = ms => new Promise(r => setTimeout(r, ms))
const CATEGORY = process.argv[2] || 'paper'
const LIMIT = parseInt(process.argv[3] || '5000')
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5')
const MAX_FILE_SIZE = 30 * 1024 * 1024 // 30MB max

async function fileExistsInR2(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }))
    return true
  } catch { return false }
}

async function uploadToR2(key, buffer, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }))
  return `${R2_PUBLIC_URL}/${key}`
}

function getExtension(url, contentType) {
  if (contentType?.includes('epub')) return 'epub'
  if (contentType?.includes('pdf')) return 'pdf'
  if (url.includes('.epub')) return 'epub'
  if (url.includes('.pdf')) return 'pdf'
  return 'pdf'
}

async function downloadFile(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/pdf,application/epub+zip,*/*',
      },
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    })
    if (!res.ok) return null

    const contentType = res.headers.get('content-type') || ''
    const contentLength = parseInt(res.headers.get('content-length') || '0')
    
    if (contentType.includes('text/html')) return null
    if (contentLength > MAX_FILE_SIZE) return null

    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length < 1024 || buffer.length > MAX_FILE_SIZE) return null

    return { buffer, contentType, size: buffer.length }
  } catch {
    return null
  }
}

async function processItem(item) {
  const url = item.pdf_url || item.epub_url
  if (!url) return null

  // Skip non-downloadable URLs
  if (url.includes('archive.org/details/') && !url.endsWith('.pdf') && !url.endsWith('.epub')) return null
  if (url.includes('docs.') || url.includes('sec.gov/cgi') || url.includes('fca.org') || url.includes('vara.ae')) return null

  const file = await downloadFile(url)
  if (!file) return null

  const ext = getExtension(url, file.contentType)
  const key = `library/${item.id}/content.${ext}`

  // Check if already uploaded
  if (await fileExistsInR2(key)) {
    return { id: item.id, key, skipped: true }
  }

  const cdnUrl = await uploadToR2(key, file.buffer, file.contentType || (ext === 'epub' ? 'application/epub+zip' : 'application/pdf'))

  // Update DB
  const updates = { file_key: key, file_size_bytes: file.size }
  if (ext === 'epub') {
    updates.epub_url = cdnUrl
  } else {
    updates.pdf_url = cdnUrl
  }
  await sb.from('library_items').update(updates).eq('id', item.id)

  return { id: item.id, key, size: file.size, ext }
}

async function main() {
  console.log(`=== Download & Upload to R2 ===`)
  console.log(`Category: ${CATEGORY}, Limit: ${LIMIT}, Concurrency: ${CONCURRENCY}\n`)

  let offset = 0, total = 0, uploaded = 0, skipped = 0, failed = 0

  while (total < LIMIT) {
    // Get items that have pdf_url but NO file_key
    const { data: items, error } = await sb
      .from('library_items')
      .select('id, title, pdf_url, epub_url')
      .eq('category', CATEGORY)
      .is('file_key', null)
      .not('pdf_url', 'is', null)
      .order('view_count', { ascending: false })
      .range(offset, offset + 99)

    if (error) { console.error('DB error:', error.message); break }
    if (!items?.length) { console.log('No more items'); break }

    for (let i = 0; i < items.length; i += CONCURRENCY) {
      const chunk = items.slice(i, i + CONCURRENCY)
      const results = await Promise.all(chunk.map(processItem))

      for (let j = 0; j < results.length; j++) {
        if (total >= LIMIT) break
        total++
        const r = results[j]
        const title = chunk[j].title?.slice(0, 50) || 'untitled'
        if (!r) {
          failed++
        } else if (r.skipped) {
          skipped++
          console.log(`⊘ [${total}] ${title} (already in R2)`)
        } else {
          uploaded++
          const sizeMB = (r.size / 1024 / 1024).toFixed(1)
          console.log(`✓ [${total}] ${title} → ${r.ext} (${sizeMB}MB)`)
        }
      }

      // Small delay between chunks
      await sleep(300)
    }

    offset += 100
    if (total % 500 === 0) {
      console.log(`\n--- Progress: ${total} processed | ${uploaded} uploaded | ${skipped} skipped | ${failed} failed ---\n`)
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`DONE: ${total} processed | ${uploaded} uploaded | ${skipped} skipped | ${failed} failed`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)
