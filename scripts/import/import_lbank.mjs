/**
 * LBank Copy Trading 排行榜数据抓取
 *
 * LBank 把所有 trader 数据嵌入在 SSR HTML 的 __NEXT_DATA__ 中
 * 无需 Puppeteer，直接 HTTP 请求即可获取全部数据
 *
 * 注意: LBank 平台仅有约 30 个活跃 lead trader，这是平台限制
 *
 * 用法: node scripts/import/import_lbank.mjs [7D|30D|90D|ALL]
 */

import {
  getSupabaseClient,
  calculateArenaScore,
  getTargetPeriods,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'lbank'
const BASE_URL = 'https://www.lbank.com/copy-trading'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}

function parseTrader(item) {
  const uuid = item.uuid || item.name || ''
  if (!uuid) return null

  const nickname = item.nickname || item.alias || item.localNickname || uuid
  const avatar = item.headPhoto
    ? (item.headPhoto.startsWith('http') ? item.headPhoto : `https://www.lbank.com${item.headPhoto}`)
    : null

  // ROI: omProfitRate is the 30D ROI, sprofitRate is the display ROI
  // profitRate is overall ROI
  const roi30d = parseFloat(item.omProfitRate || item.sprofitRate || 0)
  const roiAll = parseFloat(item.profitRate || item.sprofitRate || 0)
  const profit = parseFloat(item.omProfit || item.sprofit || item.profit || 0)

  const winRate = parseFloat(item.omWinRate || item.swinRate || item.winRate || 0)
  const maxDrawdown = parseFloat(item.drawDown || 0)
  const followers = parseInt(item.followerCount || item.followerCountNow || 0)
  const trades = parseInt(item.tradeCount || 0)

  return {
    traderId: uuid,
    nickname,
    avatar,
    roi30d,
    roiAll,
    profit,
    winRate,
    maxDrawdown,
    followers,
    trades,
  }
}

async function fetchTraders() {
  console.log(`\n📋 获取 LBank __NEXT_DATA__...`)

  const resp = await fetch(BASE_URL, { headers: HEADERS })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)

  const html = await resp.text()
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/)
  if (!match) throw new Error('__NEXT_DATA__ not found')

  const nextData = JSON.parse(match[1])
  const topTraders = nextData?.props?.pageProps?.topTraders
  if (!topTraders) throw new Error('topTraders not found in __NEXT_DATA__')

  const traders = new Map()

  // Extract from all lists
  for (const [key, value] of Object.entries(topTraders)) {
    let items = []
    if (Array.isArray(value)) {
      items = value
    } else if (value && typeof value === 'object' && value.traderInfoResps) {
      items = value.traderInfoResps
    }

    for (const item of items) {
      const t = parseTrader(item)
      if (!t || traders.has(t.traderId)) continue
      traders.set(t.traderId, t)
    }

    if (items.length > 0) {
      console.log(`  ${key}: ${items.length} 条`)
    }
  }

  console.log(`\n📊 共 ${traders.size} 个唯一交易员`)
  return Array.from(traders.values())
}

async function saveTraders(traders, period) {
  console.log(`\n💾 保存 ${traders.length} 条 ${period} 数据...`)

  const capturedAt = new Date().toISOString()

  // Sort by appropriate ROI for the period
  traders.sort((a, b) => {
    const roiA = period === '90D' ? (a.roiAll || a.roi30d) : a.roi30d
    const roiB = period === '90D' ? (b.roiAll || b.roi30d) : b.roi30d
    return roiB - roiA
  })

  // Upsert trader_sources
  const sourcesData = traders.map(t => ({
    source: SOURCE,
    source_type: 'leaderboard',
    source_trader_id: t.traderId,
    handle: t.nickname,
    avatar_url: t.avatar,
    is_active: true,
    profile_url: `https://www.lbank.com/copy-trading/trader/${t.traderId}`,
  }))

  await supabase.from('trader_sources').upsert(sourcesData, { onConflict: 'source,source_trader_id' })

  // Upsert snapshots
  const snapshotsData = traders.map((t, idx) => {
    const roi = period === '90D' ? (t.roiAll || t.roi30d) : t.roi30d
    const normalizedWr = t.winRate > 0 && t.winRate <= 1 ? t.winRate * 100 : t.winRate
    const arenaScore = calculateArenaScore(roi, t.profit, t.maxDrawdown, normalizedWr, period).totalScore

    if (idx < 5) {
      console.log(`  ${idx + 1}. ${t.nickname.slice(0, 15)}: ROI ${roi.toFixed(2)}% → Score ${arenaScore}`)
    }

    return {
      source: SOURCE,
      source_trader_id: t.traderId,
      season_id: period,
      rank: idx + 1,
      roi,
      pnl: t.profit || null,
      win_rate: normalizedWr || null,
      max_drawdown: t.maxDrawdown || null,
      followers: t.followers || null,
      arena_score: arenaScore,
      captured_at: capturedAt,
    }
  })

  const { error } = await supabase.from('trader_snapshots').upsert(snapshotsData, {
    onConflict: 'source,source_trader_id,season_id'
  })

  if (error) {
    console.log(`  ⚠ 批量保存失败: ${error.message}`)
    let saved = 0
    for (const s of snapshotsData) {
      const { error: e } = await supabase.from('trader_snapshots').upsert(s, {
        onConflict: 'source,source_trader_id,season_id'
      })
      if (!e) saved++
    }
    return saved
  }

  console.log(`  ✓ 保存成功: ${snapshotsData.length} 条`)
  return snapshotsData.length
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])

  console.log(`\n${'='.repeat(50)}`)
  console.log(`LBank Copy Trading 数据抓取 (SSR extraction)`)
  console.log(`${'='.repeat(50)}`)
  console.log('时间:', new Date().toISOString())
  console.log(`目标周期: ${periods.join(', ')}`)
  console.log('注意: LBank 平台约 30 个活跃交易员，为平台限制')

  // Fetch once, save for all periods
  const traders = await fetchTraders()

  if (traders.length === 0) {
    console.log('\n⚠ 未获取到数据')
    process.exit(1)
  }

  const results = []
  for (const period of periods) {
    const saved = await saveTraders(traders, period)
    results.push({ period, count: traders.length, saved })
  }

  console.log(`\n${'='.repeat(50)}`)
  console.log(`✅ 完成！`)
  for (const r of results) {
    console.log(`  ${r.period}: ${r.saved} 条`)
  }
  console.log(`${'='.repeat(50)}`)
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
