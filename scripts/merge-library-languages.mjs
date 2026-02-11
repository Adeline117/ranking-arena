#!/usr/bin/env node
/**
 * merge-library-languages.mjs
 * 
 * Matches multi-language editions of the same book in library_items.
 * Strategy:
 *   1. Standardize language codes (eng→en, chi→zh, etc.)
 *   2. ISBN matching across languages
 *   3. Author + title similarity (pg_trgm) for zh↔en matching
 *   4. Fill title_en / title_zh across groups
 *   5. Assign language_group_id = own id for unmatched items
 */

import pg from 'pg'
const { Client } = pg

const DB_URL = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'

const client = new Client({ connectionString: DB_URL })

async function run() {
  await client.connect()
  console.log('Connected to database')

  // ── Step 1: Standardize language codes ──
  console.log('\n── Step 1: Standardize language codes ──')
  const langMap = {
    eng: 'en',
    chi: 'zh',
    ger: 'de',
    fre: 'fr',
    spa: 'es',
    ita: 'it',
    por: 'pt',
    jpn: 'ja',
    dan: 'da',
    swe: 'sv',
    pol: 'pl',
    cat: 'ca',
    und: 'en', // undetermined → default en
    gem: 'de', // Germanic → de
    ltz: 'lb', // Luxembourgish
  }

  for (const [from, to] of Object.entries(langMap)) {
    const res = await client.query(
      `UPDATE library_items SET language = $1 WHERE language = $2`,
      [to, from]
    )
    if (res.rowCount > 0) {
      console.log(`  ${from} → ${to}: ${res.rowCount} rows`)
    }
  }

  // Also set NULL language to 'en'
  const nullRes = await client.query(
    `UPDATE library_items SET language = 'en' WHERE language IS NULL OR language = ''`
  )
  if (nullRes.rowCount > 0) {
    console.log(`  NULL/empty → en: ${nullRes.rowCount} rows`)
  }

  // ── Step 2: ISBN matching ──
  console.log('\n── Step 2: ISBN matching across languages ──')
  
  // Find ISBN groups that span multiple languages
  const isbnGroups = await client.query(`
    SELECT isbn, array_agg(id ORDER BY language) as ids, array_agg(DISTINCT language) as langs
    FROM library_items
    WHERE isbn IS NOT NULL AND isbn != '' AND language_group_id IS NULL
    GROUP BY isbn
    HAVING count(DISTINCT language) > 1
  `)
  
  let isbnMatchCount = 0
  for (const row of isbnGroups.rows) {
    const groupId = row.ids[0] // use first id as group id
    await client.query(
      `UPDATE library_items SET language_group_id = $1 WHERE id = ANY($2)`,
      [groupId, row.ids]
    )
    isbnMatchCount += row.ids.length
  }
  console.log(`  ISBN cross-language matches: ${isbnGroups.rows.length} groups, ${isbnMatchCount} items`)

  // Also group same-ISBN same-language duplicates
  const isbnSameLang = await client.query(`
    SELECT isbn, array_agg(id ORDER BY created_at) as ids
    FROM library_items
    WHERE isbn IS NOT NULL AND isbn != '' AND language_group_id IS NULL
    GROUP BY isbn
    HAVING count(*) > 1
  `)
  
  let isbnSameCount = 0
  for (const row of isbnSameLang.rows) {
    const groupId = row.ids[0]
    await client.query(
      `UPDATE library_items SET language_group_id = $1 WHERE id = ANY($2)`,
      [groupId, row.ids]
    )
    isbnSameCount += row.ids.length
  }
  console.log(`  ISBN same-language groups: ${isbnSameLang.rows.length} groups, ${isbnSameCount} items`)

  // ── Step 3: Author + title similarity matching (zh ↔ en) ──
  console.log('\n── Step 3: Author + title similarity matching ──')
  
  // Use a single batch query to find all zh↔en matches by author+title similarity
  // Set similarity threshold low since Chinese romanized titles can differ
  await client.query(`SET pg_trgm.similarity_threshold = 0.3`)
  
  const similarityResult = await client.query(`
    WITH zh_books AS (
      SELECT id, title, author
      FROM library_items
      WHERE language = 'zh' AND language_group_id IS NULL
        AND author IS NOT NULL AND author != ''
    ),
    matches AS (
      SELECT DISTINCT ON (zh.id)
        zh.id as zh_id, zh.title as zh_title,
        en.id as en_id, en.title as en_title,
        similarity(zh.title, en.title) as title_sim
      FROM zh_books zh
      JOIN library_items en ON
        en.language = 'en'
        AND en.language_group_id IS NULL
        AND en.author IS NOT NULL
        AND similarity(lower(zh.author), lower(en.author)) > 0.4
        AND similarity(zh.title, en.title) > 0.3
      ORDER BY zh.id, similarity(zh.title, en.title) DESC
    )
    SELECT * FROM matches
  `)
  
  let similarityMatches = 0
  for (const m of similarityResult.rows) {
    await client.query(
      `UPDATE library_items SET language_group_id = $1 WHERE id = ANY($2::uuid[])`,
      [m.en_id, [m.zh_id, m.en_id]]
    )
    similarityMatches++
    console.log(`  Matched: "${m.zh_title}" ↔ "${m.en_title}" (sim=${m.title_sim.toFixed(2)})`)
  }
  console.log(`  Similarity matches: ${similarityMatches}`)

  // ── Step 4: Fill title_en / title_zh across groups ──
  console.log('\n── Step 4: Fill title_en / title_zh ──')
  
  // For groups with both zh and en, cross-fill titles
  const crossFill = await client.query(`
    WITH groups_with_both AS (
      SELECT language_group_id
      FROM library_items
      WHERE language_group_id IS NOT NULL
      GROUP BY language_group_id
      HAVING array_agg(DISTINCT language) @> ARRAY['en', 'zh']
    ),
    en_titles AS (
      SELECT DISTINCT ON (language_group_id) language_group_id, title as en_title
      FROM library_items
      WHERE language = 'en' AND language_group_id IN (SELECT language_group_id FROM groups_with_both)
      ORDER BY language_group_id, created_at
    ),
    zh_titles AS (
      SELECT DISTINCT ON (language_group_id) language_group_id, title as zh_title
      FROM library_items
      WHERE language = 'zh' AND language_group_id IN (SELECT language_group_id FROM groups_with_both)
      ORDER BY language_group_id, created_at
    )
    UPDATE library_items li SET
      title_en = COALESCE(li.title_en, et.en_title),
      title_zh = COALESCE(li.title_zh, zt.zh_title)
    FROM en_titles et
    JOIN zh_titles zt ON et.language_group_id = zt.language_group_id
    WHERE li.language_group_id = et.language_group_id
  `)
  console.log(`  Cross-filled titles: ${crossFill.rowCount} items`)

  // For en books without title_en, set title_en = title
  const fillEn = await client.query(`
    UPDATE library_items SET title_en = title
    WHERE language = 'en' AND (title_en IS NULL OR title_en = '')
  `)
  console.log(`  Set title_en = title for en books: ${fillEn.rowCount}`)

  // For zh books without title_zh, set title_zh = title
  const fillZh = await client.query(`
    UPDATE library_items SET title_zh = title
    WHERE language = 'zh' AND (title_zh IS NULL OR title_zh = '')
  `)
  console.log(`  Set title_zh = title for zh books: ${fillZh.rowCount}`)

  // ── Step 5: Assign language_group_id = id for unmatched ──
  console.log('\n── Step 5: Assign self-group for unmatched items ──')
  const selfGroup = await client.query(`
    UPDATE library_items SET language_group_id = id
    WHERE language_group_id IS NULL
  `)
  console.log(`  Self-grouped: ${selfGroup.rowCount} items`)

  // ── Summary ──
  console.log('\n── Summary ──')
  const stats = await client.query(`
    SELECT
      count(DISTINCT language_group_id) as total_groups,
      count(*) as total_items,
      count(DISTINCT language_group_id) FILTER (WHERE language_group_id != id) as multi_item_groups,
      count(*) FILTER (WHERE title_en IS NOT NULL AND title_en != '') as has_title_en,
      count(*) FILTER (WHERE title_zh IS NOT NULL AND title_zh != '') as has_title_zh
    FROM library_items
  `)
  const s = stats.rows[0]
  console.log(`  Total groups: ${s.total_groups}`)
  console.log(`  Total items: ${s.total_items}`)
  console.log(`  Multi-item groups: ${s.multi_item_groups}`)
  console.log(`  Items with title_en: ${s.has_title_en}`)
  console.log(`  Items with title_zh: ${s.has_title_zh}`)

  const langDist = await client.query(`
    SELECT language, count(*) FROM library_items GROUP BY language ORDER BY count(*) DESC
  `)
  console.log('\n  Language distribution:')
  for (const r of langDist.rows) {
    console.log(`    ${r.language}: ${r.count}`)
  }

  await client.end()
  console.log('\nDone!')
}

run().catch(e => { console.error(e); process.exit(1) })
