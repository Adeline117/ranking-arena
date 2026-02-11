#!/usr/bin/env node
/**
 * merge-library-languages.mjs
 * 
 * Matches multi-language editions of the same book in library_items.
 */

import pg from 'pg'
const { Client } = pg

const DB_URL = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:5432/postgres'

const client = new Client({ connectionString: DB_URL, statement_timeout: 600000 })

async function batchUpdate(table, setClause, whereClause, batchSize = 5000) {
  let total = 0
  while (true) {
    const r = await client.query(`
      UPDATE ${table} SET ${setClause}
      WHERE id IN (SELECT id FROM ${table} WHERE ${whereClause} LIMIT ${batchSize})
    `)
    if (r.rowCount === 0) break
    total += r.rowCount
    console.log(`    ... ${total} rows so far`)
  }
  return total
}

async function run() {
  await client.connect()
  console.log('Connected to database')

  // ── Step 1: Standardize language codes ──
  console.log('\n── Step 1: Standardize language codes ──')
  const langMap = { eng:'en', chi:'zh', ger:'de', fre:'fr', spa:'es', ita:'it', por:'pt', jpn:'ja', dan:'da', swe:'sv', pol:'pl', cat:'ca', und:'en', gem:'de', ltz:'lb' }
  for (const [from, to] of Object.entries(langMap)) {
    const r = await client.query(`UPDATE library_items SET language = $1 WHERE language = $2`, [to, from])
    if (r.rowCount > 0) console.log(`  ${from} → ${to}: ${r.rowCount}`)
  }
  const r0 = await client.query(`UPDATE library_items SET language = 'en' WHERE language IS NULL OR language = ''`)
  if (r0.rowCount > 0) console.log(`  NULL → en: ${r0.rowCount}`)

  // ── Step 2: ISBN matching ──
  console.log('\n── Step 2: ISBN matching ──')
  const r2 = await client.query(`
    WITH isbn_groups AS (
      SELECT isbn, (array_agg(id ORDER BY created_at))[1] as group_id
      FROM library_items
      WHERE isbn IS NOT NULL AND isbn != '' AND language_group_id IS NULL
      GROUP BY isbn HAVING count(*) > 1
    )
    UPDATE library_items li SET language_group_id = ig.group_id
    FROM isbn_groups ig WHERE li.isbn = ig.isbn AND li.language_group_id IS NULL
  `)
  console.log(`  ISBN groups: ${r2.rowCount} items`)

  // ── Step 3: Author-based matching (zh ↔ en) ──
  console.log('\n── Step 3: Author matching ──')
  
  // Strategy A: zh book's author has exactly 1 unmatched en book → auto-match
  const r3a = await client.query(`
    WITH zh_with_en_author AS (
      SELECT zh.id as zh_id, zh.title as zh_title, zh.author,
             (array_agg(en.id))[1] as en_id,
             (array_agg(en.title))[1] as en_title,
             count(en.id) as en_count
      FROM library_items zh
      JOIN library_items en ON lower(trim(zh.author)) = lower(trim(en.author))
        AND en.language = 'en' AND en.language_group_id IS NULL
      WHERE zh.language = 'zh' AND zh.language_group_id IS NULL
        AND zh.author ~ '[a-zA-Z]' AND length(zh.author) > 3
      GROUP BY zh.id, zh.title, zh.author
      HAVING count(en.id) = 1
    )
    SELECT * FROM zh_with_en_author
  `)
  
  let authorMatches = 0
  for (const m of r3a.rows) {
    await client.query(
      `UPDATE library_items SET language_group_id = $1 WHERE id IN ($2, $3) AND language_group_id IS NULL`,
      [m.en_id, m.zh_id, m.en_id]
    )
    authorMatches++
    console.log(`  ✓ "${m.zh_title}" ↔ "${m.en_title}" (author: ${m.author})`)
  }

  // Strategy B: zh book has exact English title match with an en book by same author
  const r3b = await client.query(`
    SELECT zh.id as zh_id, zh.title as zh_title, en.id as en_id, en.title as en_title, zh.author
    FROM library_items zh
    JOIN library_items en ON lower(trim(zh.author)) = lower(trim(en.author))
      AND lower(trim(zh.title)) = lower(trim(en.title))
      AND en.language = 'en' AND en.language_group_id IS NULL
    WHERE zh.language = 'zh' AND zh.language_group_id IS NULL
      AND zh.author IS NOT NULL
  `)
  
  for (const m of r3b.rows) {
    await client.query(
      `UPDATE library_items SET language_group_id = $1 WHERE id IN ($2, $3) AND language_group_id IS NULL`,
      [m.en_id, m.zh_id, m.en_id]
    )
    authorMatches++
    console.log(`  ✓ exact: "${m.zh_title}" ↔ "${m.en_title}"`)
  }

  // Strategy C: For remaining zh books with English authors and multiple en matches,
  // use pg_trgm on title but ONLY within the same author's books (small set)
  const r3c = await client.query(`
    WITH zh_multi AS (
      SELECT zh.id as zh_id, zh.title as zh_title, zh.author
      FROM library_items zh
      WHERE zh.language = 'zh' AND zh.language_group_id IS NULL
        AND zh.author ~ '[a-zA-Z]' AND length(zh.author) > 3
    ),
    best_match AS (
      SELECT DISTINCT ON (zh.zh_id)
        zh.zh_id, zh.zh_title, zh.author,
        en.id as en_id, en.title as en_title,
        similarity(zh.zh_title, en.title) as sim
      FROM zh_multi zh
      JOIN library_items en ON lower(trim(zh.author)) = lower(trim(en.author))
        AND en.language = 'en' AND en.language_group_id IS NULL
      WHERE similarity(zh.zh_title, en.title) > 0.15
      ORDER BY zh.zh_id, similarity(zh.zh_title, en.title) DESC
    )
    SELECT * FROM best_match WHERE sim > 0.15
  `)

  for (const m of r3c.rows) {
    await client.query(
      `UPDATE library_items SET language_group_id = $1 WHERE id IN ($2, $3) AND language_group_id IS NULL`,
      [m.en_id, m.zh_id, m.en_id]
    )
    authorMatches++
    console.log(`  ✓ sim: "${m.zh_title}" ↔ "${m.en_title}" (${parseFloat(m.sim).toFixed(2)})`)
  }
  console.log(`  Total author matches: ${authorMatches}`)

  // ── Step 4: Fill title_en / title_zh ──
  console.log('\n── Step 4: Fill title_en / title_zh ──')
  
  const r4a = await client.query(`
    WITH en_t AS (
      SELECT DISTINCT ON (language_group_id) language_group_id, title as t
      FROM library_items WHERE language = 'en' AND language_group_id IS NOT NULL
      ORDER BY language_group_id, created_at
    ),
    zh_t AS (
      SELECT DISTINCT ON (language_group_id) language_group_id, title as t
      FROM library_items WHERE language = 'zh' AND language_group_id IS NOT NULL
      ORDER BY language_group_id, created_at
    )
    UPDATE library_items li SET
      title_en = COALESCE(NULLIF(li.title_en, ''), et.t),
      title_zh = COALESCE(NULLIF(li.title_zh, ''), zt.t)
    FROM en_t et JOIN zh_t zt USING (language_group_id)
    WHERE li.language_group_id = et.language_group_id
  `)
  console.log(`  Cross-filled: ${r4a.rowCount} items`)

  const n4b = await batchUpdate('library_items', 'title_en = title', "language = 'en' AND (title_en IS NULL OR title_en = '')")
  console.log(`  title_en = title (en): ${n4b}`)
  const n4c = await batchUpdate('library_items', 'title_zh = title', "language = 'zh' AND (title_zh IS NULL OR title_zh = '')")
  console.log(`  title_zh = title (zh): ${n4c}`)

  // ── Step 5: Self-group unmatched ──
  console.log('\n── Step 5: Self-group unmatched ──')
  const n5 = await batchUpdate('library_items', 'language_group_id = id', 'language_group_id IS NULL')
  console.log(`  Self-grouped: ${n5} items`)

  // ── Summary ──
  console.log('\n── Summary ──')
  const stats = await client.query(`
    SELECT
      count(DISTINCT language_group_id) as groups,
      count(*) as items,
      count(*) FILTER (WHERE language_group_id != id) as in_multi_groups,
      count(*) FILTER (WHERE title_en IS NOT NULL AND title_en != '') as has_en,
      count(*) FILTER (WHERE title_zh IS NOT NULL AND title_zh != '') as has_zh
    FROM library_items
  `)
  const s = stats.rows[0]
  console.log(`  Groups: ${s.groups} | Items: ${s.items}`)
  console.log(`  In multi-item groups: ${s.in_multi_groups}`)
  console.log(`  Has title_en: ${s.has_en} | Has title_zh: ${s.has_zh}`)

  await client.end()
  console.log('\nDone!')
}

run().catch(e => { console.error(e); process.exit(1) })
