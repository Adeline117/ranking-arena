#!/usr/bin/env node
/**
 * Upload library book covers and PDFs to Cloudflare R2
 * Usage: node scripts/upload-to-r2.mjs [--covers] [--pdfs] [--dry-run]
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { createClient } from '@supabase/supabase-js'

// Parse .env.local
const envPath = resolve(process.cwd(), '.env.local')
const envContent = readFileSync(envPath, 'utf-8')
const env = {}
for (const line of envContent.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=["']?(.+?)["']?\s*$/)
  if (m) env[m[1]] = m[2]
}

const R2_ENDPOINT = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
const R2_PUBLIC_URL = env.R2_PUBLIC_URL || 'https://cdn.arenafi.org'
const BUCKET = env.R2_BUCKET || 'arena-cdn'

const s3 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
})

const supabase = createClient(
  env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
)

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const doPdfs = args.includes('--pdfs') || (!args.includes('--covers') && !args.includes('--pdfs'))
const doCovers = args.includes('--covers') || (!args.includes('--covers') && !args.includes('--pdfs'))

const CONCURRENCY = 5
const TIMEOUT_MS = 30000

async function fetchWithTimeout(url, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ArenaBot/1.0)' },
      redirect: 'follow',
    })
    return res
  } finally {
    clearTimeout(timer)
  }
}

async function existsInR2(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
    return true
  } catch {
    return false
  }
}

async function uploadToR2(key, body, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }))
  return `${R2_PUBLIC_URL}/${key}`
}

function getExtFromContentType(ct) {
  if (!ct) return 'jpg'
  if (ct.includes('png')) return 'png'
  if (ct.includes('webp')) return 'webp'
  if (ct.includes('gif')) return 'gif'
  if (ct.includes('svg')) return 'svg'
  if (ct.includes('pdf')) return 'pdf'
  return 'jpg'
}

async function runPool(items, fn) {
  let i = 0
  const results = []
  async function worker() {
    while (i < items.length) {
      const idx = i++
      results[idx] = await fn(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => worker()))
  return results
}

async function uploadCovers() {
  console.log('\n📚 Fetching library items with external cover URLs...')
  const { data: items, error } = await supabase
    .from('library_items')
    .select('id, title, cover_url')
    .not('cover_url', 'is', null)

  if (error) { console.error('DB error:', error); return }

  // Filter to only external URLs (not already on R2)
  const toProcess = items.filter(it =>
    it.cover_url &&
    !it.cover_url.startsWith(R2_PUBLIC_URL) &&
    it.cover_url.startsWith('http')
  )

  console.log(`Found ${toProcess.length} covers to upload (${items.length} total with cover_url)`)
  if (!toProcess.length) return

  let success = 0, skipped = 0, failed = 0

  await runPool(toProcess, async (item, idx) => {
    const key = `covers/${item.id}.jpg`
    try {
      // Check if already exists
      if (await existsInR2(key)) {
        const r2Url = `${R2_PUBLIC_URL}/${key}`
        if (!dryRun) {
          await supabase.from('library_items').update({ cover_url: r2Url }).eq('id', item.id)
        }
        skipped++
        return
      }

      if (dryRun) {
        console.log(`  [DRY] Would upload: ${item.title}`)
        return
      }

      const res = await fetchWithTimeout(item.cover_url)
      if (!res.ok) {
        console.log(`  ✗ ${item.title} - HTTP ${res.status}`)
        failed++
        return
      }

      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 100) {
        console.log(`  ✗ ${item.title} - too small (${buf.length}b)`)
        failed++
        return
      }

      const ct = res.headers.get('content-type') || 'image/jpeg'
      const ext = getExtFromContentType(ct)
      const finalKey = `covers/${item.id}.${ext}`
      const r2Url = await uploadToR2(finalKey, buf, ct)

      await supabase.from('library_items').update({ cover_url: r2Url }).eq('id', item.id)
      success++
      if ((success + failed) % 20 === 0) {
        console.log(`  Progress: ${success} uploaded, ${failed} failed, ${skipped} skipped / ${toProcess.length}`)
      }
    } catch (err) {
      console.log(`  ✗ ${item.title} - ${err.message}`)
      failed++
    }
  })

  console.log(`\n✅ Covers done: ${success} uploaded, ${skipped} skipped (already in R2), ${failed} failed`)
}

async function uploadPdfs() {
  console.log('\n📄 Fetching library items with PDF URLs...')
  const { data: items, error } = await supabase
    .from('library_items')
    .select('id, title, pdf_url, file_key')
    .not('pdf_url', 'is', null)

  if (error) { console.error('DB error:', error); return }

  // Filter: has pdf_url, not already uploaded (no file_key), and not already R2
  const toProcess = items.filter(it =>
    it.pdf_url &&
    !it.file_key &&
    !it.pdf_url.startsWith(R2_PUBLIC_URL) &&
    it.pdf_url.startsWith('http')
  )

  console.log(`Found ${toProcess.length} PDFs to upload (${items.length} total with pdf_url)`)
  if (!toProcess.length) return

  let success = 0, skipped = 0, failed = 0

  await runPool(toProcess, async (item) => {
    const key = `library/${item.id}.pdf`
    try {
      if (await existsInR2(key)) {
        if (!dryRun) {
          await supabase.from('library_items').update({
            file_key: key,
            pdf_url: `${R2_PUBLIC_URL}/${key}`,
          }).eq('id', item.id)
        }
        skipped++
        return
      }

      if (dryRun) {
        console.log(`  [DRY] Would upload PDF: ${item.title}`)
        return
      }

      const res = await fetchWithTimeout(item.pdf_url, 60000)
      if (!res.ok) {
        console.log(`  ✗ PDF ${item.title} - HTTP ${res.status}`)
        failed++
        return
      }

      const buf = Buffer.from(await res.arrayBuffer())
      const ct = res.headers.get('content-type') || 'application/pdf'
      const r2Url = await uploadToR2(key, buf, ct)

      await supabase.from('library_items').update({
        file_key: key,
        pdf_url: r2Url,
        file_size_bytes: buf.length,
      }).eq('id', item.id)

      success++
      console.log(`  ✓ ${item.title} (${(buf.length / 1024 / 1024).toFixed(1)}MB)`)
    } catch (err) {
      console.log(`  ✗ PDF ${item.title} - ${err.message}`)
      failed++
    }
  })

  console.log(`\n✅ PDFs done: ${success} uploaded, ${skipped} skipped, ${failed} failed`)
}

async function main() {
  console.log('🚀 R2 Upload Script')
  console.log(`   Bucket: ${BUCKET}`)
  console.log(`   Public URL: ${R2_PUBLIC_URL}`)
  if (dryRun) console.log('   ⚠️  DRY RUN MODE')

  if (doCovers) await uploadCovers()
  if (doPdfs) await uploadPdfs()

  console.log('\n🎉 Done!')
}

main().catch(err => { console.error(err); process.exit(1) })
