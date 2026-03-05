#!/usr/bin/env node
/**
 * MEXC 交易员真实头像批量抓取
 * 通过Puppeteer打开MEXC跟单页面，拦截API响应获取头像
 * 只保存真正的自定义头像，排除默认头像
 */
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import pg from 'pg'
const { Pool } = pg

puppeteer.use(StealthPlugin())

const pool = new Pool({
  connectionString: 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'
})

// 默认头像特征 - 排除这些
const DEFAULT_AVATAR_PATTERNS = [
  'avatar1.8fc6058c', // MEXC统一默认头像
  '/banner/',
  'placeholder',
  'default_avatar',
  'default.png',
  'default.jpg',
]

function isRealAvatar(url) {
  if (!url) return false
  return !DEFAULT_AVATAR_PATTERNS.some(p => url.includes(p))
}

let stats = { checked: 0, found: 0, defaultSkipped: 0, errors: 0 }

async function main() {
  console.log('=== MEXC 真实头像批量抓取 ===')
  
  // 获取没有头像的MEXC交易员
  const { rows } = await pool.query(`
    SELECT source_trader_id FROM trader_sources 
    WHERE source = 'mexc' AND avatar_url IS NULL 
    LIMIT 4000
  `)
  console.log(`待处理: ${rows.length} 个交易员`)
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })
  
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
  
  // 从列表页批量获取 - 拦截API响应
  const traderAvatars = new Map()
  
  page.on('response', async response => {
    const url = response.url()
    if ((url.includes('copy') || url.includes('trader') || url.includes('rank')) && response.status() === 200) {
      try {
        const contentType = response.headers()['content-type'] || ''
        if (!contentType.includes('json')) return
        const data = await response.json()
        let list = data?.data?.list || data?.data?.items || data?.data?.traders || data?.list || []
        if (data?.data && Array.isArray(data.data)) list = data.data
        
        if (Array.isArray(list)) {
          for (const item of list) {
            const traderId = String(item.traderId || item.uid || item.id || '')
            const avatar = item.avatar || item.avatarUrl || item.headImg || item.photoUrl || item.userPhoto || null
            if (traderId && avatar && isRealAvatar(avatar)) {
              traderAvatars.set(traderId, avatar)
            }
          }
        }
      } catch(e) {}
    }
  })
  
  // 浏览排行榜多页，收集头像
  console.log('正在浏览MEXC排行榜页面...')
  try {
    await page.goto('https://www.mexc.com/futures/copyTrade/home', { waitUntil: 'networkidle2', timeout: 30000 })
    await new Promise(r => setTimeout(r, 3000))
    
    // 翻页收集更多数据
    for (let i = 0; i < 30; i++) {
      try {
        // 滚动到底部触发加载
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await new Promise(r => setTimeout(r, 2000))
        
        // 尝试点击下一页
        const nextBtn = await page.$('.next-btn, .pagination-next, [class*="next"], button:has-text("下一页")')
        if (nextBtn) {
          await nextBtn.click()
          await new Promise(r => setTimeout(r, 2000))
        }
        
        console.log(`  页 ${i+1}: 已收集 ${traderAvatars.size} 个头像`)
        
        if (traderAvatars.size >= 2000) break
      } catch(e) {
        break
      }
    }
  } catch(e) {
    console.log('页面加载出错:', e.message)
  }
  
  console.log(`\n从列表页收集到 ${traderAvatars.size} 个真实头像`)
  
  // 对于列表中没有的，尝试逐个打开详情页
  const needDetail = rows.filter(r => !traderAvatars.has(r.source_trader_id)).slice(0, 200)
  console.log(`需要访问详情页: ${needDetail.length} 个`)
  
  for (const row of needDetail) {
    try {
      const detailUrl = `https://www.mexc.com/copy-trading/trader/detail?traderId=${row.source_trader_id}`
      await page.goto(detailUrl, { waitUntil: 'networkidle2', timeout: 15000 })
      await new Promise(r => setTimeout(r, 1000))
      
      // 从页面DOM直接提取头像
      const avatar = await page.evaluate(() => {
        const img = document.querySelector('[class*="avatar"] img, [class*="Avatar"] img, .trader-avatar img, .user-avatar img')
        return img?.src || null
      })
      
      if (avatar && isRealAvatar(avatar)) {
        traderAvatars.set(row.source_trader_id, avatar)
      }
      
      stats.checked++
      if (stats.checked % 20 === 0) {
        console.log(`  详情页进度: ${stats.checked}/${needDetail.length} | 新增: ${traderAvatars.size}`)
      }
    } catch(e) {
      stats.errors++
    }
  }
  
  await browser.close()
  
  // 批量更新DB
  let updated = 0
  for (const [traderId, avatarUrl] of traderAvatars) {
    try {
      const res = await pool.query(
        'UPDATE trader_sources SET avatar_url = $1 WHERE source = $2 AND source_trader_id = $3 AND avatar_url IS NULL',
        [avatarUrl, 'mexc', traderId]
      )
      if (res.rowCount > 0) updated++
    } catch(e) {}
  }
  
  console.log('\n=== 完成 ===')
  console.log(`收集头像: ${traderAvatars.size}`)
  console.log(`更新DB: ${updated}`)
  console.log(`详情页错误: ${stats.errors}`)
  
  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })
