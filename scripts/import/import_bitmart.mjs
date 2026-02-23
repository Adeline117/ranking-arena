/**
 * BitMart Copy Trading Leaderboard Import
 *
 * Source: https://www.bitmart.com/copy-trading
 * API: /api/copy-trading/v1/public/trader/list (public, no auth)
 * 
 * BitMart has a public REST API — no browser required.
 * Routes through CF Worker for reliability.
 *
 * Usage: node scripts/import/import_bitmart.mjs [7D|30D|90D|ALL]
 */
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'bitmart'

const CF_PROXY     = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'
const BITMART_BASE = 'https://www.bitmart.com'

const PERIOD_MAP = { '7D': '7', '30D': '30', '90D': '90' }

async function fetchJson(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Origin': BITMART_BASE,
          'Referer': `${BITMART_BASE}/copy-trading`,
        },
        signal: AbortSignal.timeout(20000),
      })
      if (!res.ok) return null
      return await res.json()
    } catch (e) {
      if (i < retries - 1) await sleep(2000)
    }
  }
  return null
}

/** Try multiple BitMart API endpoints. */
async function fetchLeaderboard(period) {
  const periodNum = PERIOD_MAP[period]
  const traders = new Map()

  const endpoints = [
    // Direct API (sometimes accessible)
    `${BITMART_BASE}/api/copy-trading/v1/public/trader/list?page=1&size=100&period=${periodNum}&sort=roi&order=desc`,
    // CF Worker proxy
    `${CF_PROXY}/proxy?url=${encodeURIComponent(`${BITMART_BASE}/api/copy-trading/v1/public/trader/list?page=1&size=100&period=${periodNum}&sort=roi&order=desc`)}`,
  ]

  for (const url of endpoints) {
    const data = await fetchJson(url)
    if (!data) continue

    const list = data?.data?.list || data?.list || (Array.isArray(data) ? data : [])
    if (list.length === 0) continue

    console.log(`  ✓ Got ${list.length} traders from ${url.includes('proxy') ? 'CF proxy' : 'direct'}`)

    for (const t of list) {
      const id = String(t.trader_id || t.uid || t.id || '')
      if (!id) continue

      let roi = parseFloat(String(t.roi || t.roiRate || 0))
      if (Math.abs(roi) > 0 && Math.abs(roi) < 5) roi *= 100

      let wr = t.win_rate != null ? parseFloat(String(t.win_rate)) : null
      if (wr != null && wr > 0 && wr <= 1) wr *= 100

      let mdd = t.max_drawdown != null ? Math.abs(parseFloat(String(t.max_drawdown))) : null
      if (mdd != null && mdd > 0 && mdd <= 1) mdd *= 100

      traders.set(id, {
        id,
        nickname: t.nick_name || t.nickname || t.name || t.displayName || `Trader_${id.slice(0, 8)}`,
        avatar: t.avatar || t.avatar_url || t.headImg || null,
        roi,
        pnl: parseFloat(String(t.pnl || t.totalPnl || t.profit || 0)),
        winRate: wr,
        maxDrawdown: mdd,
        followers: parseInt(String(t.follower_count || t.followers || 0)),
      })
    }

    // Paginate if needed
    if (list.length >= 100) {
      for (let page = 2; page <= 5; page++) {
        await sleep(500)
        const pageUrl = url.replace('page=1', `page=${page}`)
        const nextData = await fetchJson(pageUrl)
        const nextList = nextData?.data?.list || nextData?.list || []
        if (nextList.length === 0) break

        for (const t of nextList) {
          const id = String(t.trader_id || t.uid || t.id || '')
          if (!id || traders.has(id)) continue
          // Same mapping as above
          let roi = parseFloat(String(t.roi || 0))
          if (Math.abs(roi) > 0 && Math.abs(roi) < 5) roi *= 100
          traders.set(id, {
            id, roi,
            nickname: t.nick_name || t.nickname || `Trader_${id.slice(0, 8)}`,
            avatar: t.avatar || null,
            pnl: parseFloat(String(t.pnl || 0)),
            winRate: null, maxDrawdown: null,
            followers: parseInt(String(t.follower_count || 0)),
          })
        }
        if (nextList.length < 100) break
      }
    }

    break  // Successfully got data, stop trying endpoints
  }

  return [...traders.values()]
}

async function saveTraders(traders, period) {
  if (traders.length === 0) {
    console.log(`  ⚠ No traders to save for ${period}`)
    return 0
  }
  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  const capturedAt = new Date().toISOString()

  const sourcesData = traders.map(t => ({
    source: SOURCE,
    source_type: 'leaderboard',
    source_trader_id: t.id,
    handle: t.nickname,
    avatar_url: t.avatar,
    is_active: true,
  }))

  const { error: srcErr } = await supabase
    .from('trader_sources')
    .upsert(sourcesData, { onConflict: 'source,source_trader_id' })
  if (srcErr) console.log(`  ⚠ trader_sources: ${srcErr.message}`)

  let saved = 0
  for (let i = 0; i < traders.length; i++) {
    const t = traders[i]
    const { totalScore } = calculateArenaScore(t.roi, t.pnl, t.maxDrawdown, t.winRate, period)
    const snap = {
      source: SOURCE,
      source_trader_id: t.id,
      season_id: period,
      rank: i + 1,
      roi: t.roi,
      pnl: t.pnl,
      win_rate: t.winRate,
      max_drawdown: t.maxDrawdown,
      followers: t.followers,
      arena_score: totalScore,
      captured_at: capturedAt,
    }
    const { error } = await supabase
      .from('trader_snapshots')
      .upsert(snap, { onConflict: 'source,source_trader_id,season_id' })
    if (!error) saved++
    else console.log(`  ⚠ [${t.id}]: ${error.message}`)
  }

  console.log(`  ✅ ${period}: saved ${saved}/${traders.length}`)
  return saved
}

async function main() {
  const arg = process.argv[2]?.toUpperCase()
  const targetPeriods = arg === 'ALL' ? ['7D', '30D', '90D']
    : arg && ['7D', '30D', '90D'].includes(arg) ? [arg]
    : ['30D', '7D', '90D']

  console.log('BitMart Copy Trading Import')
  console.log(`Periods: ${targetPeriods.join(', ')}\n`)

  let total = 0
  for (const period of targetPeriods) {
    console.log(`\n=== ${period} ===`)
    const traders = await fetchLeaderboard(period)
    console.log(`  Fetched: ${traders.length} traders`)

    if (traders.length > 0) {
      const top5 = traders.slice(0, 5)
      top5.forEach((t, i) => console.log(`  ${i + 1}. ${t.nickname}: ROI ${t.roi?.toFixed(1)}%`))
    }

    total += await saveTraders(traders, period)
    await sleep(2000)
  }

  console.log(`\n✅ BitMart import done: ${total} total saved`)
}

main().catch(console.error)
