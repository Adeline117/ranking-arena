#!/usr/bin/env node
/**
 * Bybit 头像补全 - 浏览器内fetch API
 * 字段: profilePhoto (不是avatar)
 * 排除: deadpool SVG (默认头像)
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
  console.log('=== Bybit 头像补全 ===')
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox']
  })
  
  const page = await browser.newPage()
  await page.goto('https://www.bybit.com/copyTrade', { waitUntil: 'networkidle2', timeout: 30000 })
  await new Promise(r => setTimeout(r, 3000))
  
  // 从API获取所有页的交易员
  const result = await page.evaluate(async () => {
    const all = []
    for (let p = 1; p <= 100; p++) {
      try {
        const res = await fetch(`/x-api/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=${p}&pageSize=50&dataDuration=DATA_DURATION_THIRTY_DAY`)
        const d = await res.json()
        const list = d.result?.leaderDetails || []
        if (!list.length) break
        for (const t of list) {
          if (t.profilePhoto && !t.profilePhoto.includes('deadpool')) {
            all.push({ uid: t.leaderMark, photo: t.profilePhoto, name: t.nickName })
          }
        }
        await new Promise(r => setTimeout(r, 300))
      } catch { break }
    }
    return all
  })
  
  console.log(`获取: ${result.length} 个有真实头像的交易员`)
  await browser.close()
  
  // 写入DB
  let updated = 0
  for (const t of result) {
    const { rowCount } = await pool.query(
      `UPDATE trader_sources SET avatar_url = $1 WHERE source IN ('bybit', 'bybit_spot') AND source_trader_id = $2 AND (avatar_url IS NULL OR avatar_url LIKE '%deadpool%')`,
      [t.photo, t.uid]
    )
    if (rowCount > 0) updated++
  }
  
  console.log(`DB更新: ${updated}`)
  
  // 也尝试用nickname匹配
  let nameMatched = 0
  for (const t of result) {
    if (!t.name) continue
    const { rowCount } = await pool.query(
      `UPDATE trader_sources SET avatar_url = $1 WHERE source IN ('bybit', 'bybit_spot') AND handle = $2 AND (avatar_url IS NULL OR avatar_url LIKE '%deadpool%')`,
      [t.photo, t.name]
    )
    if (rowCount > 0) nameMatched++
  }
  
  console.log(`昵称匹配: ${nameMatched}`)
  console.log(`总更新: ${updated + nameMatched}`)
  
  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })
