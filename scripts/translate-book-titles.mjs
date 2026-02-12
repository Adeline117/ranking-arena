#!/usr/bin/env node
/**
 * Translate missing book titles using Google Translate (free)
 * - EN books missing title_zh → translate title to zh
 * - ZH books missing title_en → translate title to en
 * 
 * Usage: node scripts/translate-book-titles.mjs [--dry-run] [--limit 100]
 */

import pg from 'pg'
const { Pool } = pg

const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'

const pool = new Pool({ connectionString: DB_URL })

const dryRun = process.argv.includes('--dry-run')
const limitArg = process.argv.indexOf('--limit')
const batchLimit = limitArg !== -1 ? parseInt(process.argv[limitArg + 1]) : 500

async function translateGoogle(text, sourceLang, targetLang) {
  // Google Translate free endpoint
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Google Translate HTTP ${res.status}`)
  const data = await res.json()
  // data[0] is array of translation segments
  return data[0].map(seg => seg[0]).join('')
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function main() {
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}, Batch limit: ${batchLimit}`)

  // 1. EN books missing title_zh
  const { rows: enBooks } = await pool.query(`
    SELECT id, title FROM library_items 
    WHERE language = 'en' AND (title_zh IS NULL OR title_zh = '')
    ORDER BY view_count DESC NULLS LAST
    LIMIT $1
  `, [batchLimit])
  console.log(`EN→ZH: ${enBooks.length} books to translate`)

  let enSuccess = 0, enFail = 0
  for (const book of enBooks) {
    try {
      const translated = await translateGoogle(book.title, 'en', 'zh-CN')
      if (dryRun) {
        console.log(`  [DRY] "${book.title}" → "${translated}"`)
      } else {
        await pool.query('UPDATE library_items SET title_zh = $1 WHERE id = $2', [translated, book.id])
      }
      enSuccess++
      if (enSuccess % 50 === 0) console.log(`  EN→ZH progress: ${enSuccess}/${enBooks.length}`)
      await sleep(100) // rate limit
    } catch (e) {
      enFail++
      console.error(`  FAIL "${book.title}": ${e.message}`)
      await sleep(1000)
    }
  }
  console.log(`EN→ZH done: ${enSuccess} success, ${enFail} failed`)

  // 2. ZH books missing title_en
  const { rows: zhBooks } = await pool.query(`
    SELECT id, title FROM library_items 
    WHERE language = 'zh' AND (title_en IS NULL OR title_en = '')
    ORDER BY view_count DESC NULLS LAST
    LIMIT $1
  `, [batchLimit])
  console.log(`ZH→EN: ${zhBooks.length} books to translate`)

  let zhSuccess = 0, zhFail = 0
  for (const book of zhBooks) {
    try {
      const translated = await translateGoogle(book.title, 'zh-CN', 'en')
      if (dryRun) {
        console.log(`  [DRY] "${book.title}" → "${translated}"`)
      } else {
        await pool.query('UPDATE library_items SET title_en = $1 WHERE id = $2', [translated, book.id])
      }
      zhSuccess++
      if (zhSuccess % 50 === 0) console.log(`  ZH→EN progress: ${zhSuccess}/${zhBooks.length}`)
      await sleep(100)
    } catch (e) {
      zhFail++
      console.error(`  FAIL "${book.title}": ${e.message}`)
      await sleep(1000)
    }
  }
  console.log(`ZH→EN done: ${zhSuccess} success, ${zhFail} failed`)

  console.log(`\nTotal: ${enSuccess + zhSuccess} translated, ${enFail + zhFail} failed`)
  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })
