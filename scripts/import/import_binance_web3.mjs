/**
 * Binance Web3 排行榜数据抓取
 * 
 * 使用 Playwright 抓取 Binance Web3 链上排行榜
 * 
 * 用法: node scripts/import_binance_web3.mjs [7D|30D|90D]
 * 
 * 数据源: https://web3.binance.com/zh-CN/leaderboard?chain=bsc
 */

import 'dotenv/config'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const SOURCE = 'binance_web3'
const BASE_URL = 'https://web3.binance.com/zh-CN/leaderboard?chain=bsc'

const PERIOD_CONFIG = {
  '7D': { tabTexts: ['7天', '7 Days', '7D', '7日'], urlParam: '7d' },
  '30D': { tabTexts: ['30天', '30 Days', '30D', '1月', '一月'], urlParam: '30d' },
  '90D': { tabTexts: ['90天', '90 Days', '90D', '3月', '三月'], urlParam: '90d' },
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
  if (arg === 'ALL') return ['7D', '30D', '90D']
  if (arg && ['7D', '30D', '90D'].includes(arg)) return [arg]
  return ['7D', '30D', '90D'] // 默认抓取所有时间段
}

async function fetchLeaderboardData(period) {
  console.log(`\n=== 抓取 Binance Web3 ${period} 排行榜 ===`)
  console.log('时间:', new Date().toISOString())
  console.log('URL:', BASE_URL)

  const traders = new Map()
  const apiResponses = []

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--no-sandbox'],
  })

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    })

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      window.chrome = { runtime: {} }
    })

    const page = await context.newPage()
    const config = PERIOD_CONFIG[period]

    // 监听 API 响应
    page.on('response', async (response) => {
      const url = response.url()
      if (url.includes('leaderboard') || url.includes('ranking') || url.includes('top')) {
        try {
          const json = await response.json()
          if (json.data && Array.isArray(json.data)) {
            console.log(`  📡 拦截到 API: ${json.data.length} 条数据`)
            apiResponses.push({ url, list: json.data })
          } else if (json.list && Array.isArray(json.list)) {
            console.log(`  📡 拦截到 API: ${json.list.length} 条数据`)
            apiResponses.push({ url, list: json.list })
          }
        } catch (e) {}
      }
    })

    console.log('📱 访问页面...')
    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
    } catch (e) {
      console.log('  ⚠ 页面加载超时，继续尝试...')
    }
    await sleep(5000)

    // 尝试点击时间周期 tab
    console.log(`🔄 切换到 ${period} 时间周期...`)
    for (const tabText of config.tabTexts) {
      try {
        const selectors = [
          `button:has-text("${tabText}")`,
          `[role="tab"]:has-text("${tabText}")`,
          `div:has-text("${tabText}")`,
          `span:has-text("${tabText}")`,
        ]
        for (const selector of selectors) {
          const element = await page.$(selector)
          if (element) {
            await element.click()
            console.log(`  ✓ 点击成功: "${tabText}"`)
            await sleep(3000)
            break
          }
        }
      } catch (e) {}
    }

    // 滚动加载更多
    console.log('📜 滚动加载更多数据...')
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollBy(0, 600))
      await sleep(500)
    }
    await sleep(2000)

    // 处理 API 响应
    console.log(`\n📊 处理 ${apiResponses.length} 个 API 响应...`)
    for (const { list } of apiResponses) {
      list.forEach((item, idx) => {
        const traderId = String(item.address || item.wallet || item.id || '')
        if (!traderId) return
        
        const existing = traders.get(traderId)
        const roi = parseFloat(item.roi ?? item.pnlPct ?? item.returnRate ?? 0)
        
        if (!existing || roi > existing.roi) {
          traders.set(traderId, {
            traderId,
            nickname: item.name || item.nickname || traderId.slice(0, 10) + '...',
            avatar: item.avatar || null,
            roi,
            pnl: parseFloat(item.pnl ?? item.profit ?? 0),
            winRate: parseFloat(item.winRate ?? 0),
            maxDrawdown: parseFloat(item.mdd ?? item.maxDrawdown ?? 0),
            followers: parseInt(item.followers ?? 0),
            rank: idx + 1,
          })
        }
      })
    }

    // 如果没有 API 数据，从 DOM 提取
    if (traders.size === 0) {
      console.log('📊 从页面 DOM 提取数据...')
      const pageTraders = await page.evaluate(() => {
        const results = []
        const seen = new Set()
        
        // 查找表格行或卡片
        const rows = document.querySelectorAll('tr, [class*="item"], [class*="row"], [class*="card"]')
        
        rows.forEach((row, idx) => {
          const text = row.innerText || ''
          
          // 查找钱包地址（0x 开头的地址）
          const addressMatch = text.match(/0x[a-fA-F0-9]{6,40}/)
          const traderId = addressMatch?.[0]
          
          if (!traderId || seen.has(traderId)) return
          seen.add(traderId)
          
          // 提取 ROI/PnL%
          const roiMatches = text.match(/([+-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*%/g)
          let roi = null
          if (roiMatches) {
            for (const match of roiMatches) {
              const val = parseFloat(match.replace(/[^0-9.+-]/g, ''))
              if (roi === null || Math.abs(val) > Math.abs(roi)) roi = val
            }
          }
          
          if (traderId && roi !== null) {
            results.push({
              traderId,
              nickname: traderId.slice(0, 10) + '...',
              avatar: null,
              roi,
              pnl: null,
              winRate: null,
              maxDrawdown: null,
              followers: null,
              rank: results.length + 1,
            })
          }
        })
        
        return results
      })
      
      pageTraders.forEach(t => {
        if (!traders.has(t.traderId)) traders.set(t.traderId, t)
      })
    }

    console.log(`\n📊 共获取 ${traders.size} 个交易员数据`)

    if (traders.size === 0) {
      const screenshotPath = `/tmp/binance_web3_${period}_${Date.now()}.png`
      await page.screenshot({ path: screenshotPath, fullPage: true })
      console.log(`  📸 截图保存到: ${screenshotPath}`)
    }
  } finally {
    await browser.close()
  }

  return Array.from(traders.values())
}

async function saveTraders(traders, period) {
  console.log(`\n💾 保存 ${traders.length} 个交易员到数据库 (${SOURCE} - ${period})...`)
  
  const capturedAt = new Date().toISOString()
  let saved = 0
  let errors = 0

  for (const trader of traders) {
    try {
      await supabase.from('trader_sources').insert({
        source: SOURCE,
        source_type: 'leaderboard',
        source_trader_id: trader.traderId,
        handle: trader.nickname,
        profile_url: trader.avatar,
        is_active: true,
      }, { onConflict: 'source,source_trader_id' })

      const normalizedWr = trader.winRate !== null ? (trader.winRate <= 1 ? trader.winRate * 100 : trader.winRate) : null
      const { error } = await supabase.from('trader_snapshots').insert({
        source: SOURCE,
        source_trader_id: trader.traderId,
        season_id: period,
        rank: trader.rank,
        roi: trader.roi,
        pnl: trader.pnl,
        win_rate: normalizedWr,
        max_drawdown: trader.maxDrawdown,
        followers: trader.followers || 0,
        arena_score: calculateArenaScore(trader.roi, trader.pnl, trader.maxDrawdown, normalizedWr, period),
        captured_at: capturedAt,
      })

      if (error) errors++
      else saved++
    } catch (error) {
      errors++
    }
  }

  console.log(`  ✓ 保存成功: ${saved}`)
  if (errors > 0) console.log(`  ✗ 保存失败: ${errors}`)

  return { saved, errors }
}

async function main() {
  const periods = getTargetPeriods()
  const totalStartTime = Date.now()
  
  console.log(`\n========================================`)
  console.log(`Binance Web3 排行榜数据抓取`)
  console.log(`目标周期: ${periods.join(', ')}`)
  console.log(`数据源: ${SOURCE}`)
  console.log(`========================================`)

  const results = []

  try {
    for (const period of periods) {
      console.log(`\n${'='.repeat(50)}`)
      console.log(`📊 开始抓取 ${period} 排行榜...`)
      console.log(`${'='.repeat(50)}`)
      
      const traders = await fetchLeaderboardData(period)

      if (traders.length === 0) {
        console.log(`\n⚠ ${period} 未获取到任何数据，跳过`)
        continue
      }

      traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
      traders.forEach((t, idx) => t.rank = idx + 1)

      console.log(`\n📋 ${period} TOP 10:`)
      traders.slice(0, 10).forEach((t, idx) => {
        console.log(`  ${idx + 1}. ${t.nickname || t.traderId}: ROI ${t.roi?.toFixed(2)}%`)
      })

      const result = await saveTraders(traders, period)
      results.push({ period, count: traders.length, saved: result.saved, topRoi: traders[0]?.roi || 0 })
      
      console.log(`\n✅ ${period} 完成！保存了 ${result.saved} 条数据`)
      
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
      console.log(`   ${r.period}: ${r.saved} 条, TOP ROI ${r.topRoi?.toFixed(2)}%`)
    }
    console.log(`   总耗时: ${totalTime}s`)
    console.log(`${'='.repeat(60)}`)
  } catch (error) {
    console.error('\n❌ 执行失败:', error.message)
  }
}

main()
