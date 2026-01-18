/**
 * GMX Leaderboard 数据抓取
 * 
 * URL: https://app.gmx.io/#/leaderboard
 * 分页: 底部按钮 1 2 3 > >|
 * 
 * 用法: node scripts/import_gmx.mjs [7D|30D]
 * 注意: GMX 只有 7D 和 30D，没有 90D
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

const SOURCE = 'gmx'
const BASE_URL = 'https://app.gmx.io/#/leaderboard'
const TARGET_COUNT = 100
const MAX_PAGES = 10

const PERIOD_CONFIG = {
  '7D': { tabText: 'Last 7d' },
  '30D': { tabText: 'Last 30d' },
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getTargetPeriod() {
  const arg = process.argv[2]?.toUpperCase()
  if (arg && ['7D', '30D'].includes(arg)) return arg
  return '30D'
}

async function fetchLeaderboardData(period) {
  const config = PERIOD_CONFIG[period]
  
  console.log(`\n=== 抓取 GMX ${period} 排行榜 ===`)
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
        const rows = document.querySelectorAll('tr')
        const results = []
        rows.forEach(row => {
          const text = row.innerText
          const addrMatch = text.match(/0x[a-fA-F0-9]+\.{3}[a-fA-F0-9]+/)
          const pnlMatch = text.match(/([+-])\s*([\d,]+\.\d+)\s*%/)
          if (addrMatch && pnlMatch) {
            const roi = parseFloat(pnlMatch[2].replace(/,/g, '')) * (pnlMatch[1] === '-' ? -1 : 1)
            results.push({ address: addrMatch[0], roi })
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
    await sleep(15000)

    // 点击时间周期 tab
    console.log(`🔄 切换到 ${period}...`)
    await page.evaluate((tabText) => {
      document.querySelectorAll('button').forEach(btn => {
        if (btn.textContent?.includes(tabText.replace('Last ', ''))) {
          btn.click()
        }
      })
    }, config.tabText)
    
    // 等待数据加载
    console.log('  等待数据加载...')
    for (let i = 0; i < 10; i++) {
      await sleep(3000)
      const hasData = await page.evaluate(() => {
        return document.body.innerText.includes('0x')
      })
      if (hasData) {
        console.log(`  ✓ 数据已加载`)
        break
      }
    }

    // 第1页
    let traders = await extractTraders()
    traders.forEach(t => allTraders.set(t.address, t))
    console.log(`  第1页: ${allTraders.size} 个`)

    // 分页获取
    console.log('\n📄 分页获取数据...')
    
    for (let pageNum = 2; pageNum <= MAX_PAGES; pageNum++) {
      if (allTraders.size >= TARGET_COUNT) {
        console.log(`  ✓ 已达到目标 ${TARGET_COUNT}`)
        break
      }

      // 点击页码
      const clicked = await page.evaluate((pageNum) => {
        const buttons = document.querySelectorAll('button')
        for (const btn of buttons) {
          if (btn.textContent?.trim() === String(pageNum)) {
            btn.click()
            return true
          }
        }
        // 尝试点击下一页 >
        for (const btn of buttons) {
          if (btn.textContent?.trim() === '>') {
            btn.click()
            return 'next'
          }
        }
        return false
      }, pageNum)

      if (!clicked) {
        console.log(`  无法翻到第 ${pageNum} 页`)
        break
      }

      await sleep(3000)

      traders = await extractTraders()
      const before = allTraders.size
      traders.forEach(t => allTraders.set(t.address, t))
      console.log(`  第${pageNum}页: ${traders.length} 个, 新增 ${allTraders.size - before}, 累计 ${allTraders.size}`)
    }

    console.log(`\n📊 共获取 ${allTraders.size} 个交易员数据`)

  } finally {
    await browser.close()
  }

  return Array.from(allTraders.values()).map((t, idx) => ({
    traderId: t.address,
    nickname: t.address,
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
  console.log(`GMX 数据抓取 - ${period}`)
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
