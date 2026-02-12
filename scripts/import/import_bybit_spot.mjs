/**
 * Bybit Copy Trading 排行榜数据抓取 — Spot 标签
 *
 * Bybit 的跟单页面 (/copyTrade/) 只有 Classic (合约) 和 TradFi 两种，
 * 没有独立的 Spot 跟单排行榜。本脚本直接调用 Bybit 内部 API
 * (dynamic-leader-list) 拉取全量交易员数据，标记为 bybit_spot。
 *
 * API 关键参数：
 *   - pageNo / pageSize（最大 50）
 *   - dataDuration: DATA_DURATION_SEVEN_DAY / THIRTY_DAY / NINETY_DAY
 *   - sortField: LEADER_SORT_FIELD_SORT_ROI
 *   - metricValues[]: [ROI, Drawdown, followerProfit, WinRate, PLRatio, SharpeRatio]
 *
 * 用法: node scripts/import/import_bybit_spot.mjs [7D|30D|90D|ALL]
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

const SOURCE = 'bybit_spot'
const BASE_URL = 'https://www.bybit.com/copyTrade/'
const API_PATH = '/x-api/fapi/beehive/public/v1/common/dynamic-leader-list'
const TARGET_COUNT = 500
const PAGE_SIZE = 50 // API max
const PROXY = process.env.HTTP_PROXY || process.env.https_proxy || (process.platform === 'darwin' ? 'http://127.0.0.1:7890' : '')

const PERIOD_MAP = {
  '7D': 'DATA_DURATION_SEVEN_DAY',
  '30D': 'DATA_DURATION_THIRTY_DAY',
  '90D': 'DATA_DURATION_NINETY_DAY',
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function parsePercent(s) {
  if (!s) return null
  const m = String(s).replace(/,/g, '').match(/([+-]?)(\d+(?:\.\d+)?)%?/)
  if (!m) return null
  const sign = m[1] === '-' ? -1 : 1
  return parseFloat(m[2]) * sign
}

function parseNumber(s) {
  if (!s) return null
  const cleaned = String(s).replace(/[^0-9.\-+]/g, '')
  const v = parseFloat(cleaned)
  return isNaN(v) ? null : v
}

// ---------------------------------------------------------------------------
// main fetch
// ---------------------------------------------------------------------------

async function fetchLeaderboardData(period) {
  console.log(`\n=== 抓取 Bybit Spot ${period} 排行榜 ===`)
  console.log('时间:', new Date().toISOString())
  console.log(`目标: ${TARGET_COUNT} 个交易员`)

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      ...(PROXY ? [`--proxy-server=${PROXY}`] : []),
    ],
    timeout: 60000,
  })

  const allTraders = []

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    )
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
    })

    // 1) 先加载页面以获取 cookies / session
    console.log('\n📱 加载 Bybit 跟单页面 (获取 session)...')
    try {
      await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 60000 })
    } catch {
      console.log('  ⚠ 加载超时，继续...')
    }
    await sleep(3000)

    // 关闭弹窗
    await page.evaluate(() => {
      document.querySelectorAll('button, div, span').forEach((el) => {
        const t = (el.textContent || '').toLowerCase()
        if (
          t.includes("don't live") || t.includes('confirm') ||
          t.includes('got it') || t.includes('close') ||
          t.includes('ok') || t.includes('accept')
        ) {
          try { el.click() } catch {}
        }
      })
    }).catch(() => {})
    await sleep(1000)

    // 2) 直接调用 API 拉取分页数据
    const duration = PERIOD_MAP[period] || PERIOD_MAP['30D']
    const maxPages = Math.ceil(TARGET_COUNT / PAGE_SIZE)
    console.log(`\n📡 调用 API (duration=${duration}, pageSize=${PAGE_SIZE})`)

    const seenIds = new Set()

    for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
      const url =
        `${API_PATH}?pageNo=${pageNo}&pageSize=${PAGE_SIZE}` +
        `&dataDuration=${duration}` +
        `&sortField=LEADER_SORT_FIELD_SORT_ROI`

      const result = await page.evaluate(async (apiUrl) => {
        try {
          const resp = await fetch(apiUrl)
          return await resp.json()
        } catch (e) {
          return { error: e.message }
        }
      }, url)

      if (result.error) {
        console.log(`  ⚠ Page ${pageNo} fetch error: ${result.error}`)
        break
      }

      const details = result?.result?.leaderDetails || []
      if (details.length === 0) {
        console.log(`  页 ${pageNo}: 无数据，停止`)
        break
      }

      let newCount = 0
      for (const item of details) {
        const id = String(item.leaderUserId || item.leaderMark || '')
        if (!id || seenIds.has(id)) continue
        seenIds.add(id)

        // metricValues: [ROI, Drawdown, followerProfit, WinRate, PLRatio, SharpeRatio]
        const mv = item.metricValues || []

        allTraders.push({
          traderId: id,
          nickname: item.nickName || null,
          avatar: item.profilePhoto || null,
          roi: parsePercent(mv[0]) || 0,
          maxDrawdown: parsePercent(mv[1]) || 0,
          pnl: parseNumber(mv[2]) || 0, // follower profit (closest to PnL available)
          winRate: parsePercent(mv[3]) || 0,
          followers: parseInt(item.currentFollowerCount || 0),
        })
        newCount++
      }

      console.log(
        `  页 ${pageNo}: ${details.length} 条, 新增 ${newCount}, 累计 ${allTraders.length}`
      )

      if (allTraders.length >= TARGET_COUNT) break
      await sleep(800) // 节流
    }

    console.log(`\n📊 共获取 ${allTraders.length} 个交易员数据`)
  } finally {
    await browser.close()
  }

  return allTraders
}

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

async function saveTradersBatch(traders, period) {
  console.log(`\n💾 批量保存 ${traders.length} 个交易员...`)

  const capturedAt = new Date().toISOString()

  // trader_sources
  const sourcesData = traders.map((t) => ({
    source: SOURCE,
    source_type: 'leaderboard',
    source_trader_id: t.traderId,
    handle: t.nickname,
    avatar_url: t.avatar || null,
    is_active: true,
  }))

  await supabase
    .from('trader_sources')
    .upsert(sourcesData, { onConflict: 'source,source_trader_id' })

  // trader_snapshots
  const snapshotsData = traders.map((t, idx) => {
    const wr =
      t.winRate !== null && t.winRate !== undefined
        ? t.winRate <= 1
          ? t.winRate * 100
          : t.winRate
        : null
    const { totalScore: arenaScore } = calculateArenaScore(
      t.roi || 0,
      t.pnl,
      t.maxDrawdown,
      wr,
      period
    )

    return {
      source: SOURCE,
      source_trader_id: t.traderId,
      season_id: period,
      rank: idx + 1,
      roi: t.roi || 0,
      pnl: t.pnl || null,
      win_rate: wr,
      max_drawdown: t.maxDrawdown || null,
      followers: t.followers || null,
      arena_score: arenaScore,
      captured_at: capturedAt,
    }
  })

  const { error } = await supabase
    .from('trader_snapshots')
    .upsert(snapshotsData, {
      onConflict: 'source,source_trader_id,season_id',
    })

  if (error) {
    console.log(`  ⚠ 批量保存失败: ${error.message}`)
    let saved = 0
    for (const s of snapshotsData) {
      const { error: e } = await supabase
        .from('trader_snapshots')
        .upsert(s, { onConflict: 'source,source_trader_id,season_id' })
      if (!e) saved++
    }
    console.log(`  逐条保存: ${saved}/${snapshotsData.length}`)
    return saved
  }

  console.log(`  ✓ 保存成功: ${snapshotsData.length} 条`)
  return snapshotsData.length
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const periods = getTargetPeriods()
  const totalStartTime = Date.now()

  console.log(`\n========================================`)
  console.log(`Bybit Spot 数据抓取 (API 直调)`)
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
    const top = traders.slice(0, TARGET_COUNT)

    console.log(`\n📋 ${period} TOP 10:`)
    top.slice(0, 10).forEach((t, idx) => {
      console.log(
        `  ${idx + 1}. ${t.nickname || t.traderId}: ROI ${t.roi?.toFixed(2)}% | WR ${t.winRate?.toFixed(1)}% | DD ${t.maxDrawdown?.toFixed(1)}%`
      )
    })

    const saved = await saveTradersBatch(top, period)
    results.push({
      period,
      count: traders.length,
      saved,
      topRoi: top[0]?.roi || 0,
    })

    console.log(`\n✅ ${period} 完成！保存了 ${saved} 条数据`)

    if (periods.indexOf(period) < periods.length - 1) {
      console.log(`\n⏳ 等待 3 秒后抓取下一个时间段...`)
      await sleep(3000)
    }
  }

  const totalTime = ((Date.now() - totalStartTime) / 1000).toFixed(1)

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ 全部完成！`)
  console.log(`${'='.repeat(60)}`)
  console.log(`📊 抓取结果:`)
  for (const r of results) {
    console.log(
      `   ${r.period}: ${r.saved} 条, TOP ROI ${r.topRoi?.toFixed(2)}%`
    )
  }
  console.log(`   总耗时: ${totalTime}s`)
  console.log(`${'='.repeat(60)}`)
}

main()
