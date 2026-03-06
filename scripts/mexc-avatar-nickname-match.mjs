#!/usr/bin/env node
/**
 * MEXC头像 - 用nickname和uid双重匹配
 */
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import pg from 'pg'
import fs from 'fs'
const { Pool } = pg

puppeteer.use(StealthPlugin())

const pool = new Pool({
  connectionString: '${process.env.DATABASE_URL}'
})

async function main() {
  console.log('=== MEXC 头像 nickname+uid 双匹配 ===')
  
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.goto('https://www.mexc.com/copy-trading', { waitUntil: 'networkidle2', timeout: 30000 })
  await new Promise(r => setTimeout(r, 3000))
  
  const allTraders = []
  
  for (let batch = 0; batch < 12; batch++) {
    const startPage = batch * 20 + 1
    const endPage = startPage + 19
    
    const traders = await page.evaluate(async (sp, ep) => {
      const results = []
      for (let p = sp; p <= ep; p++) {
        try {
          const res = await fetch('/api/platform/futures/copyFutures/api/v1/traders/v2', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pageNum: p, pageSize: 100, sortField: 'TOTAL_PNL', sortType: 'DESC' })
          })
          const d = await res.json()
          const list = d.data?.resultList || []
          if (!list.length) break
          for (const t of list) {
            if (t.avatar) {
              results.push({ uid: String(t.uid), nickname: t.nickname, avatar: t.avatar })
            }
          }
          await new Promise(r => setTimeout(r, 200))
        } catch { break }
      }
      return results
    }, startPage, endPage)
    
    allTraders.push(...traders)
    console.log(`批次 ${batch+1}: ${traders.length} 个, 累计 ${allTraders.length}`)
  }
  
  await browser.close()
  
  // 保存到文件
  fs.writeFileSync('/tmp/mexc-all-traders.json', JSON.stringify(allTraders))
  console.log(`总计: ${allTraders.length} 个交易员`)
  
  // 双重匹配
  let uidMatch = 0, nicknameMatch = 0
  
  for (const t of allTraders) {
    // 1. uid匹配
    const r1 = await pool.query(
      'UPDATE trader_sources SET avatar_url = $1 WHERE source = $2 AND source_trader_id = $3 AND avatar_url IS NULL',
      [t.avatar, 'mexc', t.uid]
    )
    if (r1.rowCount > 0) { uidMatch++; continue }
    
    // 2. nickname匹配
    if (t.nickname) {
      const r2 = await pool.query(
        'UPDATE trader_sources SET avatar_url = $1 WHERE source = $2 AND handle = $3 AND avatar_url IS NULL',
        [t.avatar, 'mexc', t.nickname]
      )
      if (r2.rowCount > 0) nicknameMatch++
    }
  }
  
  console.log(`uid匹配: ${uidMatch}, nickname匹配: ${nicknameMatch}, 总: ${uidMatch + nicknameMatch}`)
  
  // 检查最终覆盖率
  const { rows } = await pool.query("SELECT count(*) as total, count(CASE WHEN avatar_url IS NOT NULL THEN 1 END) as has FROM trader_sources WHERE source='mexc'")
  console.log(`MEXC最终: ${rows[0].has}/${rows[0].total}`)
  
  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })
