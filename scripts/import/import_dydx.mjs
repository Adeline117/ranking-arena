/**
 * dYdX DEX 排行榜数据抓取
 *
 * URL: https://trade.dydx.exchange/rankings
 *
 * dYdX v4 没有公开的排行榜 API，需要通过 Puppeteer 抓取
 *
 * 用法: node scripts/import/import_dydx.mjs [30D|90D|ALL]
 */
import 'dotenv/config'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { createClient } from '@supabase/supabase-js'

puppeteer.use(StealthPlugin())

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) { console.error('Missing env'); process.exit(1) }
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const SOURCE = 'dydx'
const TARGET_COUNT = 100
// 使用更具体的排行榜 URL
const RANKINGS_URLS = {
  '7D': 'https://trade.dydx.exchange/rankings/pnl-percent',
  '30D': 'https://trade.dydx.exchange/rankings/pnl-percent',
  '90D': 'https://trade.dydx.exchange/rankings/pnl-absolute'
}

const clip = (v, min, max) => Math.max(min, Math.min(max, v))
const safeLog1p = x => x <= -1 ? 0 : Math.log(1 + x)

function calculateArenaScore(roi, pnl, maxDrawdown, winRate, period) {
  const params = { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 }
  const days = period === '7D' ? 7 : period === '30D' ? 30 : 90
  const wr = winRate !== null ? (winRate <= 1 ? winRate * 100 : winRate) : null
  const intensity = (365 / days) * safeLog1p((roi || 0) / 100)
  const r0 = Math.tanh(params.tanhCoeff * intensity)
  const returnScore = r0 > 0 ? clip(85 * Math.pow(r0, params.roiExponent), 0, 85) : 0
  const drawdownScore = maxDrawdown !== null ? clip(8 * clip(1 - Math.abs(maxDrawdown) / params.mddThreshold, 0, 1), 0, 8) : 4
  const stabilityScore = wr !== null ? clip(7 * clip((wr - 45) / (params.winRateCap - 45), 0, 1), 0, 7) : 3.5
  return Math.round((returnScore + drawdownScore + stabilityScore) * 100) / 100
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getTargetPeriods() {
  const arg = process.argv[2]?.toUpperCase()
  if (arg === 'ALL') return ['30D', '90D']
  if (arg && ['7D', '30D', '90D'].includes(arg)) return [arg]
  return ['30D', '90D']
}

async function fetchLeaderboardData(browser, period) {
  const rankingsUrl = RANKINGS_URLS[period] || RANKINGS_URLS['30D']
  console.log('\n=== 抓取 dYdX ' + period + ' ===')
  console.log('  URL: ' + rankingsUrl)

  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

  const traders = new Map()

  // 监听 API 响应 - 拦截所有 indexer API 调用
  page.on('response', async (response) => {
    const url = response.url()
    // 拦截所有可能的 API: indexer, rankings, leaderboard, pnl, subaccount
    if (url.includes('indexer.dydx') || url.includes('rankings') || url.includes('leaderboard') ||
        url.includes('pnl') || url.includes('league') || url.includes('affiliate') ||
        url.includes('subaccount') || url.includes('historicalPnl')) {
      try {
        const contentType = response.headers()['content-type'] || ''
        if (!contentType.includes('json')) return

        const json = await response.json()
        console.log('  📡 API 拦截: ' + url.split('?')[0].split('/').slice(-2).join('/'))

        // 处理各种可能的数据结构
        let list = []
        if (Array.isArray(json)) {
          list = json
        } else if (json.data && Array.isArray(json.data)) {
          list = json.data
        } else if (json.results && Array.isArray(json.results)) {
          list = json.results
        } else if (json.leaderboard && Array.isArray(json.leaderboard)) {
          list = json.leaderboard
        } else if (json.rankings && Array.isArray(json.rankings)) {
          list = json.rankings
        }

        if (list.length > 0) {
          console.log('    获取到 ' + list.length + ' 条数据')

          // 打印第一条数据结构
          if (list[0]) {
            console.log('    字段: ' + Object.keys(list[0]).join(', '))
          }

          list.forEach((item, idx) => {
            const traderId = String(item.address || item.subaccountId || item.wallet || item.id || '')
            if (!traderId || traderId === 'undefined' || traders.has(traderId)) return

            // 提取 ROI (百分比 PnL)
            let roi = parseFloat(item.pnlPercent || item.percentPnl || item.roi || item.pnlPercentage || 0)
            // 如果是小数形式，转换为百分比
            if (Math.abs(roi) < 10 && roi !== 0) roi *= 100

            const pnl = parseFloat(item.pnl || item.totalPnl || item.profit || 0)

            traders.set(traderId, {
              traderId,
              nickname: traderId.slice(0, 6) + '...' + traderId.slice(-4),
              roi,
              pnl,
              winRate: null,
              maxDrawdown: null,
              followers: 0
            })
          })

          console.log('    累计: ' + traders.size + ' 个')
        }
      } catch (e) {
        // 忽略非 JSON 响应
      }
    }
  })

  try {
    await page.goto(rankingsUrl, { waitUntil: 'networkidle0', timeout: 60000 })
    await sleep(5000)

    console.log('  API 拦截到: ' + traders.size + ' 个')

    // 尝试切换时间周期
    const periodLabels = {
      '7D': ['7D', '7 Days', 'Weekly', '周'],
      '30D': ['30D', '30 Days', 'Monthly', '月'],
      '90D': ['90D', 'All Time', 'All', '全部', '90 Days']
    }

    const labels = periodLabels[period] || periodLabels['30D']
    for (const label of labels) {
      const clicked = await page.evaluate((targetLabel) => {
        const elements = document.querySelectorAll('button, [role="tab"], [class*="tab"], span, div')
        for (const el of elements) {
          const text = (el.innerText || el.textContent || '').trim()
          if (text === targetLabel || text.includes(targetLabel)) {
            try { el.click(); return true } catch { return false }
          }
        }
        return false
      }, label)

      if (clicked) {
        console.log('  切换到: ' + label)
        await sleep(3000)
        break
      }
    }

    // 滚动加载更多
    console.log('  滚动加载...')
    for (let i = 0; i < 10; i++) {
      if (traders.size >= TARGET_COUNT) break

      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight)
      })
      await sleep(2000)

      console.log('    滚动 ' + (i + 1) + ': ' + traders.size + ' 个')
    }

    // 从 DOM 提取数据（备用）
    if (traders.size < 10) {
      console.log('  从 DOM 提取数据...')

      const domData = await page.evaluate(() => {
        const results = []
        const seen = new Set()

        // 查找包含地址和百分比的行
        document.querySelectorAll('tr, [class*="row"], [class*="item"], [class*="trader"], [class*="rank"]').forEach(row => {
          const text = row.innerText || ''

          // 匹配 dYdX 地址格式 (dydx1...) 或 以太坊地址格式 (0x...)
          const dydxMatch = text.match(/dydx1[a-z0-9]{38,}/)
          const ethMatch = text.match(/0x[a-fA-F0-9]{40}/)
          const addrMatch = dydxMatch || ethMatch
          if (!addrMatch) return

          const address = addrMatch[0].toLowerCase()
          if (seen.has(address)) return
          seen.add(address)

          // 匹配百分比
          const pctMatch = text.match(/([+-]?\d+\.?\d*)\s*%/)
          const roi = pctMatch ? parseFloat(pctMatch[1]) : 0

          // 匹配 PnL 金额
          const pnlMatch = text.match(/\$([+-]?\d+(?:,\d{3})*(?:\.\d+)?)/i)
          const pnl = pnlMatch ? parseFloat(pnlMatch[1].replace(/,/g, '')) : 0

          results.push({
            traderId: address,
            nickname: address.slice(0, 6) + '...' + address.slice(-4),
            roi,
            pnl
          })
        })

        return results
      })

      console.log('    DOM 提取: ' + domData.length + ' 条')

      for (const item of domData) {
        if (!traders.has(item.traderId)) {
          traders.set(item.traderId, {
            ...item,
            winRate: null,
            maxDrawdown: null,
            followers: 0
          })
        }
      }
    }

    // 截图调试
    await page.screenshot({ path: `/tmp/dydx_${period}_${Date.now()}.png`, fullPage: true })

  } catch (e) {
    console.error('  错误:', e.message)
  } finally {
    await page.close()
  }

  return Array.from(traders.values())
}

async function saveTraders(traders, period) {
  if (traders.length === 0) {
    console.log('  无数据保存')
    return 0
  }

  console.log('\n💾 保存 ' + traders.length + ' 个交易员...')

  // 排序
  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  const top100 = traders.slice(0, TARGET_COUNT)
  const capturedAt = new Date().toISOString()

  // 批量 upsert trader_sources
  await supabase.from('trader_sources').upsert(
    top100.map(t => ({
      source: SOURCE,
      source_type: 'leaderboard',
      source_trader_id: t.traderId,
      handle: t.nickname,
      profile_url: 'https://trade.dydx.exchange/portfolio/' + t.traderId,
      is_active: true
    })),
    { onConflict: 'source,source_trader_id' }
  )

  // 批量 insert trader_snapshots
  const snapshotsData = top100.map((t, idx) => ({
    source: SOURCE,
    source_trader_id: t.traderId,
    season_id: period,
    rank: idx + 1,
    roi: t.roi,
    pnl: t.pnl,
    win_rate: t.winRate,
    max_drawdown: t.maxDrawdown,
    followers: t.followers,
    arena_score: calculateArenaScore(t.roi, t.pnl, t.maxDrawdown, t.winRate, period),
    captured_at: capturedAt
  }))

  const { error } = await supabase.from('trader_snapshots').insert(snapshotsData)

  if (error) {
    console.log('  ⚠ 批量保存失败: ' + error.message)
    // 逐条插入
    let saved = 0
    for (const s of snapshotsData) {
      const { error: e } = await supabase.from('trader_snapshots').insert(s)
      if (!e) saved++
    }
    return saved
  }

  console.log('  ✓ 保存成功: ' + top100.length)
  return top100.length
}

async function main() {
  const periods = getTargetPeriods()
  const totalStartTime = Date.now()

  console.log('\n' + '='.repeat(50))
  console.log('dYdX 排行榜数据抓取')
  console.log('='.repeat(50))
  console.log('时间:', new Date().toISOString())
  console.log('目标周期:', periods.join(', '))
  console.log('='.repeat(50))

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080'
    ]
  })

  const results = []

  try {
    for (const period of periods) {
      console.log('\n' + '='.repeat(50))
      console.log('📊 开始抓取 ' + period + '...')
      console.log('='.repeat(50))

      const traders = await fetchLeaderboardData(browser, period)

      if (traders.length === 0) {
        console.log('\n⚠ ' + period + ' 未获取到数据，跳过')
        continue
      }

      // 排序并显示 TOP 5
      traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))

      console.log('\n📋 ' + period + ' TOP 5:')
      traders.slice(0, 5).forEach((t, i) => {
        console.log('  ' + (i + 1) + '. ' + t.nickname + ': ROI ' + (t.roi?.toFixed(2) || 0) + '%, PnL $' + (t.pnl?.toFixed(0) || 0))
      })

      const saved = await saveTraders(traders, period)
      results.push({ period, count: traders.length, saved, topRoi: traders[0]?.roi || 0 })

      console.log('\n✅ ' + period + ' 完成！')

      if (periods.indexOf(period) < periods.length - 1) {
        await sleep(5000)
      }
    }
  } finally {
    await browser.close()
  }

  const totalTime = ((Date.now() - totalStartTime) / 1000).toFixed(1)

  console.log('\n' + '='.repeat(60))
  console.log('✅ 全部完成！')
  console.log('='.repeat(60))
  console.log('📊 抓取结果:')
  for (const r of results) {
    console.log('   ' + r.period + ': ' + r.saved + ' 条, TOP ROI ' + (r.topRoi?.toFixed?.(2) || r.topRoi) + '%')
  }
  console.log('   总耗时: ' + totalTime + 's')
  console.log('='.repeat(60))
}

main().catch(console.error)
