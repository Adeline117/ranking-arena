#!/usr/bin/env node
/**
 * Google Books API 批量封面补全
 * 按标题搜索没有封面的书籍，获取封面URL
 * 限制：Google Books API免费额度 1000次/天
 */

import pg from 'pg'
const { Pool } = pg

const pool = new Pool({
  connectionString: 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'
})

const BATCH_SIZE = 40 // Google API限制
const DELAY_MS = 1200 // 1.2秒间隔，避免被限制
const MAX_REQUESTS = 950 // 留点余量，不超过1000/天

let stats = { checked: 0, found: 0, failed: 0, skipped: 0 }

async function searchGoogleBooks(title, author) {
  const query = author ? `intitle:${title}+inauthor:${author}` : `intitle:${title}`
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=1&fields=items(volumeInfo/imageLinks)`
  
  try {
    const res = await fetch(url)
    if (res.status === 429) {
      console.log('[RATE LIMITED] Stopping...')
      return null
    }
    if (!res.ok) return undefined
    
    const data = await res.json()
    if (data.items?.[0]?.volumeInfo?.imageLinks) {
      const links = data.items[0].volumeInfo.imageLinks
      // 优先大图
      return links.thumbnail?.replace('zoom=1', 'zoom=2') || links.smallThumbnail || null
    }
    return undefined
  } catch (e) {
    return undefined
  }
}

async function main() {
  console.log('=== Google Books 封面补全 ===')
  console.log(`开始时间: ${new Date().toLocaleString()}`)
  
  // 获取没有封面的书（优先有作者的，更容易匹配）
  const { rows } = await pool.query(`
    SELECT id, title, author 
    FROM library_items 
    WHERE cover_url IS NULL 
      AND title IS NOT NULL 
      AND length(title) > 3
    ORDER BY 
      CASE WHEN author IS NOT NULL THEN 0 ELSE 1 END,
      CASE WHEN isbn IS NOT NULL THEN 0 ELSE 1 END
    LIMIT $1
  `, [MAX_REQUESTS])
  
  console.log(`待处理: ${rows.length} 本`)
  
  const updates = []
  
  for (const row of rows) {
    if (stats.checked >= MAX_REQUESTS) break
    
    const coverUrl = await searchGoogleBooks(row.title, row.author)
    stats.checked++
    
    if (coverUrl === null) {
      // Rate limited
      console.log(`[${stats.checked}] RATE LIMITED, stopping`)
      break
    }
    
    if (coverUrl) {
      updates.push({ id: row.id, cover_url: coverUrl })
      stats.found++
      console.log(`[${stats.checked}] FOUND: ${row.title.substring(0, 50)}`)
    } else {
      stats.skipped++
    }
    
    // 每50个批量写入
    if (updates.length >= 50) {
      await flushUpdates(updates)
      updates.length = 0
    }
    
    // 进度报告
    if (stats.checked % 100 === 0) {
      console.log(`--- 进度: ${stats.checked}/${rows.length} | 找到: ${stats.found} | 成功率: ${(stats.found/stats.checked*100).toFixed(1)}% ---`)
    }
    
    await new Promise(r => setTimeout(r, DELAY_MS))
  }
  
  // 写入剩余
  if (updates.length > 0) {
    await flushUpdates(updates)
  }
  
  console.log('\n=== 完成 ===')
  console.log(`检查: ${stats.checked}`)
  console.log(`找到封面: ${stats.found}`)
  console.log(`未找到: ${stats.skipped}`)
  console.log(`成功率: ${(stats.found/stats.checked*100).toFixed(1)}%`)
  console.log(`结束时间: ${new Date().toLocaleString()}`)
  
  await pool.end()
}

async function flushUpdates(updates) {
  for (const u of updates) {
    await pool.query('UPDATE library_items SET cover_url = $1 WHERE id = $2', [u.cover_url, u.id])
  }
  console.log(`[DB] 写入 ${updates.length} 条封面`)
}

main().catch(e => { console.error(e); process.exit(1) })
