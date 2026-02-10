#!/usr/bin/env node
/**
 * XT.com 头像补全 - 浏览器fetch
 * API: /fapi/user/v1/public/copy-trade/elite-leader-list-v2
 * 字段: accountId, nickName, avatar
 * Also try leader-list with pagination
 */
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import pg from 'pg'
const { Pool } = pg

puppeteer.use(StealthPlugin())

const pool = new Pool({
  connectionString: 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'
})

async function main() {
  console.log('=== XT.com 头像补全 ===')
  
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.goto('https://www.xt.com/en/copy-trading/futures', { waitUntil: 'networkidle2', timeout: 30000 })
  await new Promise(r => setTimeout(r, 5000))
  
  // 获取所有交易员
  const result = await page.evaluate(async () => {
    const all = new Map()
    
    // 1. Elite leader list (6 categories × 3-20 each)
    for (const size of [3, 10, 20, 50]) {
      try {
        const res = await fetch(`https://www.xt.com/fapi/user/v1/public/copy-trade/elite-leader-list-v2?size=${size}`)
        const d = await res.json()
        for (const cat of d.result || []) {
          for (const t of cat.items || []) {
            if (t.avatar && t.accountId) {
              all.set(t.accountId, { id: t.accountId, name: t.nickName, avatar: t.avatar })
            }
          }
        }
        await new Promise(r => setTimeout(r, 500))
      } catch {}
    }
    
    // 2. Try paginated leader list
    for (let page = 1; page <= 50; page++) {
      try {
        const res = await fetch(`https://www.xt.com/fapi/user/v1/public/copy-trade/leader-list?page=${page}&size=50&sortType=INCOME_RATE`)
        const ct = res.headers.get('content-type') || ''
        if (!ct.includes('json')) break
        const d = await res.json()
        const items = d.result?.items || d.result || []
        if (!Array.isArray(items) || !items.length) break
        for (const t of items) {
          if (t.avatar && (t.accountId || t.userId)) {
            all.set(t.accountId || t.userId, { id: t.accountId || t.userId, name: t.nickName || t.nickname, avatar: t.avatar })
          }
        }
        await new Promise(r => setTimeout(r, 300))
      } catch { break }
    }
    
    return Array.from(all.values())
  })
  
  console.log(`获取: ${result.length} 个有头像的交易员`)
  await browser.close()
  
  // DB更新
  let idMatch = 0, nameMatch = 0
  for (const t of result) {
    // accountId匹配
    const r1 = await pool.query(
      'UPDATE trader_sources SET avatar_url = $1 WHERE source = $2 AND source_trader_id = $3 AND avatar_url IS NULL',
      [t.avatar, 'xt', t.id]
    )
    if (r1.rowCount > 0) { idMatch++; continue }
    
    // nickname匹配
    if (t.name) {
      const r2 = await pool.query(
        'UPDATE trader_sources SET avatar_url = $1 WHERE source = $2 AND handle = $3 AND avatar_url IS NULL',
        [t.avatar, 'xt', t.name]
      )
      if (r2.rowCount > 0) nameMatch++
    }
  }
  
  console.log(`ID匹配: ${idMatch}, 昵称匹配: ${nameMatch}, 总: ${idMatch + nameMatch}`)
  
  const { rows } = await pool.query("SELECT count(*) as total, count(CASE WHEN avatar_url IS NOT NULL THEN 1 END) as has FROM trader_sources WHERE source='xt'")
  console.log(`XT最终: ${rows[0].has}/${rows[0].total}`)
  
  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })
