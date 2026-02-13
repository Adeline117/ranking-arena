#!/usr/bin/env node
/**
 * Migrate files from Supabase Storage to Cloudflare R2
 * and update library_items.pdf_url to point to R2 CDN.
 * 
 * DRY RUN by default. Set DRY_RUN=false to actually migrate.
 * 
 * Usage: node scripts/migrate-supabase-to-r2.mjs
 */
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'

const DRY_RUN = process.env.DRY_RUN !== 'false'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
})

const R2_BUCKET = process.env.R2_BUCKET || 'arena-cdn'
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || 'https://cdn.arenafi.org'
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL

async function r2Exists(key) {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }))
    return true
  } catch { return false }
}

async function uploadToR2(key, buffer, contentType) {
  await r2.send(new PutObjectCommand({
    Bucket: R2_BUCKET, Key: key, Body: buffer, ContentType: contentType,
  }))
}

// Part 1: Migrate Supabase Storage files to R2
async function migrateStorageFiles() {
  console.log('\n=== Part 1: Migrate Supabase Storage → R2 ===')
  
  const bucketPrefixMap = [
    { bucket: 'library', folder: 'books', r2Prefix: 'library/books/' },
    { bucket: 'library', folder: 'papers', r2Prefix: 'papers/' },
    { bucket: 'library', folder: 'whitepapers', r2Prefix: 'whitepapers/' },
  ]

  let migrated = 0, skipped = 0, failed = 0

  for (const { bucket, folder, r2Prefix } of bucketPrefixMap) {
    console.log(`\nScanning ${bucket}/${folder}...`)
    let offset = 0
    while (true) {
      const { data: files } = await supabase.storage.from(bucket).list(folder, { limit: 100, offset })
      if (!files || files.length === 0) break
      
      const realFiles = files.filter(f => f.id) // skip folders
      for (const file of realFiles) {
        const r2Key = `${r2Prefix}${file.name}`
        
        if (await r2Exists(r2Key)) {
          skipped++
          continue
        }

        if (DRY_RUN) {
          console.log(`  [DRY] Would migrate: ${folder}/${file.name} → ${r2Key}`)
          migrated++
          continue
        }

        try {
          const { data, error } = await supabase.storage.from(bucket).download(`${folder}/${file.name}`)
          if (error || !data) { console.error(`  ✗ Download failed: ${file.name}`, error); failed++; continue }
          
          const buffer = Buffer.from(await data.arrayBuffer())
          const ct = file.name.endsWith('.epub') ? 'application/epub+zip' : 'application/pdf'
          await uploadToR2(r2Key, buffer, ct)
          console.log(`  ✓ ${file.name} (${(buffer.length/1024).toFixed(0)}KB)`)
          migrated++
        } catch (e) {
          console.error(`  ✗ ${file.name}:`, e.message)
          failed++
        }
      }
      
      offset += files.length
      if (files.length < 100) break
    }
  }

  console.log(`\nStorage migration: ${migrated} migrated, ${skipped} already in R2, ${failed} failed`)
}

// Part 2: Update DB rows that still point to Supabase URLs
async function updateDbUrls() {
  console.log('\n=== Part 2: Update pdf_url from Supabase → R2 ===')
  
  const { data: rows, error } = await supabase
    .from('library_items')
    .select('id, pdf_url')
    .like('pdf_url', `%${SUPABASE_URL}%`)
    .limit(5000)

  if (error) { console.error('Query error:', error); return }
  console.log(`Found ${rows.length} rows with Supabase pdf_url`)

  let updated = 0, skipped = 0
  for (const row of rows) {
    // Extract the storage path from Supabase URL
    // Format: https://xxx.supabase.co/storage/v1/object/public/library/papers/uuid.pdf
    const match = row.pdf_url.match(/\/storage\/v1\/object\/public\/library\/(.+)$/)
    if (!match) {
      // Some might be /storage/v1/object/sign/... or other formats
      console.log(`  Skip (unrecognized URL): ${row.pdf_url.substring(0, 80)}`)
      skipped++
      continue
    }

    const storagePath = match[1] // e.g. "papers/uuid.pdf"
    let r2Key
    if (storagePath.startsWith('papers/')) r2Key = storagePath // papers/ stays as papers/
    else if (storagePath.startsWith('books/')) r2Key = `library/books/${storagePath.replace('books/', '')}`
    else if (storagePath.startsWith('whitepapers/')) r2Key = storagePath
    else { console.log(`  Skip (unknown prefix): ${storagePath}`); skipped++; continue }

    const newUrl = `${R2_PUBLIC_URL}/${r2Key}`

    if (DRY_RUN) {
      console.log(`  [DRY] ${row.id}: ${row.pdf_url.substring(0,60)} → ${newUrl.substring(0,60)}`)
      updated++
      continue
    }

    const { error: updateErr } = await supabase
      .from('library_items')
      .update({ pdf_url: newUrl, updated_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updateErr) { console.error(`  ✗ ${row.id}:`, updateErr); skipped++}
    else { updated++ }
  }

  console.log(`\nURL updates: ${updated} updated, ${skipped} skipped`)
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`)
  await migrateStorageFiles()
  await updateDbUrls()
  console.log('\nDone!')
  if (DRY_RUN) console.log('Run with DRY_RUN=false to execute.')
}

main().catch(console.error)
