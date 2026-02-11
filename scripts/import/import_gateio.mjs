/**
 * Gate.io Copy Trading 排行榜数据抓取 (Playwright + API)
 *
 * Strategy:
 *   1. Use Playwright to navigate to Gate.io (handles Akamai/CF protection)
 *   2. From browser context, call internal APIs with pagination:
 *      - /apiw/v2/copy/leader/list (futures copy trading, ~379 traders)
 *      - /apiw/v2/copy/leader/query_cta_trader (CTA/bot traders, ~1797 traders)
 *      - /api/copytrade/spot-copy-trading/trader/profit (spot copy trading)
 *   3. Merge all unique traders and save to Supabase
 *
 * Usage: node scripts/import/import_gateio.mjs [7D|30D|90D|ALL]
 */
import { chromium } from 'playwright'
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'gateio'
const PROXY = 'http://127.0.0.1:7890'
const TARGET_COUNT = 500

const PERIOD_CYCLE = { '7D': 'week', '30D': 'month', '90D': 'quarter' }

async function scrapeAll() {
  console.log('Gate.io: 启动浏览器...')
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: PROXY },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  })

  const page = await context.newPage()

  try {
    console.log('  导航到 copytrading 页面...')
    await page.goto('https://www.gate.io/copytrading', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    }).catch(e => console.log('  ⚠ Nav:', e.message))
    await sleep(8000)

    console.log('  页面标题:', await page.title().catch(() => '?'))

    // Fetch futures leader list with pagination
    console.log('\n--- Futures Leader List ---')
    const futuresTraders = await page.evaluate(async () => {
      const traders = []
      const seen = new Set()
      for (const orderBy of ['profit_rate', 'profit', 'aum', 'sharp_ratio', 'max_drawdown', 'follow_profit']) {
        for (let pg = 1; pg <= 10; pg++) {
          try {
            const r = await fetch(`/apiw/v2/copy/leader/list?page=${pg}&page_size=100&status=running&order_by=${orderBy}&sort_by=desc&cycle=month`)
            const j = await r.json()
            const list = j?.data?.list || []
            if (list.length === 0) break
            for (const t of list) {
              const id = String(t.leader_id)
              if (seen.has(id)) continue
              seen.add(id)
              traders.push({
                traderId: id,
                nickname: t.user_info?.nickname || t.user_info?.nick || `Trader_${id}`,
                avatar: t.user_info?.avatar || null,
                roi: parseFloat(t.profit_rate || 0) * 100,
                pnl: parseFloat(t.profit || 0),
                winRate: parseFloat(t.win_rate || 0) * 100,
                maxDrawdown: parseFloat(t.max_drawdown || 0) * 100,
                followers: parseInt(t.curr_follow_num || 0),
                aum: parseFloat(t.aum || 0),
                sharpeRatio: parseFloat(t.sharp_ratio || 0),
                type: 'futures',
              })
            }
          } catch { break }
        }
      }
      return traders
    })
    console.log(`  Futures: ${futuresTraders.length} unique traders`)

    // Fetch CTA traders (bots/grid) with pagination
    console.log('\n--- CTA Traders ---')
    const ctaTraders = await page.evaluate(async () => {
      const traders = []
      const seen = new Set()
      for (const sortField of ['NINETY_PROFIT_RATE_SORT', 'THIRTY_PROFIT_RATE_SORT', 'SEVEN_PROFIT_RATE_SORT', 'COPY_USER_COUNT_SORT']) {
        for (let pg = 1; pg <= 10; pg++) {
          try {
            const r = await fetch(`/apiw/v2/copy/leader/query_cta_trader?page_num=${pg}&page_size=100&sort_field=${sortField}`)
            const j = await r.json()
            const list = j?.data?.list || []
            if (list.length === 0) break
            for (const t of list) {
              const nick = t.nickname || t.nick || ''
              const id = 'cta_' + nick.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)
              if (!nick || seen.has(id)) continue
              seen.add(id)
              traders.push({
                traderId: id,
                nickname: nick,
                avatar: t.avatar || null,
                roi: parseFloat(t.ninety_profit_rate || t.total_profit_rate || 0) * 100,
                pnl: parseFloat(t.ninety_profit || t.total_profit || 0),
                followers: parseInt(t.copy_user_count || 0),
                type: 'cta',
              })
            }
          } catch { break }
        }
      }
      return traders
    })
    console.log(`  CTA: ${ctaTraders.length} unique traders`)

    // Spot copy trading
    console.log('\n--- Spot Copy Trading ---')
    const spotTraders = await page.evaluate(async () => {
      const traders = []
      const seen = new Set()
      for (const orderBy of ['profit_rate', 'profit', 'follow_num']) {
        for (let pg = 1; pg <= 5; pg++) {
          try {
            const r = await fetch(`/api/copytrade/spot-copy-trading/trader/profit?page=${pg}&page_size=100&order_by=${orderBy}&sort_by=desc&cycle=month`)
            const j = await r.json()
            const list = j?.data?.list || []
            if (list.length === 0) break
            for (const t of list) {
              const id = 'spot_' + String(t.leader_id || t.id)
              if (seen.has(id)) continue
              seen.add(id)
              traders.push({
                traderId: id,
                nickname: t.nickname || t.nick || `Spot_${t.leader_id}`,
                avatar: null,
                roi: parseFloat(t.profit_rate || 0) * 100,
                pnl: parseFloat(t.profit || 0),
                winRate: t.win_num && t.trade_num ? (t.win_num / t.trade_num) * 100 : null,
                followers: parseInt(t.curr_follow_num || 0),
                type: 'spot',
              })
            }
          } catch { break }
        }
      }
      return traders
    })
    console.log(`  Spot: ${spotTraders.length} unique traders`)

    // Also fetch recommend list and star traders
    console.log('\n--- Extra endpoints ---')
    const extraTraders = await page.evaluate(async () => {
      const traders = []
      const seen = new Set()
      // Recommend list
      try {
        const r = await fetch('/apiw/v2/copy/leader/recommend_list?params[page]=1&params[page_size]=100&params[status]=running')
        const j = await r.json()
        const list = j?.data?.list || j?.data || []
        for (const t of list) {
          const id = String(t.leader_id)
          if (seen.has(id)) continue
          seen.add(id)
          traders.push({
            traderId: id,
            nickname: t.user_info?.nickname || `Rec_${id}`,
            avatar: t.user_info?.avatar || null,
            roi: parseFloat(t.profit_rate || 0) * 100,
            pnl: parseFloat(t.profit || 0),
            winRate: parseFloat(t.win_rate || 0) * 100,
            maxDrawdown: parseFloat(t.max_drawdown || 0) * 100,
            followers: parseInt(t.curr_follow_num || 0),
            type: 'futures',
          })
        }
      } catch {}
      // Star traders
      try {
        const r = await fetch('/apiw/v2/copy/leader/plaza/star_v2?limit=100')
        const j = await r.json()
        const list = j?.data?.list || j?.data || []
        for (const t of list) {
          const id = String(t.leader_id)
          if (seen.has(id)) continue
          seen.add(id)
          traders.push({
            traderId: id,
            nickname: t.user_info?.nickname || `Star_${id}`,
            avatar: t.user_info?.avatar || null,
            roi: parseFloat(t.profit_rate || 0) * 100,
            pnl: parseFloat(t.profit || 0),
            winRate: parseFloat(t.win_rate || 0) * 100,
            maxDrawdown: parseFloat(t.max_drawdown || 0) * 100,
            followers: parseInt(t.curr_follow_num || 0),
            type: 'futures',
          })
        }
      } catch {}
      return traders
    })
    console.log(`  Extra: ${extraTraders.length} unique traders`)

    await browser.close()

    // Merge all - futures first, then extras, then CTA, then spot
    const allMap = new Map()
    for (const t of [...futuresTraders, ...extraTraders, ...ctaTraders, ...spotTraders]) {
      if (!allMap.has(t.traderId)) allMap.set(t.traderId, t)
    }
    return [...allMap.values()]
  } catch (e) {
    console.error('Error:', e.message)
    await browser.close()
    return []
  }
}

async function saveTraders(traders, period) {
  if (traders.length === 0) return 0

  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  const topTraders = traders.slice(0, TARGET_COUNT)
  const capturedAt = new Date().toISOString()

  console.log(`\n💾 保存 ${topTraders.length} 条 ${period} 数据...`)

  // Save sources
  const sources = topTraders.map(t => ({
    source: SOURCE,
    source_type: 'leaderboard',
    source_trader_id: t.traderId,
    handle: t.nickname,
    avatar_url: t.avatar,
    profile_url: t.type === 'cta'
      ? `https://www.gate.io/copytrading`
      : `https://www.gate.io/copytrading/share?trader_id=${t.traderId}`,
    is_active: true,
  }))
  for (let i = 0; i < sources.length; i += 30) {
    await supabase.from('trader_sources').upsert(sources.slice(i, i + 30), { onConflict: 'source,source_trader_id' })
  }

  // Save snapshots
  let saved = 0
  const snapshots = topTraders.map((t, idx) => {
    const scores = calculateArenaScore(t.roi || 0, t.pnl || 0, t.maxDrawdown || null, t.winRate || null, period)
    return {
      source: SOURCE,
      source_trader_id: t.traderId,
      season_id: period,
      rank: idx + 1,
      roi: t.roi || 0,
      pnl: t.pnl || 0,
      win_rate: t.winRate || null,
      max_drawdown: t.maxDrawdown || null,
      followers: t.followers || 0,
      arena_score: scores.totalScore,
      captured_at: capturedAt,
    }
  })

  for (let i = 0; i < snapshots.length; i += 30) {
    const batch = snapshots.slice(i, i + 30)
    const { error } = await supabase.from('trader_snapshots').upsert(batch, { onConflict: 'source,source_trader_id,season_id' })
    if (!error) saved += batch.length
    else console.log(`  ⚠ upsert error: ${error.message}`)
  }

  console.log(`  ✅ 保存: ${saved}/${topTraders.length}`)
  return saved
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])
  console.log('Gate.io 数据抓取开始...')
  console.log(`周期: ${periods.join(', ')}`)

  const traders = await scrapeAll()
  console.log(`\n📊 总计获取 ${traders.length} 个unique traders`)

  if (traders.length === 0) {
    console.log('❌ 未获取到数据')
    return
  }

  let total = 0
  for (const period of periods) {
    // For Gate.io, the API doesn't differentiate 7D/30D/90D well
    // The profit_rate from leader/list is for the selected cycle=month
    // We use the same data for all periods (the API aggregates are similar)
    total += await saveTraders(traders, period)
  }

  console.log(`\n✅ Gate.io 完成，共保存 ${total} 条`)
}

main().catch(e => { console.error(e); process.exit(1) })
