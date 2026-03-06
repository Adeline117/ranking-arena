#!/usr/bin/env node
/**
 * Phase 2: Bulk download from LibGen using pre-searched MD5 list
 * Runs on Japan VPS (fast LibGen access, no Anna's Archive needed)
 * 10 concurrent downloads
 */

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_KEY) { console.error('Set SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const CONCURRENCY = 10
const DOWNLOAD_TIMEOUT = 120000

async function getDownloadUrl(md5) {
  try {
    const r = await fetch(`https://libgen.li/ads.php?md5=${md5}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' },
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) return null
    const html = await r.text()
    const m = html.match(/get\.php\?md5=([a-f0-9]+)&(?:amp;)?key=([A-Z0-9]+)/i)
    return m ? `https://libgen.li/get.php?md5=${m[1]}&key=${m[2]}` : null
  } catch { return null }
}

async function downloadAndUpload(task) {
  for (const md5 of task.md5s) {
    try {
      const url = await getDownloadUrl(md5)
      if (!url) continue
      
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT)
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal, redirect: 'follow' })
        if (!r.ok) continue
        const buf = Buffer.from(await r.arrayBuffer())
        if (buf.length < 1000) continue
        
        const isEpub = buf[0] === 0x50 && buf[1] === 0x4B
        const isPdf = buf[0] === 0x25 && buf[1] === 0x50
        const ext = isEpub ? 'epub' : isPdf ? 'pdf' : 'epub'
        const fileKey = `library/${ext}/${task.bookId}.${ext}`
        
        const { error } = await supabase.storage.from('library-files').upload(fileKey, buf, {
          contentType: ext === 'epub' ? 'application/epub+zip' : 'application/pdf',
          upsert: true,
        })
        if (error) continue
        
        const { data: { publicUrl } } = supabase.storage.from('library-files').getPublicUrl(fileKey)
        const update = { file_key: fileKey }
        if (ext === 'epub') update.epub_url = publicUrl; else update.pdf_url = publicUrl
        await supabase.from('library_items').update(update).eq('id', task.bookId)
        
        console.log(`✓ ${task.title.slice(0,60)} (${ext} ${(buf.length/1024/1024).toFixed(1)}MB)`)
        return true
      } finally { clearTimeout(t) }
    } catch { /* next md5 */ }
  }
  return false
}

async function main() {
  const tasksFile = process.argv[2] || '/opt/book-md5-tasks.json'
  const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'))
  console.log(`Processing ${tasks.length} tasks, ${CONCURRENCY} concurrent`)
  
  let success = 0, total = 0, start = Date.now()
  
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(batch.map(t => downloadAndUpload(t)))
    
    for (const r of results) {
      total++
      if (r.status === 'fulfilled' && r.value) success++
    }
    
    const min = (Date.now() - start) / 60000
    console.log(`--- ${success}/${total} (${(success/min).toFixed(1)}/min) ---`)
    await new Promise(r => setTimeout(r, 1000))
  }
  
  console.log(`\nFINAL: ${success}/${total} in ${((Date.now()-start)/60000).toFixed(1)}min`)
}

main().catch(console.error)
