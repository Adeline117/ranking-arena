/**
 * 统一浏览器头像抓取 - 逐个交易所获取真实头像
 * 用Puppeteer打开每个交易所的跟单页面，拦截API或DOM抓取头像
 */
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import pg from 'pg'
const { Pool } = pg

puppeteer.use(StealthPlugin())

const pool = new Pool({
  connectionString: 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'
})

const EXCHANGES = [
  {
    name: 'xt',
    source: 'xt',
    url: 'https://www.xt.com/en/copy-trading/leaderboard',
    pages: 10,
  },
  {
    name: 'bingx', 
    source: 'bingx',
    url: 'https://bingx.com/en/copy-trading/',
    pages: 5,
  },
  {
    name: 'weex',
    source: 'weex',
    url: 'https://www.weex.com/copy-trading',
    pages: 5,
  },
  {
    name: 'lbank',
    source: 'lbank',
    url: 'https://www.lbank.com/copy-trading',
    pages: 5,
  },
  {
    name: 'coinex',
    source: 'coinex',
    url: 'https://www.coinex.com/copy-trading',
    pages: 5,
  },
  {
    name: 'phemex',
    source: 'phemex',
    url: 'https://phemex.com/copy-trading',
    pages: 5,
  },
]

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function scrapeExchange(browser, exchange) {
  console.log(`\n=== ${exchange.name} ===`)
  console.log(`URL: ${exchange.url}`)
  
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
  
  const traders = new Map()
  
  // 拦截所有JSON API响应
  page.on('response', async (response) => {
    if (response.status() !== 200) return
    const ct = response.headers()['content-type'] || ''
    if (!ct.includes('json')) return
    
    try {
      const body = await response.text()
      if (body.length < 100 || body.length > 500000) return
      const data = JSON.parse(body)
      
      // 递归搜索包含trader数据的数组
      function findTraderLists(obj, depth = 0) {
        if (depth > 5) return
        if (Array.isArray(obj)) {
          for (const item of obj) {
            if (typeof item === 'object' && item !== null) {
              // 看起来像trader对象
              const id = item.traderId || item.uid || item.userId || item.id || item.leaderUserId || ''
              const name = item.nickName || item.nickname || item.name || item.displayName || item.traderName || ''
              const avatar = item.avatar || item.avatarUrl || item.headImg || item.photoUrl || item.userPhoto || item.portLink || ''
              
              if (id && (name || avatar)) {
                const sid = String(id)
                if (!traders.has(sid)) {
                  traders.set(sid, { id: sid, name: String(name), avatar: String(avatar) })
                }
              }
            }
          }
        }
        if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
          for (const val of Object.values(obj)) {
            findTraderLists(val, depth + 1)
          }
        }
      }
      
      findTraderLists(data)
    } catch {}
  })
  
  try {
    await page.goto(exchange.url, { waitUntil: 'networkidle2', timeout: 30000 })
    await sleep(3000)
    
    // 翻页/滚动
    for (let i = 0; i < exchange.pages; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(2000)
      
      // 尝试各种下一页按钮
      try {
        const nextBtn = await page.$('[class*="next"]:not([disabled]), .ant-pagination-next:not(.ant-pagination-disabled), [aria-label="next"], button:has-text("Next"), [class*="pagination"] [class*="next"]')
        if (nextBtn) {
          await nextBtn.click()
          await sleep(2000)
        }
      } catch {}
      
      console.log(`  页${i + 2}: ${traders.size} 个交易员`)
    }
    
    // 也从DOM直接提取
    const domTraders = await page.evaluate(() => {
      const results = []
      // 查找所有头像图片
      document.querySelectorAll('img[src*="avatar"], img[src*="user"], img[class*="avatar"]').forEach(img => {
        const src = img.src
        if (src && !src.includes('default') && !src.includes('placeholder') && src.startsWith('http')) {
          // 尝试找旁边的名字
          const card = img.closest('[class*="card"], [class*="trader"], [class*="item"], tr, li')
          if (card) {
            const nameEl = card.querySelector('[class*="name"], [class*="nick"], h3, h4, span')
            if (nameEl) {
              results.push({ avatar: src, name: nameEl.textContent?.trim() || '' })
            }
          }
        }
      })
      return results
    })
    
    console.log(`  DOM额外发现: ${domTraders.length}`)
    
  } catch (e) {
    console.log(`  错误: ${e.message}`)
  }
  
  await page.close()
  
  console.log(`  总计: ${traders.size} 个交易员`)
  
  // 更新DB
  let updated = 0
  for (const [id, t] of traders) {
    if (t.avatar && t.avatar.length > 10 && t.avatar.startsWith('http')) {
      const { rowCount } = await pool.query(
        'UPDATE trader_sources SET avatar_url = $1 WHERE source = $2 AND source_trader_id = $3 AND avatar_url IS NULL',
        [t.avatar, exchange.source, id]
      )
      if (rowCount > 0) updated++
    }
  }
  
  console.log(`  更新DB: ${updated}`)
  return { exchange: exchange.name, found: traders.size, updated }
}

async function main() {
  console.log('=== 统一交易所头像抓取 ===')
  console.log(`开始: ${new Date().toISOString()}`)
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })
  
  const results = []
  for (const exchange of EXCHANGES) {
    try {
      const result = await scrapeExchange(browser, exchange)
      results.push(result)
    } catch (e) {
      console.log(`${exchange.name} 失败: ${e.message}`)
      results.push({ exchange: exchange.name, found: 0, updated: 0 })
    }
  }
  
  await browser.close()
  
  console.log('\n=== 总结 ===')
  for (const r of results) {
    console.log(`${r.exchange}: 发现 ${r.found}, 更新 ${r.updated}`)
  }
  
  await pool.end()
  console.log(`完成: ${new Date().toISOString()}`)
}

main().catch(e => { console.error(e); process.exit(1) })
