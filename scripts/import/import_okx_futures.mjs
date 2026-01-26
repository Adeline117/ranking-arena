/**
 * OKX Futures Copy Trading 排行榜数据抓取
 *
 * 使用 OKX 公开 API 获取交易员数据
 *
 * 用法: node scripts/import/import_okx_futures.mjs [7D|30D|90D|ALL]
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const SOURCE = 'okx_futures'
const TARGET_COUNT = 100

// ============================================
// Arena Score 计算逻辑
// ============================================

const ARENA_CONFIG = {
  PARAMS: {
    '7D': { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
    '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
    '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
  },
  MAX_RETURN_SCORE: 85,
  MAX_DRAWDOWN_SCORE: 8,
  MAX_STABILITY_SCORE: 7,
}

const clip = (v, min, max) => Math.max(min, Math.min(max, v))
const safeLog1p = x => x <= -1 ? 0 : Math.log(1 + x)
const getPeriodDays = p => p === '7D' ? 7 : p === '30D' ? 30 : 90

function calculateArenaScore(roi, pnl, maxDrawdown, winRate, period) {
  const params = ARENA_CONFIG.PARAMS[period] || ARENA_CONFIG.PARAMS['90D']
  const days = getPeriodDays(period)

  const wr = winRate !== null && winRate !== undefined
    ? (winRate <= 1 ? winRate * 100 : winRate)
    : null

  const intensity = (365 / days) * safeLog1p(roi / 100)
  const r0 = Math.tanh(params.tanhCoeff * intensity)
  const returnScore = r0 > 0 ? clip(ARENA_CONFIG.MAX_RETURN_SCORE * Math.pow(r0, params.roiExponent), 0, 85) : 0

  const drawdownScore = maxDrawdown !== null && maxDrawdown !== undefined
    ? clip(ARENA_CONFIG.MAX_DRAWDOWN_SCORE * clip(1 - Math.abs(maxDrawdown) / params.mddThreshold, 0, 1), 0, 8)
    : 4

  const stabilityScore = wr !== null
    ? clip(ARENA_CONFIG.MAX_STABILITY_SCORE * clip((wr - 45) / (params.winRateCap - 45), 0, 1), 0, 7)
    : 3.5

  return Math.round((returnScore + drawdownScore + stabilityScore) * 100) / 100
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getTargetPeriods() {
  const arg = process.argv[2]?.toUpperCase()
  if (arg === 'ALL') return ['7D', '30D', '90D']
  if (arg && ['7D', '30D', '90D'].includes(arg)) return [arg]
  return ['30D', '90D']
}

/**
 * 从 OKX API 获取排行榜数据
 */
async function fetchLeaderboardData(period) {
  console.log(`\n=== 抓取 OKX Futures ${period} 排行榜 ===`)
  console.log('时间:', new Date().toISOString())

  const allTraders = []

  // OKX Copy Trading API
  // 文档: https://www.okx.com/docs-v5/en/#rest-api-copy-trading
  // sortType: 0=综合排名, 1=收益率, 2=收益额, 3=跟单人数, 4=AUM, 5=胜率
  // period: 7d, 30d, 90d, 180d, all

  const periodMap = {
    '7D': '7d',
    '30D': '30d',
    '90D': '90d'
  }

  const okxPeriod = periodMap[period] || '90d'

  try {
    // OKX 公开 API - 获取 lead trader 排行
    const apiUrl = `https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP&sortType=1&state=1&limit=100`

    console.log(`📡 调用 OKX API...`)

    const response = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    })

    if (!response.ok) {
      console.log(`  ⚠ API 响应错误: ${response.status}`)
      return []
    }

    const json = await response.json()

    if (json.code !== '0') {
      console.log(`  ⚠ API 返回错误: ${json.code} - ${json.msg}`)

      // 尝试备用方法 - 从网页抓取
      console.log('\n📱 尝试从网页抓取...')
      return await fetchFromWebpage(period)
    }

    const traders = json.data || []
    console.log(`  ✓ 获取到 ${traders.length} 个交易员`)

    for (const t of traders) {
      // OKX API 返回格式
      // uniqueCode, nickName, portrait, pnl, pnlRatio, winRatio,
      // copyTraderNum, aum, maxDrawdown

      const roi = parseFloat(t.pnlRatio || 0) * 100  // 转换为百分比
      const winRate = parseFloat(t.winRatio || 0) * 100
      const maxDrawdown = parseFloat(t.maxDrawdown || 0) * 100
      const pnl = parseFloat(t.pnl || 0)

      allTraders.push({
        traderId: t.uniqueCode || t.uniqueName,
        nickname: t.nickName || `OKX_${t.uniqueCode}`,
        avatar: t.portrait || null,
        roi: roi,
        pnl: pnl,
        winRate: winRate,
        maxDrawdown: maxDrawdown,
        followers: parseInt(t.copyTraderNum || 0),
        aum: parseFloat(t.aum || 0),
      })
    }

  } catch (error) {
    console.error('  ⚠ 抓取出错:', error.message)

    // 尝试备用方法
    console.log('\n📱 尝试从网页抓取...')
    return await fetchFromWebpage(period)
  }

  return allTraders
}

/**
 * 备用方法：从网页抓取
 */
async function fetchFromWebpage(period) {
  try {
    const puppeteer = await import('puppeteer-extra')
    const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default
    puppeteer.default.use(StealthPlugin())

    const browser = await puppeteer.default.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })

    const allTraders = []

    try {
      const page = await browser.newPage()
      await page.setViewport({ width: 1920, height: 1080 })

      // 监听 API 响应
      page.on('response', async (response) => {
        const url = response.url()
        if (url.includes('copytrading') && url.includes('lead')) {
          try {
            const json = await response.json()
            const data = json.data || []
            if (Array.isArray(data)) {
              console.log(`  📡 拦截到 ${data.length} 条数据`)
              for (const t of data) {
                const roi = parseFloat(t.pnlRatio || t.roi || 0) * 100
                allTraders.push({
                  traderId: t.uniqueCode || t.uniqueName || t.uid,
                  nickname: t.nickName || t.name,
                  avatar: t.portrait || t.avatar,
                  roi: roi,
                  pnl: parseFloat(t.pnl || 0),
                  winRate: parseFloat(t.winRatio || t.winRate || 0) * 100,
                  maxDrawdown: parseFloat(t.maxDrawdown || 0) * 100,
                  followers: parseInt(t.copyTraderNum || t.followers || 0),
                })
              }
            }
          } catch {}
        }
      })

      console.log('  访问 OKX Copy Trading 页面...')
      await page.goto('https://www.okx.com/copy-trading/leaderboard', {
        waitUntil: 'networkidle2',
        timeout: 30000
      })

      await sleep(5000)

      // 滚动页面加载更多
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.scrollBy(0, 800))
        await sleep(2000)
      }

    } finally {
      await browser.close()
    }

    return allTraders

  } catch (error) {
    console.error('  网页抓取失败:', error.message)
    return []
  }
}

/**
 * 保存交易员数据
 */
async function saveTraders(traders, period) {
  console.log(`\n💾 保存 ${traders.length} 个交易员 (${period})...`)

  if (traders.length === 0) {
    console.log('  ⚠ 没有数据可保存')
    return 0
  }

  const capturedAt = new Date().toISOString()

  // 按 ROI 排序
  traders.sort((a, b) => b.roi - a.roi)
  const top100 = traders.slice(0, TARGET_COUNT)

  // 保存 trader_sources
  const sourcesData = top100.map(t => ({
    source: SOURCE,
    source_type: 'leaderboard',
    source_trader_id: t.traderId,
    handle: t.nickname,
    profile_url: `https://www.okx.com/copy-trading/account/${t.traderId}`,
    is_active: true,
  }))

  const { error: sourceError } = await supabase
    .from('trader_sources')
    .upsert(sourcesData, { onConflict: 'source,source_trader_id' })

  if (sourceError) {
    console.log(`  ⚠ trader_sources 保存失败: ${sourceError.message}`)
  }

  // 保存 trader_snapshots
  const snapshotsData = top100.map((t, idx) => {
    const arenaScore = calculateArenaScore(t.roi, t.pnl, t.maxDrawdown, t.winRate, period)

    return {
      source: SOURCE,
      source_trader_id: t.traderId,
      season_id: period,
      rank: idx + 1,
      roi: t.roi,
      pnl: t.pnl || null,
      win_rate: t.winRate,
      max_drawdown: t.maxDrawdown || null,
      followers: t.followers || null,
      arena_score: arenaScore,
      captured_at: capturedAt,
    }
  })

  const { error: snapshotError } = await supabase.from('trader_snapshots').insert(snapshotsData)

  if (snapshotError) {
    console.log(`  ⚠ 批量保存失败: ${snapshotError.message}`)
    let saved = 0
    for (const s of snapshotsData) {
      const { error: e } = await supabase.from('trader_snapshots').insert(s)
      if (!e) saved++
    }
    return saved
  }

  console.log(`  ✓ 保存成功: ${snapshotsData.length} 条`)
  return snapshotsData.length
}

async function main() {
  const periods = getTargetPeriods()

  console.log(`\n========================================`)
  console.log(`OKX Futures 数据抓取`)
  console.log(`目标周期: ${periods.join(', ')}`)
  console.log(`========================================`)

  for (const period of periods) {
    const traders = await fetchLeaderboardData(period)

    if (traders.length > 0) {
      console.log(`\n📋 ${period} TOP 5:`)
      traders.slice(0, 5).forEach((t, idx) => {
        console.log(`  ${idx + 1}. ${t.nickname}: ROI ${t.roi?.toFixed(2)}%`)
      })

      await saveTraders(traders, period)
    }

    await sleep(2000)
  }

  console.log(`\n✅ OKX Futures 抓取完成`)
}

main()
