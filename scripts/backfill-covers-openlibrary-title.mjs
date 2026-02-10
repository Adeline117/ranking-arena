#!/usr/bin/env node
/**
 * Open Library 标题搜索封面补全
 * 按标题搜索没有封面的书籍
 */
import pg from 'pg'
const { Pool } = pg

const pool = new Pool({
  connectionString: 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'
})

const DELAY_MS = 1000
const BATCH = 2000 // Open Library比Google宽松

let stats = { checked: 0, found: 0, noResult: 0, error: 0 }

async function searchCover(title) {
  const url = `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&limit=1&fields=cover_i`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (res.status === 429) return 'RATE_LIMIT'
    if (!res.ok) return null
    const data = await res.json()
    if (data.docs?.[0]?.cover_i) {
      return `https://covers.openlibrary.org/b/id/${data.docs[0].cover_i}-L.jpg`
    }
    return null
  } catch { return null }
}

async function main() {
  console.log('=== Open Library 标题搜索封面补全 ===')
  
  const { rows } = await pool.query(`
    SELECT id, title FROM library_items 
    WHERE cover_url IS NULL AND title IS NOT NULL AND length(title) > 5
    ORDER BY RANDOM()
    LIMIT $1
  `, [BATCH])
  
  console.log(`待处理: ${rows.length}`)
  
  const updates = []
  
  for (const row of rows) {
    const coverUrl = await searchCover(row.title)
    stats.checked++
    
    if (coverUrl === 'RATE_LIMIT') {
      console.log('被限速，等5秒...')
      await new Promise(r => setTimeout(r, 5000))
      continue
    }
    
    if (coverUrl) {
      updates.push({ id: row.id, cover_url: coverUrl })
      stats.found++
    } else {
      stats.noResult++
    }
    
    if (updates.length >= 50) {
      for (const u of updates) {
        await pool.query('UPDATE library_items SET cover_url = $1 WHERE id = $2', [u.cover_url, u.id])
      }
      console.log(`[DB] 写入 ${updates.length} 条 | 进度: ${stats.checked}/${rows.length} | 成功率: ${(stats.found/stats.checked*100).toFixed(1)}%`)
      updates.length = 0
    }
    
    if (stats.checked % 200 === 0) {
      console.log(`--- ${stats.checked}/${rows.length} | 找到: ${stats.found} | 成功率: ${(stats.found/stats.checked*100).toFixed(1)}% ---`)
    }
    
    await new Promise(r => setTimeout(r, DELAY_MS))
  }
  
  // 剩余
  for (const u of updates) {
    await pool.query('UPDATE library_items SET cover_url = $1 WHERE id = $2', [u.cover_url, u.id])
  }
  
  console.log('\n=== 完成 ===')
  console.log(`检查: ${stats.checked}, 找到: ${stats.found}, 成功率: ${(stats.found/stats.checked*100).toFixed(1)}%`)
  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })
