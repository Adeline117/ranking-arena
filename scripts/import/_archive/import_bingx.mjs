/**
 * BingX Copy Trading Leaderboard Import — v3 (CF Worker REST)
 *
 * Fixes vs v2 (Playwright):
 *   - Uses CF Worker to proxy requests to BingX internal API (qq-os.com)
 *   - No browser needed → 10× faster, no Cloudflare challenge
 *   - Pagination support up to 500 traders
 *   - Per-trader WR/MDD via /bingx/trader-detail endpoint
 *
 * Usage: node scripts/import/import_bingx.mjs [7D|30D|90D|ALL]
 */
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'bingx'

const CF_PROXY = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'

// BingX timeType: 1=7D, 2=30D, 3=90D
const PERIOD_TO_TIMETYPE = { '7D': '1', '30D': '2', '90D': '3' }

async function fetchJson(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(20000),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        console.log(`  HTTP ${res.status}: ${text.slice(0, 100)}`)
        return null
      }
      return await res.json()
    } catch (e) {
      console.log(`  Fetch error (attempt ${i + 1}): ${e.message}`)
      if (i < retries - 1) await sleep(2000)
    }
  }
  return null
}

/** Fetch all traders for a period via pagination. */
async function fetchLeaderboard(timeType) {
  const traders = new Map()
  const PAGE_SIZE = 100
  const MAX_PAGES = 5

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${CF_PROXY}/bingx/leaderboard?timeType=${timeType}&pageIndex=${page}&pageSize=${PAGE_SIZE}`
    const data = await fetchJson(url)

    if (!data) break

    // Try multiple response shapes
    let list = []
    if (Array.isArray(data.data?.list)) list = data.data.list
    else if (Array.isArray(data.data?.rows)) list = data.data.rows
    else if (Array.isArray(data.data)) list = data.data
    else if (Array.isArray(data.list)) list = data.list
    else if (Array.isArray(data)) list = data

    if (list.length === 0) {
      console.log(`  Page ${page}: empty — stopping pagination`)
      break
    }

    for (const t of list) {
      const uid = String(t.uid || t.uniqueId || t.traderId || t.id || '')
      if (!uid || traders.has(uid)) continue

      let roi = parseFloat(String(t.roi || t.roiRate || t.returnRate || t.yieldRate || 0))
      if (Math.abs(roi) > 0 && Math.abs(roi) < 5) roi *= 100  // decimal → percent

      let wr = t.winRate != null ? parseFloat(String(t.winRate)) : null
      if (wr != null && wr > 0 && wr <= 1) wr *= 100

      let mdd = t.maxDrawdown != null ? Math.abs(parseFloat(String(t.maxDrawdown))) : null
      if (mdd != null && mdd > 0 && mdd <= 1) mdd *= 100

      traders.set(uid, {
        uid,
        nickname: t.traderName || t.nickname || t.nickName || t.displayName || `Trader_${uid.slice(0, 8)}`,
        avatarUrl: t.headUrl || t.avatar || t.avatarUrl || null,
        roi,
        pnl: parseFloat(String(t.pnl || t.totalPnl || t.profit || 0)),
        winRate: wr,
        maxDrawdown: mdd,
        followers: parseInt(String(t.followerNum || t.followers || t.followerCount || 0)),
      })
    }

    console.log(`  Page ${page}: ${list.length} raw, ${traders.size} unique so far`)

    if (list.length < PAGE_SIZE) break
    await sleep(300)
  }

  return [...traders.values()]
}

/** Enrich WR/MDD for traders that are missing them. */
async function enrichTraderDetails(traders, timeType) {
  const needEnrich = traders.filter(t => t.winRate == null || t.maxDrawdown == null)
  console.log(`  Enriching ${needEnrich.length}/${traders.length} traders with WR/MDD...`)

  let enriched = 0
  const BATCH = 10

  for (let i = 0; i < needEnrich.length; i += BATCH) {
    const batch = needEnrich.slice(i, i + BATCH)
    await Promise.all(batch.map(async (t) => {
      const url = `${CF_PROXY}/bingx/trader-detail?uid=${t.uid}&timeType=${timeType}`
      const data = await fetchJson(url)
      if (!data) return

      const d = data.data || data
      if (d.winRate != null) {
        t.winRate = parseFloat(String(d.winRate))
        if (t.winRate > 0 && t.winRate <= 1) t.winRate *= 100
      }
      if (d.maxDrawdown != null || d.mdd != null) {
        t.maxDrawdown = Math.abs(parseFloat(String(d.maxDrawdown || d.mdd || 0)))
        if (t.maxDrawdown > 0 && t.maxDrawdown <= 1) t.maxDrawdown *= 100
      }
      enriched++
    }))
    await sleep(500)
  }

  console.log(`  Enriched ${enriched} traders`)
  return traders
}

async function saveTraders(traders, period) {
  if (traders.length === 0) { console.log(`  ⚠ No data to save`); return 0 }
  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  const capturedAt = new Date().toISOString()

  const sourcesData = traders.map(t => ({
    source: SOURCE,
    source_type: 'leaderboard',
    source_trader_id: t.uid,
    handle: t.nickname,
    avatar_url: t.avatarUrl,
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
      source_trader_id: t.uid,
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
    else console.log(`  ⚠ [${t.uid}]: ${error.message}`)
  }

  const withWr  = traders.filter(t => t.winRate != null).length
  const withMdd = traders.filter(t => t.maxDrawdown != null).length
  console.log(`  ✅ Saved: ${saved}/${traders.length}, WR: ${withWr}, MDD: ${withMdd}`)
  return saved
}

async function main() {
  const arg = process.argv[2]?.toUpperCase()
  const targetPeriods = arg === 'ALL' ? ['7D', '30D', '90D']
    : arg && ['7D', '30D', '90D'].includes(arg) ? [arg]
    : ['30D']

  console.log('BingX Import — v3 (CF Worker REST)')
  console.log(`Proxy: ${CF_PROXY}`)
  console.log(`Periods: ${targetPeriods.join(', ')}\n`)

  for (const period of targetPeriods) {
    const timeType = PERIOD_TO_TIMETYPE[period]
    console.log(`\n=== ${period} (timeType=${timeType}) ===`)

    let traders = await fetchLeaderboard(timeType)
    console.log(`  Fetched: ${traders.length} traders`)

    if (traders.length > 0) {
      traders = await enrichTraderDetails(traders, timeType)
    }

    await saveTraders(traders, period)
    await sleep(2000)
  }

  console.log('\n✅ BingX import done')
}

main().catch(console.error)
