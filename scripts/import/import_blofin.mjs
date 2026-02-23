/**
 * BloFin Copy Trading Leaderboard Import — v4 (CF Worker REST)
 *
 * Fixes vs v3 (Playwright):
 *   - Uses CF Worker to proxy requests to BloFin's OpenAPI (bypasses CF block)
 *   - No browser needed — 20× faster
 *   - Paginated: fetches up to 500 traders per period
 *
 * BloFin OpenAPI: https://openapi.blofin.com/api/v1/copytrading/public/leaderboard
 *   ?period=7|30|90&limit=100&page=1
 *
 * Usage: node scripts/import/import_blofin.mjs [7D|30D|90D|ALL]
 */
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'blofin'

const CF_PROXY = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'

const PERIOD_MAP = { '7D': '7', '30D': '30', '90D': '90' }

async function fetchJson(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(20000),
      })
      if (!res.ok) {
        console.log(`  HTTP ${res.status} for ${url}`)
        return null
      }
      return await res.json()
    } catch (e) {
      console.log(`  Error (attempt ${i + 1}): ${e.message}`)
      if (i < retries - 1) await sleep(2000)
    }
  }
  return null
}

function parseTrader(t) {
  let roi = parseFloat(String(t.roi || t.roiRate || t.returnRate || 0))
  if (Math.abs(roi) > 0 && Math.abs(roi) < 5) roi *= 100

  let wr = t.winRate != null ? parseFloat(String(t.winRate)) : null
  if (wr != null && wr > 0 && wr <= 1) wr *= 100

  let mdd = t.mdd != null ? Math.abs(parseFloat(String(t.mdd))) : null
  if (mdd != null && mdd > 0 && mdd <= 1) mdd *= 100

  return {
    id: String(t.uid || t.uniqueName || t.leaderId || ''),
    name: t.nick_name || t.nickName || t.nickname || t.name || `Trader_${String(t.uid || '').slice(0, 8)}`,
    avatar: t.profile || t.avatar || t.avatarUrl || null,
    roi,
    pnl: parseFloat(String(t.pnl || t.totalPnl || 0)),
    mdd,
    winRate: wr,
    followers: parseInt(String(t.followers || t.copiers || t.followerCount || 0)),
  }
}

async function fetchLeaderboard(period) {
  const periodNum = PERIOD_MAP[period]
  const traders = new Map()

  for (let page = 1; page <= 5; page++) {
    const url = `${CF_PROXY}/blofin/leaderboard?period=${periodNum}&page=${page}&limit=100`
    const data = await fetchJson(url)
    if (!data) break

    // BloFin API response shapes
    let list = []
    if (data.code === 0 || data.code === 200) {
      list = data.data?.list || data.data?.traders || data.data || []
    } else if (Array.isArray(data.data)) {
      list = data.data
    } else if (Array.isArray(data)) {
      list = data
    }

    if (list.length === 0) {
      if (page === 1) {
        // Try alternate endpoint shapes
        console.log(`  Page ${page}: no data, trying alternate...`)
        const altUrl = `${CF_PROXY}/proxy?url=${encodeURIComponent(`https://openapi.blofin.com/api/v1/copy-trading/public/leaderboard?period=${periodNum}&page=${page}&limit=100`)}`
        const altData = await fetchJson(altUrl)
        if (altData) {
          const altList = altData?.data?.list || altData?.data || []
          if (altList.length) {
            for (const t of altList) {
              const trader = parseTrader(t)
              if (trader.id) traders.set(trader.id, trader)
            }
            console.log(`  Alt endpoint: ${altList.length} traders`)
          }
        }
      }
      break
    }

    for (const t of list) {
      const trader = parseTrader(t)
      if (trader.id && !traders.has(trader.id)) traders.set(trader.id, trader)
    }

    console.log(`  Page ${page}: ${list.length} traders, total ${traders.size}`)
    if (list.length < 100) break
    await sleep(300)
  }

  return [...traders.values()]
}

async function saveTraders(traders, period) {
  if (traders.length === 0) { console.log(`  ⚠ No data for ${period}`); return 0 }
  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  const capturedAt = new Date().toISOString()

  const sourcesData = traders.map(t => ({
    source: SOURCE,
    source_trader_id: t.id,
    handle: t.name,
    avatar_url: t.avatar,
    market_type: 'futures',
    is_active: true,
  }))

  const { error: srcErr } = await supabase
    .from('trader_sources')
    .upsert(sourcesData, { onConflict: 'source,source_trader_id' })
  if (srcErr) console.log(`  ⚠ trader_sources: ${srcErr.message}`)

  let saved = 0
  for (let i = 0; i < traders.length; i++) {
    const t = traders[i]
    const { totalScore } = calculateArenaScore(t.roi, t.pnl, t.mdd, t.winRate, period)
    const snap = {
      source: SOURCE,
      source_trader_id: t.id,
      season_id: period,
      rank: i + 1,
      roi: t.roi,
      pnl: t.pnl,
      win_rate: t.winRate,
      max_drawdown: t.mdd,
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
    : ['7D', '30D', '90D']

  console.log('BloFin Import — v4 (CF Worker REST, no Playwright)')
  console.log(`Proxy: ${CF_PROXY}`)
  console.log(`Periods: ${targetPeriods.join(', ')}\n`)

  let total = 0
  for (const period of targetPeriods) {
    console.log(`\n=== ${period} ===`)
    const traders = await fetchLeaderboard(period)
    console.log(`  Fetched: ${traders.length} traders`)
    total += await saveTraders(traders, period)
    await sleep(1000)
  }

  console.log(`\n✅ BloFin import done: ${total} total saved`)
}

main().catch(console.error)
