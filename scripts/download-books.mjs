#!/usr/bin/env node
/**
 * Download crypto/blockchain books from Internet Archive and upload to Supabase Storage.
 * Strategy: Search IA for community uploads (z-lib, etc.) that have unrestricted PDFs.
 * Skip lending library items (403/401).
 */
import fs from 'fs'
import { execSync } from 'child_process'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
const PSQL = '/opt/homebrew/opt/libpq/bin/psql'
const DB_URL = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'
const BUCKET = 'library'
const TMP_DIR = '/tmp/books'
const MAX_SIZE = 50 * 1024 * 1024

fs.mkdirSync(TMP_DIR, { recursive: true })

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function queryDB(sql) {
  const out = execSync(`${PSQL} "${DB_URL}" -t -A -F'|' -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' })
  return out.trim().split('\n').filter(Boolean).map(line => line.split('|'))
}

// Normalize title for comparison
function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim()
}

function titleMatch(searchTitle, foundTitle) {
  const a = normalize(searchTitle)
  const b = normalize(foundTitle)
  // Check if significant words from search title appear in found title
  const words = a.split(' ').filter(w => w.length > 3)
  const matched = words.filter(w => b.includes(w))
  return matched.length >= Math.min(words.length, 3) && matched.length >= words.length * 0.5
}

async function searchIA(title, author) {
  const cleanTitle = title.replace(/[:'*]/g, ' ').replace(/\s+/g, ' ').trim()
  const authorFirst = (author || '').split(',')[0].trim()
  
  // Search only community/opensource collections (not lending library)
  const excludeCollections = '-collection:printdisabled -collection:internetarchivebooks -collection:inlibrary'
  const queries = [
    `${cleanTitle} ${authorFirst} format:PDF ${excludeCollections}`,
    `${cleanTitle} format:PDF ${excludeCollections}`,
    `title:"${cleanTitle.split(' ').slice(0, 4).join(' ')}" format:PDF ${excludeCollections}`,
  ]
  
  const allDocs = []
  for (const q of queries) {
    try {
      const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=creator&rows=10&output=json`
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
      if (!res.ok) continue
      const data = await res.json()
      const docs = data?.response?.docs || []
      // Filter by title match
      for (const d of docs) {
        if (titleMatch(title, d.title || '') && !allDocs.find(x => x.identifier === d.identifier)) {
          allDocs.push(d)
        }
      }
      if (allDocs.length >= 5) break
    } catch (e) { /* continue */ }
    await sleep(1000)
  }
  return allDocs
}

async function findDownloadablePdf(identifier) {
  try {
    const res = await fetch(`https://archive.org/metadata/${identifier}`, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) return null
    const data = await res.json()
    
    // Check if item is restricted (lending library)
    const access = data?.metadata?.access_restricted_item
    if (access === 'true') return null
    
    const files = data?.files || []
    const pdfs = files
      .filter(f => f.name?.endsWith('.pdf') && !f.name?.includes('_abbyy') && !f.name?.includes('_text.pdf'))
      .map(f => ({ ...f, sizeNum: parseInt(f.size || '0') }))
      .filter(f => f.sizeNum > 100000 && f.sizeNum <= MAX_SIZE)
      .sort((a, b) => b.sizeNum - a.sizeNum) // Largest first (likely full book)
    
    if (pdfs.length === 0) return null
    const best = pdfs[0]
    return {
      name: best.name,
      size: best.sizeNum,
      url: `https://archive.org/download/${identifier}/${encodeURIComponent(best.name)}`,
    }
  } catch (e) { return null }
}

async function downloadPdf(url, destPath) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_SIZE) throw new Error(`Too large: ${buf.length}`)
  if (buf.length < 10000) throw new Error(`Too small: ${buf.length}`)
  if (buf.slice(0, 4).toString() !== '%PDF') throw new Error('Not a PDF')
  fs.writeFileSync(destPath, buf)
  return buf.length
}

async function upload(filePath, storageKey) {
  const fileData = fs.readFileSync(filePath)
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storageKey}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/pdf',
      'x-upsert': 'true',
    },
    body: fileData,
  })
  if (!res.ok) throw new Error(`Upload: ${res.status} ${await res.text()}`)
  return fileData.length
}

async function processBook(id, title, author) {
  console.log(`\n📖 ${title}`)
  
  const results = await searchIA(title, author)
  if (!results.length) { console.log('  ❌ No matching results'); return false }
  
  for (const doc of results.slice(0, 5)) {
    const pdf = await findDownloadablePdf(doc.identifier)
    if (!pdf) { console.log(`  ⏭️  ${doc.identifier} (restricted/no PDF)`); continue }
    
    console.log(`  📥 ${doc.identifier} → ${pdf.name} (${(pdf.size/1024/1024).toFixed(1)}MB)`)
    const tmpPath = `${TMP_DIR}/${id}.pdf`
    try {
      const size = await downloadPdf(pdf.url, tmpPath)
      
      // Upload
      const storageKey = `books/${id}.pdf`
      await upload(tmpPath, storageKey)
      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storageKey}`
      
      // Update DB
      const sql = `UPDATE library_items SET file_key='${storageKey}', file_size_bytes=${size}, pdf_url='${publicUrl}' WHERE id='${id}'`
      execSync(`${PSQL} "${DB_URL}" -c "${sql}"`, { encoding: 'utf8' })
      
      console.log(`  ✅ Done (${(size/1024/1024).toFixed(1)}MB)`)
      fs.unlinkSync(tmpPath)
      return true
    } catch (e) {
      console.log(`  ❌ ${e.message}`)
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
    }
    await sleep(2000)
  }
  return false
}

async function main() {
  const rows = queryDB(`SELECT id, title, author FROM library_items WHERE category IN ('book','finance') AND file_key IS NULL AND tags && ARRAY['crypto','blockchain','bitcoin','ethereum','defi','trading'] LIMIT 50`)
  
  console.log(`Found ${rows.length} books to process`)
  let success = 0, failed = 0
  
  for (const [id, title, author] of rows) {
    if (!id || !title) continue
    const ok = await processBook(id, title, author)
    if (ok) success++; else failed++
    await sleep(3000)
  }
  
  console.log(`\n\n=== SUMMARY ===`)
  console.log(`✅ ${success} downloaded`)
  console.log(`❌ ${failed} failed`)
  console.log(`Total: ${rows.length}`)
}

main().catch(e => { console.error(e); process.exit(1) })
