#!/usr/bin/env node
// Upload cover images to R2, update cover_url in Supabase
import { createClient } from '@supabase/supabase-js'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'

const R2_ACCOUNT_ID = 'e13575d5cb0b28c296541dd960067496'
const R2_ACCESS_KEY_ID = '1664fa1ee89e62da0e0cb3a3aaa6acca'
const R2_SECRET = 'aaeb42380567d2ec777c0fcb37c5898ebe3b20651bf83b76af2fffb1e533a236'
const R2_BUCKET = 'arena-cdn'
const R2_PUBLIC = 'https://cdn.arenafi.org'

const sb = createClient(SUPABASE_URL, SUPABASE_KEY)
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET },
})

const sleep = ms => new Promise(r => setTimeout(r, ms))

let uploaded = 0, skipped = 0, failed = 0

async function downloadImage(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ArenaBot/1.0)' },
      redirect: 'follow',
    })
    clearTimeout(timeout)
    if (!res.ok) return null
    const contentType = res.headers.get('content-type') || ''
    if (!contentType.startsWith('image/')) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 500) return null // too small, likely error page
    return { buf, contentType }
  } catch {
    clearTimeout(timeout)
    return null
  }
}

async function uploadToR2(key, buf, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: buf,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000',
  }))
}

async function processBatch(items) {
  for (const item of items) {
    try {
      const img = await downloadImage(item.cover_url)
      if (!img) { skipped++; continue }

      const ext = img.contentType.includes('png') ? 'png' : 'jpg'
      const key = `covers/${item.id}.${ext}`
      await uploadToR2(key, img.buf, img.contentType)

      const newUrl = `${R2_PUBLIC}/${key}`
      const { error } = await sb.from('library_items').update({ cover_url: newUrl }).eq('id', item.id)
      if (error) { failed++; continue }

      uploaded++
      if (uploaded % 100 === 0) console.log(`  uploaded: ${uploaded}, skipped: ${skipped}, failed: ${failed}`)
    } catch (e) {
      failed++
    }
    await sleep(100) // rate limit
  }
}

async function main() {
  console.log('=== Upload Covers to R2 ===\n')

  let offset = 0
  const batchSize = 500

  while (true) {
    const { data, error } = await sb
      .from('library_items')
      .select('id, cover_url')
      .not('cover_url', 'is', null)
      .not('cover_url', 'like', '%cdn.arenafi.org%')
      .range(offset, offset + batchSize - 1)

    if (error) { console.error('Fetch error:', error.message); break }
    if (!data || data.length === 0) break

    console.log(`Processing batch of ${data.length} (offset ${offset})...`)
    await processBatch(data)
    offset += batchSize
    if (data.length < batchSize) break
  }

  console.log('\n=== Summary ===')
  console.log(`Uploaded: ${uploaded}`)
  console.log(`Skipped:  ${skipped}`)
  console.log(`Failed:   ${failed}`)
}

main().catch(console.error)
