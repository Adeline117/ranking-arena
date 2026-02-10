#!/usr/bin/env node
/**
 * Bybit头像 - 用保存的API数据和DB的handle精确匹配
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
  console.log('=== Bybit handle匹配 ===')
  
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.goto('https://www.bybit.com/copyTrade', { waitUntil: 'networkidle2', timeout: 30000 })
  await new Promise(r => setTimeout(r, 3000))
  
  // 获取所有traders
  const traders = await page.evaluate(async () => {
    const all = []
    for (let p = 1; p <= 200; p++) {
      try {
        const res = await fetch(`/x-api/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=${p}&pageSize=50&dataDuration=DATA_DURATION_THIRTY_DAY`)
        const d = await res.json()
        const list = d.result?.leaderDetails || []
        if (!list.length) break
        for (const t of list) {
          all.push({ name: t.nickName, photo: t.profilePhoto || '' })
        }
        await new Promise(r => setTimeout(r, 200))
      } catch { break }
    }
    return all
  })
  
  console.log(`API获取: ${traders.length}`)
  const withPhoto = traders.filter(t => t.photo && !t.photo.includes('deadpool'))
  console.log(`有真实头像: ${withPhoto.length}`)
  
  await browser.close()
  
  // 用handle匹配(case-insensitive)
  let matched = 0
  for (const t of withPhoto) {
    if (!t.name) continue
    const { rowCount } = await pool.query(
      `UPDATE trader_sources SET avatar_url = $1 
       WHERE source IN ('bybit', 'bybit_spot') 
       AND LOWER(handle) = LOWER($2) 
       AND (avatar_url IS NULL OR avatar_url LIKE '%deadpool%')`,
      [t.photo, t.name]
    )
    if (rowCount > 0) matched++
  }
  
  console.log(`handle匹配成功: ${matched}`)
  
  const { rows } = await pool.query(`
    SELECT source, count(*) as total, 
      count(CASE WHEN avatar_url IS NOT NULL AND avatar_url NOT LIKE '%deadpool%' THEN 1 END) as real_av
    FROM trader_sources WHERE source IN ('bybit', 'bybit_spot') GROUP BY source
  `)
  for (const r of rows) console.log(`${r.source}: ${r.real_av}/${r.total}`)
  
  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })
