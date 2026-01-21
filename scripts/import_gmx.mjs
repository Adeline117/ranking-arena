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

// Arena Score 计算逻辑
const ARENA_CONFIG = {
  PARAMS: {
    '7D': { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
    '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
    '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
  },
  MAX_RETURN_SCORE: 85, MAX_DRAWDOWN_SCORE: 8, MAX_STABILITY_SCORE: 7,
}
const clip = (v, min, max) => Math.max(min, Math.min(max, v))
const safeLog1p = x => x <= -1 ? 0 : Math.log(1 + x)
const getPeriodDays = p => p === '7D' ? 7 : p === '30D' ? 30 : 90

function calculateArenaScore(roi, pnl, maxDrawdown, winRate, period) {
  const params = ARENA_CONFIG.PARAMS[period] || ARENA_CONFIG.PARAMS['90D']
  const days = getPeriodDays(period)
  const wr = winRate !== null && winRate !== undefined ? (winRate <= 1 ? winRate * 100 : winRate) : null
  const intensity = (365 / days) * safeLog1p(roi / 100)
  const r0 = Math.tanh(params.tanhCoeff * intensity)
  const returnScore = r0 > 0 ? clip(ARENA_CONFIG.MAX_RETURN_SCORE * Math.pow(r0, params.roiExponent), 0, 85) : 0
  const drawdownScore = maxDrawdown !== null ? clip(ARENA_CONFIG.MAX_DRAWDOWN_SCORE * clip(1 - Math.abs(maxDrawdown) / params.mddThreshold, 0, 1), 0, 8) : 4
  const stabilityScore = wr !== null ? clip(ARENA_CONFIG.MAX_STABILITY_SCORE * clip((wr - 45) / (params.winRateCap - 45), 0, 1), 0, 7) : 3.5
  return Math.round((returnScore + drawdownScore + stabilityScore) * 100) / 100
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getTargetPeriods() {
  const arg = process.argv[2]?.toUpperCase()
  if (arg === 'ALL') return ['7D', '30D'] // GMX 只有 7D 和 30D
  if (arg && ['7D', '30D'].includes(arg)) return [arg]
  return ['7D', '30D'] // 默认抓取所有时间段
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
          // 提取 ROI (百分比)
          const roiMatch = text.match(/([+-])\s*([\d,]+\.\d+)\s*%/)
          // 提取 PnL (金额，通常是 $xxx 格式)
          const pnlMatch = text.match(/\$\s*([+-]?[\d,]+\.?\d*)/)

          if (addrMatch && roiMatch) {
            const roi = parseFloat(roiMatch[2].replace(/,/g, '')) * (roiMatch[1] === '-' ? -1 : 1)
            let pnl = null
            if (pnlMatch) {
              pnl = parseFloat(pnlMatch[1].replace(/,/g, ''))
            }
            results.push({ address: addrMatch[0], roi, pnl })
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
    pnl: t.pnl,  // 从页面提取的 PnL，可能为 null
    winRate: null,      // GMX 不提供胜率
    maxDrawdown: null,  // GMX 不提供最大回撤
    followers: null,    // GMX 无跟单功能
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
        pnl: trader.pnl,  // 可能为 null
        win_rate: null,   // GMX 不提供
        max_drawdown: null,  // GMX 不提供
        followers: null,  // GMX 无跟单功能
        arena_score: calculateArenaScore(trader.roi, trader.pnl, null, null, period),
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
  console.log(`GMX 数据抓取`)
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
