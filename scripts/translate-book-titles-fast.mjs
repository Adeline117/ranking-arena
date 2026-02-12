#!/usr/bin/env node
/**
 * Fast batch translation using Google Translate
 */
import pg from 'pg'
const { Pool } = pg

const DB_URL = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'
const pool = new Pool({ connectionString: DB_URL })

const BATCH = parseInt(process.argv[2] || '1000')
const CONCURRENCY = 5

async function translate(text, sl, tl) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return data[0].map(s => s[0]).join('')
}

async function processChunk(rows, sl, tl, field) {
  let ok = 0, fail = 0
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const chunk = rows.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      chunk.map(async row => {
        const t = await translate(row.title, sl, tl)
        await pool.query(`UPDATE library_items SET ${field} = $1 WHERE id = $2`, [t, row.id])
        return t
      })
    )
    for (const r of results) r.status === 'fulfilled' ? ok++ : fail++
    if ((i + CONCURRENCY) % 100 < CONCURRENCY) process.stdout.write(`  ${ok + fail}/${rows.length}\n`)
    await new Promise(r => setTimeout(r, 50))
  }
  return { ok, fail }
}

async function main() {
  // EN → ZH
  const { rows: en } = await pool.query(
    `SELECT id, title FROM library_items WHERE language = 'en' AND (title_zh IS NULL OR title_zh = '') ORDER BY view_count DESC NULLS LAST LIMIT $1`,
    [BATCH]
  )
  console.log(`EN→ZH: ${en.length} books`)
  const r1 = await processChunk(en, 'en', 'zh-CN', 'title_zh')
  console.log(`EN→ZH: ${r1.ok} ok, ${r1.fail} fail`)

  // ZH → EN
  const { rows: zh } = await pool.query(
    `SELECT id, title FROM library_items WHERE language = 'zh' AND (title_en IS NULL OR title_en = '') ORDER BY view_count DESC NULLS LAST LIMIT $1`,
    [BATCH]
  )
  console.log(`ZH→EN: ${zh.length} books`)
  const r2 = await processChunk(zh, 'zh-CN', 'en', 'title_en')
  console.log(`ZH→EN: ${r2.ok} ok, ${r2.fail} fail`)

  console.log('Done!')
  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })
