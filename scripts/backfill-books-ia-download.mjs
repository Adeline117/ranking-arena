#!/usr/bin/env node
/**
 * Phase 1: Match IA crypto books to our DB, download content to R2.
 * Reads /tmp/ia-crypto-books.json (pre-fetched IA catalog).
 */
import 'dotenv/config'
import { readFileSync } from 'fs'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
})
const R2_BUCKET = process.env.R2_BUCKET || 'arena-cdn'
const R2_PUBLIC = process.env.R2_PUBLIC_URL || 'https://cdn.arenafi.org'
const sleep = ms => new Promise(r => setTimeout(r, ms))

function normalize(s) {
  return (s || '').toLowerCase()
    .replace(/[''"""\u2018\u2019\u201C\u201D]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff ]/g, '')
    .replace(/\s+/g, ' ').trim()
}

function wordsMatch(a, b) {
  const na = normalize(a), nb = normalize(b)
  if (!na || !nb) return 0
  if (na === nb) return 1.0
  if (na.includes(nb) || nb.includes(na)) return 0.9
  const wa = na.split(' '), wb = nb.split(' ')
  const common = wa.filter(w => w.length > 2 && wb.includes(w)).length
  return common / Math.max(wa.length, wb.length)
}

async function downloadFile(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(60000),
      redirect: 'follow',
    })
    if (!r.ok) return null
    const ct = r.headers.get('content-type') || ''
    if (ct.includes('text/html')) return null
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length < 5000 || buf.length > 50 * 1024 * 1024) return null
    return { buffer: buf, size: buf.length }
  } catch { return null }
}

async function main() {
  // Load IA catalog
  const iaBooks = JSON.parse(readFileSync('/tmp/ia-crypto-books.json', 'utf-8'))
  console.log(`📚 IA catalog: ${iaBooks.length} items`)

  // Load our books without content
  const { data: dbBooks, error } = await sb
    .from('library_items')
    .select('id, title, author')
    .eq('category', 'book')
    .is('file_key', null)
    .is('pdf_url', null)
    .is('epub_url', null)

  if (error) { console.error('DB error:', error); process.exit(1) }
  console.log(`DB books without content: ${dbBooks.length}`)

  // Match
  const matches = []
  for (const ia of iaBooks) {
    let bestScore = 0, bestBook = null
    for (const db of dbBooks) {
      const score = wordsMatch(db.title, ia.title)
      if (score > bestScore && score >= 0.6) {
        bestScore = score
        bestBook = db
      }
    }
    if (bestBook) {
      matches.push({ ia, db: bestBook, score: bestScore })
    }
  }

  // Deduplicate (one DB book per match, best score)
  const byDbId = new Map()
  for (const m of matches) {
    const existing = byDbId.get(m.db.id)
    if (!existing || m.score > existing.score) {
      byDbId.set(m.db.id, m)
    }
  }
  const uniqueMatches = [...byDbId.values()].sort((a, b) => b.score - a.score)
  console.log(`Matches found: ${uniqueMatches.length}`)

  let downloaded = 0, failed = 0
  for (const { ia, db, score } of uniqueMatches) {
    // Get files for this IA item
    try {
      const r = await fetch(`https://archive.org/metadata/${ia.identifier}/files`, {
        signal: AbortSignal.timeout(10000),
        headers: { 'User-Agent': 'RankingArenaBot/1.0' },
      })
      if (!r.ok) { failed++; continue }
      const d = await r.json()
      const files = (d.result || [])
        .filter(f => f.name && (f.name.endsWith('.pdf') || f.name.endsWith('.epub')))
        .filter(f => parseInt(f.size || 0) > 5000 && parseInt(f.size || 0) < 50 * 1024 * 1024)
        .sort((a, b) => {
          const ae = a.name.endsWith('.epub') ? 0 : 1
          const be = b.name.endsWith('.epub') ? 0 : 1
          return ae !== be ? ae - be : parseInt(a.size) - parseInt(b.size)
        })

      if (!files.length) { continue }

      // Download
      const f = files[0]
      const ext = f.name.endsWith('.epub') ? 'epub' : 'pdf'
      const url = `https://archive.org/download/${ia.identifier}/${encodeURIComponent(f.name)}`
      const file = await downloadFile(url)
      if (!file) { failed++; await sleep(2000); continue }

      // Upload to R2
      const key = `library/${db.id}/content.${ext}`
      const ct = ext === 'epub' ? 'application/epub+zip' : 'application/pdf'
      await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: file.buffer, ContentType: ct }))
      const cdnUrl = `${R2_PUBLIC}/${key}`

      // Update DB
      const updates = { file_key: key, file_size_bytes: file.size }
      if (ext === 'epub') updates.epub_url = cdnUrl
      else updates.pdf_url = cdnUrl
      await sb.from('library_items').update(updates).eq('id', db.id)

      downloaded++
      console.log(`✅ [${downloaded}] "${db.title.slice(0,45)}" ← ${ia.identifier} (${ext}, ${(file.size/1024/1024).toFixed(1)}MB, score:${score.toFixed(2)})`)
    } catch (e) {
      failed++
    }

    await sleep(1500) // Be polite to IA
  }

  console.log(`\n🏁 Done: ${downloaded} downloaded, ${failed} failed, ${uniqueMatches.length} total matches`)
}

main().catch(console.error)
