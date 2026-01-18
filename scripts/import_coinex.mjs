/**
 * CoinEx Copy Trading 排行榜数据抓取
 * 
 * URL: https://www.coinex.com/en/copy-trading/futures
 * 分页: .via-pager li.number
 * 
 * 用法: node scripts/import_coinex.mjs [7D|30D|90D]
 */

import 'dotenv/config'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { createClient } from '@supabase/supabase-js'

puppeteer.use(StealthPlugin())

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const SOURCE = 'coinex'
const BASE_URL = 'https://www.coinex.com/en/copy-trading/futures'
const TARGET_COUNT = 100
const MAX_PAGES = 17

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getTargetPeriod() {
  const arg = process.argv[2]?.toUpperCase()
  if (arg && ['7D', '30D', '90D'].includes(arg)) return arg
  return '90D'
}

async function fetchLeaderboardData(period) {
  console.log(`\n=== 抓取 CoinEx ${period} 排行榜 ===`)
  console.log('时间:', new Date().toISOString())
  console.log(`目标: ${TARGET_COUNT} 个交易员`)

  const allTraders = new Map()

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

    // 提取函数
    const extractTraders = async () => {
      return await page.evaluate(() => {
        const results = []
        document.body.innerText.split(/\nCopy\n/).forEach((chunk, idx) => {
          if (idx === 0) return
          const roiMatch = chunk.match(/([\d,]+\.\d+)%/)
          if (roiMatch) {
            const roi = parseFloat(roiMatch[1].replace(/,/g, ''))
            const lines = chunk.split('\n').map(l => l.trim()).filter(l => l && l.length > 2 && l.length < 25 && !l.includes('%'))
            if (lines[0] && roi > 0) {
              results.push({ nickName: lines[0], roi })
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
    avatar: null,
    roi: t.roi,
    pnl: null,
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
        is_active: true,
      }, { onConflict: 'source,source_trader_id' })

      const { error } = await supabase.from('trader_snapshots').insert({
        source: SOURCE,
        source_trader_id: trader.traderId,
        season_id: period,
        rank: trader.rank,
        roi: trader.roi,
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
  const period = getTargetPeriod()
  console.log(`\n========================================`)
  console.log(`CoinEx 数据抓取 - ${period}`)
  console.log(`========================================`)

  const traders = await fetchLeaderboardData(period)

  if (traders.length === 0) {
    console.log('\n⚠ 未获取到数据')
    return
  }

  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  traders.forEach((t, idx) => t.rank = idx + 1)

  const top100 = traders.slice(0, TARGET_COUNT)

  console.log(`\n📋 TOP 10:`)
  top100.slice(0, 10).forEach((t, idx) => {
    console.log(`  ${idx + 1}. ${t.nickname}: ROI ${t.roi?.toFixed(2)}%`)
  })

  const result = await saveTraders(top100, period)

  console.log(`\n========================================`)
  console.log(`✅ 完成！总数: ${top100.length}, TOP ROI: ${top100[0]?.roi?.toFixed(2)}%`)
  console.log(`========================================`)
}

main().catch(console.error)
