/**
 * MEXC交易员头像抓取 - 通过Puppeteer绕过WAF
 * 在浏览器内执行fetch获取API数据
 */
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import pg from 'pg'
const { Pool } = pg

puppeteer.use(StealthPlugin())

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
})

const DEFAULT_AVATAR = 'https://static.mocortech.com/futures-v3/_next/static/assets/img/avatar1.8fc6058c.png'

async function main() {
  console.log('=== MEXC 头像抓取（浏览器内fetch）===')
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
  
  // 先访问MEXC页面建立session
  console.log('打开MEXC...')
  await page.goto('https://www.mexc.com/futures/copyTrade/home', { waitUntil: 'networkidle2', timeout: 30000 })
  await new Promise(r => setTimeout(r, 3000))
  
  // 在浏览器内批量获取数据
  let allTraders = []
  const totalPages = 226 // 22540 / 100
  const batchSize = 20
  
  for (let batch = 0; batch * batchSize < totalPages; batch++) {
    const startPage = batch * batchSize + 1
    const endPage = Math.min(startPage + batchSize - 1, totalPages)
    
    console.log(`批次 ${batch + 1}: 页${startPage}-${endPage}`)
    
    const result = await page.evaluate(async (start, end) => {
      const traders = []
      for (let p = start; p <= end; p++) {
        try {
          const res = await fetch(`/api/platform/futures/copyFutures/api/v1/traders/v2?condition=%5B%5D&limit=100&orderBy=COMPREHENSIVE&page=${p}`)
          const d = await res.json()
          const list = d.data?.content || []
          if (!list.length) break
          for (const t of list) {
            if (t.uid && t.avatar) {
              traders.push({ uid: t.uid, avatar: t.avatar, name: t.nickname || '' })
            }
          }
          await new Promise(r => setTimeout(r, 200))
        } catch { break }
      }
      return traders
    }, startPage, endPage)
    
    allTraders = allTraders.concat(result)
    console.log(`  获取: ${result.length}, 累计: ${allTraders.length}`)
    
    if (result.length === 0) break
    await new Promise(r => setTimeout(r, 1000))
  }
  
  await browser.close()
  
  console.log(`\n总共获取: ${allTraders.length} 个有头像的交易员`)
  
  // 过滤掉默认头像(avatar1)，保留MEXC分配的预设头像
  const withRealAvatar = allTraders.filter(t => !t.avatar.includes('avatar1.8fc6058c'))
  console.log(`排除默认avatar1后: ${withRealAvatar.length}`)
  
  // 批量更新DB
  let updated = 0
  for (const t of withRealAvatar) {
    const { rowCount } = await pool.query(
      'UPDATE trader_sources SET avatar_url = $1 WHERE source = $2 AND source_trader_id = $3',
      [t.avatar, 'mexc', t.uid]
    )
    if (rowCount > 0) updated++
  }
  
  console.log(`更新DB: ${updated}`)
  console.log('完成!')
  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })
