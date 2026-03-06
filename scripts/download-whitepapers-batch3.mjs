#!/usr/bin/env node
/**
 * Batch 3: Only download whitepapers where pdf_url ends with .pdf
 */
import fs from 'fs'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const BUCKET = 'library'
const STORAGE_BASE = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}`

async function downloadWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 1000) throw new Error(`Too small: ${buf.length}b`)
    if (buf[0] !== 0x25 || buf[1] !== 0x50) throw new Error('Not PDF')
    return buf
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  // Get whitepapers without file_key, where pdf_url looks like a real PDF
  const res = await fetch(`${SUPABASE_URL}/rest/v1/library_items?category=eq.whitepaper&file_key=is.null&pdf_url=not.is.null&select=id,title,pdf_url,crypto_symbols&limit=200`, {
    headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'apikey': SERVICE_KEY },
  })
  const all = await res.json()
  // Only try URLs ending in .pdf
  const items = all.filter(i => i.pdf_url && i.pdf_url.match(/\.pdf(\?.*)?$/i))
  console.log(`Found ${all.length} total, ${items.length} with .pdf URLs`)

  let success = 0, failed = 0

  for (const item of items) {
    const symbol = (item.crypto_symbols?.[0] || item.id.slice(0, 8)).toLowerCase()
    const filename = `${symbol}-${item.id.slice(0, 8)}.pdf`
    const storagePath = `whitepapers/${filename}`
    const publicUrl = `${STORAGE_BASE}/${storagePath}`

    try {
      process.stdout.write(`📥 ${item.title.slice(0, 40)}... `)
      const buf = await downloadWithTimeout(item.pdf_url)
      process.stdout.write(`${(buf.length/1024).toFixed(0)}KB `)

      // Upload
      const upRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
        body: buf,
      })
      if (!upRes.ok) throw new Error(`Upload ${upRes.status}`)

      // Update DB
      await fetch(`${SUPABASE_URL}/rest/v1/library_items?id=eq.${item.id}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'apikey': SERVICE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdf_url: publicUrl, file_key: storagePath, file_size_bytes: buf.length }),
      })
      console.log('✅')
      success++
    } catch (err) {
      console.log(`❌ ${err.message}`)
      failed++
    }
    await new Promise(r => setTimeout(r, 2000))
  }

  console.log(`\n📊 ${success} success, ${failed} failed`)
}

main().catch(console.error)
