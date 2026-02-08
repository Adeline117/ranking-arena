#!/usr/bin/env npx tsx
/**
 * Migration Script: Download existing pdf_urls and upload to R2
 *
 * Usage:
 *   npx tsx scripts/migrate-pdfs-to-r2.ts [--dry-run] [--limit 100] [--offset 0]
 *
 * What it does:
 *   1. Fetches library_items with pdf_url but no r2_pdf_url
 *   2. Downloads each PDF from the original URL
 *   3. Uploads to R2
 *   4. Updates the DB row with r2_pdf_url and r2_pdf_key
 *
 * Requirements:
 *   - R2_* env vars configured in .env.local
 *   - SUPABASE_SERVICE_ROLE_KEY in .env.local
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { isR2Configured, uploadFile, libraryPdfKey, fileExists } from '../lib/r2'

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const limitIdx = args.indexOf('--limit')
const batchLimit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : 50
const offsetIdx = args.indexOf('--offset')
const startOffset = offsetIdx >= 0 ? parseInt(args[offsetIdx + 1]) : 0

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
)

async function main() {
  console.log('=== PDF → R2 Migration ===')
  console.log(`Dry run: ${dryRun}`)
  console.log(`Batch limit: ${batchLimit}, Offset: ${startOffset}`)

  if (!isR2Configured()) {
    console.error('❌ R2 is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in .env.local')
    process.exit(1)
  }

  // Fetch items with pdf_url but without r2_pdf_url
  const { data: items, error, count } = await supabase
    .from('library_items')
    .select('id, title, pdf_url', { count: 'exact' })
    .not('pdf_url', 'is', null)
    .is('r2_pdf_url', null)
    .order('view_count', { ascending: false })
    .range(startOffset, startOffset + batchLimit - 1)

  if (error) {
    console.error('❌ DB query failed:', error.message)
    process.exit(1)
  }

  console.log(`Found ${count} total items needing migration, processing ${items?.length || 0} in this batch\n`)

  if (!items || items.length === 0) {
    console.log('✅ Nothing to migrate!')
    return
  }

  let success = 0
  let skipped = 0
  let failed = 0

  for (const item of items) {
    const shortTitle = (item.title || 'untitled').slice(0, 50)
    process.stdout.write(`[${success + skipped + failed + 1}/${items.length}] ${shortTitle}... `)

    if (!item.pdf_url) {
      console.log('SKIP (no url)')
      skipped++
      continue
    }

    try {
      // Derive filename from URL
      const urlPath = new URL(item.pdf_url).pathname
      const filename = decodeURIComponent(urlPath.split('/').pop() || 'document.pdf')
      const key = libraryPdfKey(item.id, filename)

      // Check if already uploaded
      if (await fileExists(key)) {
        console.log('SKIP (already in R2)')
        skipped++
        continue
      }

      if (dryRun) {
        console.log(`DRY RUN → ${key}`)
        success++
        continue
      }

      // Download
      const res = await fetch(item.pdf_url, {
        headers: { 'User-Agent': 'RankingArena-Migration/1.0' },
        signal: AbortSignal.timeout(60_000),
      })

      if (!res.ok) {
        console.log(`FAIL (HTTP ${res.status})`)
        failed++
        continue
      }

      const buffer = Buffer.from(await res.arrayBuffer())
      const contentType = res.headers.get('content-type') || 'application/pdf'

      // Upload to R2
      const { url } = await uploadFile(key, buffer, contentType)

      // Update DB
      const { error: updateErr } = await supabase
        .from('library_items')
        .update({
          r2_pdf_url: url,
          r2_pdf_key: key,
          updated_at: new Date().toISOString(),
        })
        .eq('id', item.id)

      if (updateErr) {
        console.log(`WARN (uploaded but DB update failed: ${updateErr.message})`)
        failed++
        continue
      }

      console.log(`OK (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`)
      success++

      // Small delay to be nice
      await new Promise(r => setTimeout(r, 200))
    } catch (e: any) {
      console.log(`FAIL (${e.message?.slice(0, 60)})`)
      failed++
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`✅ Success: ${success}`)
  console.log(`⏭️  Skipped: ${skipped}`)
  console.log(`❌ Failed:  ${failed}`)

  if (count && count > startOffset + batchLimit) {
    console.log(`\n📌 More items remaining. Run again with --offset ${startOffset + batchLimit}`)
  }
}

main().catch(e => {
  console.error('Fatal error:', e)
  process.exit(1)
})
