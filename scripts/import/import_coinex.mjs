/**
 * CoinEx Copy Trading 排行榜数据抓取
 * 
 * URL: https://www.coinex.com/en/copy-trading/futures
 * 分页: .via-pager li.number
 * 
 * 用法: node scripts/import_coinex.mjs [7D|30D|90D]
 */

import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from '../lib/shared.mjs'

puppeteer.use(StealthPlugin())

const supabase = getSupabaseClient()

const SOURCE = 'coinex'
const BASE_URL = 'https://www.coinex.com/en/copy-trading/futures'
const TARGET_COUNT = 500
const MAX_PAGES = 17

async function fetchLeaderboardData(period) {
  console.log(`\n=== 抓取 CoinEx ${period} 排行榜 ===`)
  console.log('时间:', new Date().toISOString())
  console.log(`目标: ${TARGET_COUNT} 个交易员`)

  const allTraders = new Map()

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
    timeout: 60000,  // 增加启动超时到 60 秒
  })

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

    // 提取函数
    const extractTraders = async () => {
      return await page.evaluate(() => {
        const results = []
        
        // 首先收集所有头像
        const avatarMap = {}
        document.querySelectorAll('img').forEach(img => {
          const src = img.src || ''
          if (src.includes('avatar') || src.includes('user') || src.includes('head')) {
            const parent = img.closest('a, div, li')
            if (parent) {
              const text = parent.innerText?.split('\n')[0]?.trim()
              if (text && text.length > 1 && text.length < 30) {
                avatarMap[text] = src
              }
            }
          }
        })
        
        document.body.innerText.split(/\nCopy\n/).forEach((chunk, idx) => {
          if (idx === 0) return
          const roiMatch = chunk.match(/([\d,]+\.\d+)%/)
          if (roiMatch) {
            const roi = parseFloat(roiMatch[1].replace(/,/g, ''))
            const lines = chunk.split('\n').map(l => l.trim()).filter(l => l && l.length > 2 && l.length < 25 && !l.includes('%'))
            // Try to extract PnL: look for dollar amounts like $1,234.56 or +1,234.56 USDT
            const pnlMatch = chunk.match(/[\+\-]?\$?([\d,]+(?:\.\d+)?)\s*(?:USDT|USD)?/i)
            const pnl = pnlMatch ? parseFloat(pnlMatch[1].replace(/,/g, '')) : null
            if (lines[0] && roi > 0) {
              results.push({
                nickName: lines[0],
                roi,
                pnl,
                avatar: avatarMap[lines[0]] || null
              })
            }
          }
        })
        return results
      })
    }

    console.log('\n📱 访问页面...')
    try {
      await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 60000 })
    } catch (e) {
      console.log('  ⚠ 加载超时')
    }
    await sleep(8000)

    // 关闭弹窗
    await page.evaluate(() => {
      document.querySelectorAll('button').forEach(btn => {
        const text = btn.textContent || ''
        if (text.includes('Got it') || text.includes('OK') || text.includes('Accept')) {
          try { btn.click() } catch (e) {}
        }
      })
    })
    await sleep(2000)

    // 第1页
    let traders = await extractTraders()
    traders.forEach(t => allTraders.set(t.nickName, t))
    console.log(`  第1页: ${allTraders.size} 个`)

    // 分页获取
    console.log('\n📄 分页获取数据...')
    
    for (let pageNum = 2; pageNum <= MAX_PAGES; pageNum++) {
      if (allTraders.size >= TARGET_COUNT) {
        console.log(`  ✓ 已达到目标 ${TARGET_COUNT}`)
        break
      }

      // 滚动到分页
      await page.evaluate(() => window.scrollTo(0, 2000))
      await sleep(500)

      // 点击页码
      const clicked = await page.evaluate((pageNum) => {
        const items = document.querySelectorAll('.via-pager li.number')
        for (const item of items) {
          if (item.textContent?.trim() === String(pageNum)) {
            item.click()
            return true
          }
        }
        // 点击下一页
        const nextBtn = document.querySelector('.via-pager li.more')
        if (nextBtn) {
          nextBtn.click()
          return 'next'
        }
        return false
      }, pageNum)

      if (!clicked) {
        console.log(`  无法翻到第 ${pageNum} 页`)
        break
      }

      await sleep(3000)

      // 滚动回顶部
      await page.evaluate(() => window.scrollTo(0, 0))
      await sleep(500)

      traders = await extractTraders()
      const before = allTraders.size
      traders.forEach(t => allTraders.set(t.nickName, t))
      console.log(`  第${pageNum}页: ${traders.length} 个, 新增 ${allTraders.size - before}, 累计 ${allTraders.size}`)
    }

    console.log(`\n📊 共获取 ${allTraders.size} 个交易员数据`)

  } finally {
    await browser.close()
  }

  return Array.from(allTraders.values()).map((t, idx) => ({
    traderId: t.nickName,
    nickname: t.nickName,
    avatar: t.avatar || null,
    roi: t.roi,
    pnl: t.pnl || null,
    winRate: null,
    maxDrawdown: null,
    followers: null,
    rank: idx + 1,
  }))
}

async function saveTraders(traders, period) {
  console.log(`\n💾 保存 ${traders.length} 个交易员...`)
  
  const capturedAt = new Date().toISOString()
  let saved = 0, errors = 0

  for (const trader of traders) {
    try {
      await supabase.from('trader_sources').upsert({
        source: SOURCE,
        source_type: 'leaderboard',
        source_trader_id: trader.traderId,
        handle: trader.nickname,
        avatar_url: trader.avatar || null,
        is_active: true,
      }, { onConflict: 'source,source_trader_id' })

      const { error } = await supabase.from('trader_snapshots').insert({
        source: SOURCE,
        source_trader_id: trader.traderId,
        season_id: period,
        rank: trader.rank,
        roi: trader.roi,
        pnl: trader.pnl || null,
        win_rate: trader.winRate || null,
        max_drawdown: trader.maxDrawdown || null,
        followers: trader.followers || 0,
        arena_score: calculateArenaScore(trader.roi, trader.pnl, trader.maxDrawdown, trader.winRate, period).totalScore,
        captured_at: capturedAt,
      })
      if (error) errors++
      else saved++
    } catch (e) { errors++ }
  }

  console.log(`  ✓ 保存: ${saved}, 失败: ${errors}`)
  return { saved, errors }
}

async function main() {
  const periods = getTargetPeriods()
  const totalStartTime = Date.now()
  
  console.log(`\n========================================`)
  console.log(`CoinEx 数据抓取`)
  console.log(`目标周期: ${periods.join(', ')}`)
  console.log(`========================================`)

  const results = []

  for (const period of periods) {
    console.log(`\n${'='.repeat(50)}`)
    console.log(`📊 开始抓取 ${period} 排行榜...`)
    console.log(`${'='.repeat(50)}`)
    
    const traders = await fetchLeaderboardData(period)

    if (traders.length === 0) {
      console.log(`\n⚠ ${period} 未获取到数据，跳过`)
      continue
    }

    traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
    traders.forEach((t, idx) => t.rank = idx + 1)

    const top100 = traders.slice(0, TARGET_COUNT)

    console.log(`\n📋 ${period} TOP 10:`)
    top100.slice(0, 10).forEach((t, idx) => {
      console.log(`  ${idx + 1}. ${t.nickname}: ROI ${t.roi?.toFixed(2)}%`)
    })

    const result = await saveTraders(top100, period)
    results.push({ period, count: top100.length, topRoi: top100[0]?.roi || 0 })
    
    console.log(`\n✅ ${period} 完成！`)
    
    if (periods.indexOf(period) < periods.length - 1) {
      console.log(`\n⏳ 等待 5 秒后抓取下一个时间段...`)
      await sleep(5000)
    }
  }
  
  const totalTime = ((Date.now() - totalStartTime) / 1000).toFixed(1)

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ 全部完成！`)
  console.log(`${'='.repeat(60)}`)
  console.log(`📊 抓取结果:`)
  for (const r of results) {
    console.log(`   ${r.period}: ${r.count} 条, TOP ROI ${r.topRoi?.toFixed(2)}%`)
  }
  console.log(`   总耗时: ${totalTime}s`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)
