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
const BATCH_SIZE = 50  // smaller batches to avoid Supabase statement timeout
const DELAY_MS = 500 // 0.5s between downloads

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function getPdfUrl(contentUrl) {
  // arxiv: https://arxiv.org/abs/XXXX → https://arxiv.org/pdf/XXXX
  // Keep version if present (e.g. 2409.14914v1), arxiv requires it for some papers
  const arxivMatch = contentUrl.match(/arxiv\.org\/abs\/(.+)$/)
  if (arxivMatch) {
    return `https://arxiv.org/pdf/${arxivMatch[1]}`
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
  let resp = await fetch(pdfUrl, {
    headers: { 'User-Agent': 'ArenaFi-Bot/1.0 (https://arenafi.org)' },
    redirect: 'follow',
  })
  // If 404 and no version in URL, try appending v1 (most common)
  if (resp.status === 404 && pdfUrl.includes('arxiv.org/pdf/') && !/v\d+$/.test(pdfUrl)) {
    resp = await fetch(`${pdfUrl}v1`, {
      headers: { 'User-Agent': 'ArenaFi-Bot/1.0 (https://arenafi.org)' },
      redirect: 'follow',
    })
  }
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
  let downloaded = 0
  let skipped = 0
  let failed = 0
  let cursor = null  // cursor-based: fetch rows with id > cursor (UUID)

  console.log('📄 Starting paper download to R2...')

  while (true) {
    let query = supabase
      .from('library_items')
      .select('id, content_url, title')
      .in('category', ['paper', 'whitepaper'])
      .not('content_url', 'is', null)
      .not('content_url', 'like', '%cdn.arenafi.org%')
      .order('id')
      .limit(BATCH_SIZE)
    
    if (cursor) query = query.gt('id', cursor)

    const { data: papers, error } = await query

    if (error) { console.error('DB error:', error); await sleep(5000); continue }
    if (!papers || papers.length === 0) break

    for (const paper of papers) {
      cursor = paper.id  // advance cursor past this row regardless of outcome

      const pdfUrl = getPdfUrl(paper.content_url)
      if (!pdfUrl) {
        skipped++
        continue
      }

      const r2Key = getR2Key(paper.content_url)
      try {
        console.log(`  📥 [${downloaded+1}] ${paper.title?.slice(0, 60)}...`)
        const cdnUrl = await downloadAndUpload(pdfUrl, r2Key)
        
        await supabase
          .from('library_items')
          .update({ content_url: cdnUrl })
          .eq('id', paper.id)

        downloaded++
        if (downloaded % 50 === 0) {
          console.log(`  ✅ Progress: ${downloaded} downloaded, ${skipped} skipped, ${failed} failed`)
        }
        await sleep(DELAY_MS)  // only delay after successful download (polite to arxiv)
      } catch (err) {
        failed++
        if (failed <= 50) console.error(`  ❌ ${paper.title?.slice(0, 50)}: ${err.message}`)
        await sleep(200)  // brief delay for failures
      }
    }

    // Safety
    if (downloaded + failed > 20000) {
      console.log('⏸️  Batch limit reached, restart to continue')
      break
    }
  }

  console.log(`\n✅ Done: ${downloaded} downloaded, ${skipped} skipped, ${failed} failed`)
}

main().catch(console.error)
