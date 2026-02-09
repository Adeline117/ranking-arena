#!/usr/bin/env node
/**
 * Download PDFs from pdf_url to Supabase Storage for items that have no file_key yet.
 * Run: node scripts/download-pdfs.mjs
 */
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const BUCKET = 'library-files'
const BATCH_SIZE = 50
const CONCURRENCY = 5
const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100 MB limit

if (!SUPABASE_KEY) {
  console.error('Missing SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

let downloaded = 0
let failed = 0
let skipped = 0

async function downloadOne(item) {
  const { id, pdf_url, title } = item
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)
    const res = await fetch(pdf_url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'RankingArena-LibraryBot/1.0' },
      redirect: 'follow',
    })
    clearTimeout(timeout)

    if (!res.ok) {
      failed++
      return
    }

    const contentLength = parseInt(res.headers.get('content-length') || '0')
    if (contentLength > MAX_FILE_SIZE) {
      skipped++
      return
    }

    const contentType = res.headers.get('content-type') || 'application/pdf'
    const buffer = Buffer.from(await res.arrayBuffer())
    
    if (buffer.length < 1000) {
      skipped++
      return
    }

    const ext = contentType.includes('epub') ? 'epub' : 'pdf'
    const fileKey = `papers/${randomUUID()}.${ext}`

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(fileKey, buffer, { contentType, upsert: false })

    if (uploadError) {
      failed++
      return
    }

    const { error: updateError } = await supabase
      .from('library_items')
      .update({ file_key: fileKey, file_size_bytes: buffer.length })
      .eq('id', id)

    if (updateError) {
      console.error(`DB update failed for ${id}:`, updateError.message)
      failed++
      return
    }

    downloaded++
    if (downloaded % 50 === 0) {
      console.log(`Progress: ${downloaded} downloaded, ${failed} failed, ${skipped} skipped`)
    }
  } catch (err) {
    failed++
  }
}

async function processInBatches() {
  let offset = 0
  let hasMore = true

  while (hasMore) {
    const { data, error } = await supabase
      .from('library_items')
      .select('id, pdf_url, title')
      .not('pdf_url', 'is', null)
      .is('file_key', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + BATCH_SIZE - 1)

    if (error) {
      console.error('Query error:', error.message)
      break
    }

    if (!data || data.length === 0) {
      hasMore = false
      break
    }

    // Process batch with concurrency limit
    for (let i = 0; i < data.length; i += CONCURRENCY) {
      const chunk = data.slice(i, i + CONCURRENCY)
      await Promise.all(chunk.map(item => downloadOne(item)))
    }

    offset += BATCH_SIZE
    console.log(`Batch done. Offset: ${offset}, Downloaded: ${downloaded}, Failed: ${failed}, Skipped: ${skipped}`)
  }

  console.log(`\nDone! Downloaded: ${downloaded}, Failed: ${failed}, Skipped: ${skipped}`)
}

processInBatches()
