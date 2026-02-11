#!/usr/bin/env node
/**
 * Download papers from arxiv/external URLs to Cloudflare R2
 * Updates library_items.content_url to point to cdn.arenafi.org
 * 
 * Rate-limited: 1 request per second to be polite to arxiv
 */

import { createClient } from '@supabase/supabase-js'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import dotenv from 'dotenv'
import { resolve } from 'path'

dotenv.config({ path: resolve(import.meta.dirname, '../.env.local') })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
})

const CDN_URL = process.env.R2_PUBLIC_URL || 'https://cdn.arenafi.org'
const BUCKET = process.env.R2_BUCKET || 'arena-cdn'
const BATCH_SIZE = 100
const DELAY_MS = 1500 // 1.5s between downloads (polite to arxiv)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function getPdfUrl(contentUrl) {
  // arxiv: https://arxiv.org/abs/XXXX → https://arxiv.org/pdf/XXXX.pdf
  const arxivMatch = contentUrl.match(/arxiv\.org\/abs\/(.+?)(?:v\d+)?$/)
  if (arxivMatch) {
    return `https://arxiv.org/pdf/${arxivMatch[1]}.pdf`
  }
  // Already a PDF URL
  if (contentUrl.endsWith('.pdf')) return contentUrl
  // Other URLs — skip
  return null
}

function getR2Key(contentUrl) {
  const arxivMatch = contentUrl.match(/arxiv\.org\/abs\/(.+)$/)
  if (arxivMatch) {
    return `papers/arxiv/${arxivMatch[1].replace(/\//g, '_')}.pdf`
  }
  // Generic
  const hash = contentUrl.split('/').pop()
  return `papers/other/${hash}.pdf`
}

async function downloadAndUpload(pdfUrl, r2Key) {
  const resp = await fetch(pdfUrl, {
    headers: { 'User-Agent': 'ArenaFi-Bot/1.0 (https://arenafi.org)' },
    redirect: 'follow',
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${pdfUrl}`)
  
  const buffer = Buffer.from(await resp.arrayBuffer())
  if (buffer.length < 1000) throw new Error(`Too small: ${buffer.length} bytes`)

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: r2Key,
    Body: buffer,
    ContentType: 'application/pdf',
  }))

  return `${CDN_URL}/${r2Key}`
}

async function main() {
  let offset = 0
  let downloaded = 0
  let skipped = 0
  let failed = 0

  console.log('📄 Starting paper download to R2...')

  while (true) {
    const { data: papers, error } = await supabase
      .from('library_items')
      .select('id, content_url, title')
      .in('category', ['paper', 'whitepaper'])
      .not('content_url', 'is', null)
      .not('content_url', 'like', '%cdn.arenafi.org%')
      .range(offset, offset + BATCH_SIZE - 1)
      .order('id')

    if (error) { console.error('DB error:', error); break }
    if (!papers || papers.length === 0) break

    for (const paper of papers) {
      const pdfUrl = getPdfUrl(paper.content_url)
      if (!pdfUrl) {
        skipped++
        continue
      }

      const r2Key = getR2Key(paper.content_url)
      try {
        const cdnUrl = await downloadAndUpload(pdfUrl, r2Key)
        
        await supabase
          .from('library_items')
          .update({ content_url: cdnUrl })
          .eq('id', paper.id)

        downloaded++
        if (downloaded % 10 === 0) {
          console.log(`  ✅ ${downloaded} downloaded, ${skipped} skipped, ${failed} failed`)
        }
      } catch (err) {
        failed++
        if (failed <= 5) console.error(`  ❌ ${paper.title?.slice(0, 50)}: ${err.message}`)
      }

      await sleep(DELAY_MS)
    }

    offset += BATCH_SIZE
    // Safety: if we've been running too long, stop
    if (downloaded + failed > 5000) {
      console.log('⏸️  Batch limit reached, restart to continue')
      break
    }
  }

  console.log(`\n✅ Done: ${downloaded} downloaded, ${skipped} skipped, ${failed} failed`)
}

main().catch(console.error)
