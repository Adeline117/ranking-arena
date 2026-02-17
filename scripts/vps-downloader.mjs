#!/usr/bin/env node
/**
 * VPS Downloader: reads tasks.json, downloads EPUBs from LibGen, uploads to Supabase Storage
 * Run on Japan VPS where LibGen is accessible
 */

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_KEY) { console.error('Set SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const DOWNLOAD_DELAY = 2000

async function downloadFile(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 45000)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' },
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  } finally {
    clearTimeout(timeout)
  }
}

async function main() {
  const tasksFile = process.argv[2] || '/opt/book-download-tasks.json'
  if (!fs.existsSync(tasksFile)) { console.error(`Tasks file not found: ${tasksFile}`); process.exit(1) }
  
  const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'))
  console.log(`Processing ${tasks.length} download tasks...`)
  
  let downloaded = 0, failed = 0
  
  for (const task of tasks) {
    try {
      console.log(`[${downloaded + failed + 1}/${tasks.length}] "${task.title}"`)
      console.log(`  Downloading from ${task.downloadUrl}`)
      
      const buffer = await downloadFile(task.downloadUrl)
      
      if (buffer.length < 1000) {
        console.log(`  ✗ Too small (${buffer.length}B)`)
        failed++
        continue
      }
      
      const isEpub = buffer[0] === 0x50 && buffer[1] === 0x4B
      const isPdf = buffer[0] === 0x25 && buffer[1] === 0x50
      const ext = isEpub ? 'epub' : isPdf ? 'pdf' : 'epub'
      
      const fileKey = `library/${ext}/${task.bookId}.${ext}`
      console.log(`  Uploading ${ext} (${(buffer.length/1024/1024).toFixed(1)}MB)...`)
      
      const { error: uploadErr } = await supabase.storage
        .from('library-files')
        .upload(fileKey, buffer, {
          contentType: ext === 'epub' ? 'application/epub+zip' : 'application/pdf',
          upsert: true,
        })
      
      if (uploadErr) { console.log(`  ✗ Upload error: ${uploadErr.message}`); failed++; continue }
      
      const { data: { publicUrl } } = supabase.storage
        .from('library-files')
        .getPublicUrl(fileKey)
      
      const update = { file_key: fileKey }
      if (ext === 'epub') update.epub_url = publicUrl
      else update.pdf_url = publicUrl
      
      await supabase.from('library_items').update(update).eq('id', task.bookId)
      
      downloaded++
      console.log(`  ✓ Done (${downloaded} total)`)
    } catch (e) {
      console.log(`  ✗ Error: ${e.message}`)
      failed++
    }
    
    await new Promise(r => setTimeout(r, DOWNLOAD_DELAY))
  }
  
  console.log(`\n=== Summary ===\nDownloaded: ${downloaded}\nFailed: ${failed}`)
}

main().catch(console.error)
