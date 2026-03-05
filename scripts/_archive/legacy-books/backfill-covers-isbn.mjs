#!/usr/bin/env node
/**
 * ISBN-based cover search - tries multiple sources
 * 1. Open Library covers API (direct ISBN)
 * 2. Google Books API
 */
import pg from 'pg'
const { Pool } = pg

const pool = new Pool({
  connectionString: 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'
})

const BATCH = 3000

async function findCover(isbn) {
  // Open Library direct
  const olUrl = `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`
  try {
    const r = await fetch(olUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000), redirect: 'follow' })
    if (r.ok && r.headers.get('content-type')?.includes('image')) return olUrl.replace('?default=false', '')
  } catch {}

  // Google Books
  try {
    const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&fields=items/volumeInfo/imageLinks`, { signal: AbortSignal.timeout(8000) })
    if (r.ok) {
      const d = await r.json()
      const link = d.items?.[0]?.volumeInfo?.imageLinks?.thumbnail
      if (link) return link.replace('http://', 'https://').replace('&edge=curl', '')
    }
  } catch {}

  return null
}

async function main() {
  console.log('=== ISBN封面补全 ===')
  
  const { rows } = await pool.query(`
    SELECT id, isbn FROM library_items 
    WHERE cover_url IS NULL AND isbn IS NOT NULL AND length(isbn) >= 10
    ORDER BY RANDOM() LIMIT $1
  `, [BATCH])
  
  console.log('待处理:', rows.length)
  let found = 0, checked = 0
  
  for (const row of rows) {
    const isbn = row.isbn.replace(/[-\s]/g, '')
    const cover = await findCover(isbn)
    checked++
    
    if (cover) {
      await pool.query('UPDATE library_items SET cover_url = $1 WHERE id = $2', [cover, row.id])
      found++
    }
    
    if (checked % 100 === 0) {
      console.log(`${checked}/${rows.length} | 找到: ${found} | ${(found/checked*100).toFixed(1)}%`)
    }
    
    await new Promise(r => setTimeout(r, 500))
  }
  
  console.log(`\n完成: ${checked}检查, ${found}找到, ${(found/checked*100).toFixed(1)}%`)
  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })
