/**
 * WEEX scraper - capture security headers then paginate from Node.js
 * The page adds x-sig, sidecar, vs, terminalcode headers to every API request.
 * We capture these + use the proxy to make all 360 traders available.
 */
import { chromium } from 'playwright'
import nodeFetch from 'node-fetch'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { getSupabaseClient, calculateArenaScore, sleep } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'weex'
const PROXY = 'http://127.0.0.1:7890'
const agent = new HttpsProxyAgent(PROXY)

function parseTrader(item) {
  const id = String(item.traderUserId || '')
  if (!id) return null
  let roi = 0
  if (item.totalReturnRate != null) {
    roi = parseFloat(String(item.totalReturnRate))
    if (Math.abs(roi) > 0 && Math.abs(roi) < 1) roi *= 100
  }
  const ratesByDays = {}
  if (Array.isArray(item.ndaysReturnRates)) {
    for (const r of item.ndaysReturnRates) {
      let rate = parseFloat(String(r.rate || 0))
      if (Math.abs(rate) > 0 && Math.abs(rate) < 1) rate *= 100
      ratesByDays[r.ndays] = rate
    }
  }
  let wr = item.winRate != null ? parseFloat(String(item.winRate)) : null
  if (wr != null && wr > 0 && wr <= 1) wr *= 100
  let dd = item.maxDrawdown != null ? Math.abs(parseFloat(String(item.maxDrawdown))) : null
  if (dd != null && dd > 0 && dd <= 1) dd *= 100
  return {
    id,
    name: item.traderNickName || item.nickName || `Trader_${id.slice(0, 8)}`,
    avatar: item.headPic || null,
    roi, roi7d: ratesByDays[7] || null, roi21d: ratesByDays[21] || roi, roi90d: ratesByDays[90] || null,
    pnl: parseFloat(String(item.threeWeeksPNL || item.profit || 0)),
    followers: parseInt(String(item.followCount || 0)),
    winRate: wr, maxDrawdown: dd,
  }
}

async function captureHeaders() {
  console.log('Launching browser to capture security headers...')
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    proxy: { server: PROXY },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })

  let capturedHeaders = null
  let capturedUrl = null
  const capturedTraders = new Map()
  const headersCaptured = new Promise((resolve) => {
    ctx.route('**/trace/traderListView*', async (route) => {
      const req = route.request()
      const headers = req.headers()
      const url = req.url()
      
      if (!capturedHeaders && headers['x-sig']) {
        capturedHeaders = headers
        capturedUrl = url
        console.log(`  Captured headers from ${url.slice(0, 80)}`)
        console.log(`  x-sig: ${headers['x-sig']}`)
        console.log(`  sidecar: ${headers['sidecar']?.slice(0, 40)}...`)
        console.log(`  appversion: ${headers['appversion']}`)
        console.log(`  terminalcode: ${headers['terminalcode']}`)
        console.log(`  vs: ${headers['vs']}`)
      }
      
      // Continue original request
      const resp = await route.fetch()
      const text = await resp.text()
      try {
        const json = JSON.parse(text)
        if (json.code === 'SUCCESS') {
          for (const item of (json.data?.rows || [])) {
            const t = parseTrader(item)
            if (t && !capturedTraders.has(t.id)) capturedTraders.set(t.id, t)
          }
        }
      } catch {}
      await route.fulfill({ response: resp, body: text })
      
      if (capturedHeaders) resolve({ headers: capturedHeaders, url: capturedUrl })
    })
  })

  const page = await ctx.newPage()
  await page.goto('https://www.weex.com/copy-trading', { timeout: 60000, waitUntil: 'domcontentloaded' })
  
  // Wait for headers to be captured (up to 15s)
  const result = await Promise.race([
    headersCaptured,
    sleep(15000).then(() => null),
  ])
  
  await browser.close()
  
  if (!result) {
    console.log('  ⚠️  Could not capture security headers')
    return { headers: null, url: null, preloadedTraders: capturedTraders }
  }
  
  return { headers: result.headers, url: result.url, preloadedTraders: capturedTraders }
}

async function fetchAllTraders(headers, gatewayUrl, preloadedTraders) {
  const traders = new Map(preloadedTraders)
  let totalKnown = null
  
  // Build request headers for Node.js
  const reqHeaders = {
    'Content-Type': 'application/json',
    'User-Agent': headers['user-agent'],
    'Accept': headers['accept'] || 'application/json, text/plain, */*',
    'Accept-Encoding': 'gzip,deflate,br',
    'Origin': 'https://www.weex.com',
    'Referer': 'https://www.weex.com/',
    'x-sig': headers['x-sig'],
    'x-timestamp': headers['x-timestamp'],
    'appversion': headers['appversion'],
    'bundleid': headers['bundleid'] || '',
    'language': headers['language'] || 'en_US',
    'locale': headers['locale'] || 'en_US',
    'terminalcode': headers['terminalcode'],
    'terminaltype': headers['terminaltype'] || '1',
    'sidecar': headers['sidecar'],
    'vs': headers['vs'],
    'traceid': headers['traceid'],
    'sec-ch-ua': headers['sec-ch-ua'],
    'sec-ch-ua-mobile': headers['sec-ch-ua-mobile'],
    'sec-ch-ua-platform': headers['sec-ch-ua-platform'],
  }
  
  // Remove undefined headers
  for (const k of Object.keys(reqHeaders)) {
    if (!reqHeaders[k]) delete reqHeaders[k]
  }

  console.log(`\nPaginating via Node.js (${traders.size} preloaded)...`)
  
  for (const sortRule of [0, 9, 5, 2, 6, 7, 8, 1]) {
    let pageNo = 1
    let consecutiveEmpty = 0
    
    while (pageNo <= 50 && consecutiveEmpty < 3) {
      const body = JSON.stringify({ languageType: 0, sortRule, simulation: 0, pageNo, pageSize: 20, nickName: '' })
      
      try {
        const resp = await nodeFetch(gatewayUrl, {
          method: 'POST',
          headers: { ...reqHeaders, 'content-length': String(body.length) },
          body,
          agent,
          timeout: 20000,
        })
        
        if (!resp.ok) {
          if (pageNo === 1) console.log(`  sort=${sortRule}: HTTP ${resp.status}`)
          break
        }
        
        const json = await resp.json()
        if (json.code !== 'SUCCESS') {
          if (pageNo === 1) console.log(`  sort=${sortRule}: ${json.code}`)
          break
        }
        
        if (!totalKnown && json.data?.totals) totalKnown = json.data.totals
        
        const rows = json.data?.rows || []
        if (!rows.length) { consecutiveEmpty++; pageNo++; continue }
        
        let added = 0
        for (const item of rows) {
          const t = parseTrader(item)
          if (t && !traders.has(t.id)) { traders.set(t.id, t); added++ }
        }
        
        if (added > 0) {
          consecutiveEmpty = 0
          console.log(`  sort=${sortRule} p${pageNo}: +${added} → ${traders.size}/${totalKnown || '?'}`)
        } else {
          consecutiveEmpty++
        }
        
        if (!json.data.nextFlag) break
        pageNo++
        await sleep(300)
      } catch (e) {
        if (pageNo === 1) console.log(`  sort=${sortRule}: ${e.message}`)
        break
      }
    }
  }
  
  console.log(`\nTotal: ${traders.size} unique traders (API total: ${totalKnown || '?'})`)
  return [...traders.values()]
}

async function saveToDb(traders) {
  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  const periods = ['7D', '30D', '90D']
  const now = new Date().toISOString()

  for (let i = 0; i < traders.length; i += 50) {
    const { error } = await supabase.from('trader_sources').upsert(
      traders.slice(i, i + 50).map(t => ({
        source: SOURCE, source_trader_id: t.id, handle: t.name,
        avatar_url: t.avatar, market_type: 'futures', is_active: true,
      })),
      { onConflict: 'source,source_trader_id' }
    )
    if (error) console.log(`  source err: ${error.message}`)
  }
  console.log(`✅ trader_sources: ${traders.length}`)

  for (const period of periods) {
    console.log(`\n💾 ${period}: ${traders.length}...`)
    let savedLR = 0, savedSnap = 0

    for (let i = 0; i < traders.length; i += 30) {
      const batch = traders.slice(i, i + 30)

      const snapBatch = batch.map((t, j) => {
        let roi = t.roi || 0
        if (period === '7D' && t.roi7d != null) roi = t.roi7d
        if (period === '90D' && t.roi90d != null) roi = t.roi90d
        const scores = calculateArenaScore(roi, t.pnl, t.maxDrawdown, t.winRate, period)
        return {
          source: SOURCE, source_trader_id: t.id, season_id: period,
          rank: i + j + 1, roi, pnl: t.pnl || null,
          win_rate: t.winRate, max_drawdown: t.maxDrawdown,
          followers: t.followers, arena_score: scores.totalScore, captured_at: now,
        }
      })
      const { error: se } = await supabase.from('trader_snapshots')
        .upsert(snapBatch, { onConflict: 'source,source_trader_id,season_id' })
      if (!se) savedSnap += snapBatch.length

      const lrBatch = batch.map((t, j) => {
        let roi = t.roi || 0
        if (period === '7D' && t.roi7d != null) roi = t.roi7d
        if (period === '90D' && t.roi90d != null) roi = t.roi90d
        const scores = calculateArenaScore(roi, t.pnl, t.maxDrawdown, t.winRate, period)
        return {
          source: SOURCE, source_type: 'futures',
          source_trader_id: t.id, season_id: period,
          rank: i + j + 1, handle: t.name, avatar_url: t.avatar || null,
          roi, pnl: t.pnl || null, win_rate: t.winRate, max_drawdown: t.maxDrawdown,
          followers: t.followers || null, arena_score: scores.totalScore, computed_at: now,
        }
      })
      const { error: le } = await supabase.from('leaderboard_ranks')
        .upsert(lrBatch, { onConflict: 'season_id,source,source_trader_id' })
      if (!le) savedLR += lrBatch.length
      else console.log(`  LR err: ${le.message}`)
    }
    console.log(`  snapshots: ${savedSnap} | leaderboard_ranks: ${savedLR}`)
  }
}

async function main() {
  console.log('WEEX header-capture import\n')
  
  const { headers, url: gatewayUrl, preloadedTraders } = await captureHeaders()
  console.log(`\nPreloaded: ${preloadedTraders.size} traders`)
  
  if (!headers || !gatewayUrl) {
    console.log('❌ Failed to capture headers')
    process.exit(1)
  }
  
  const traders = await fetchAllTraders(headers, gatewayUrl, preloadedTraders)
  
  if (traders.length < 15) {
    console.log('⚠️  Too few traders:', traders.length, '— aborting')
    process.exit(1)
  }
  
  await saveToDb(traders)

  const { count: lr } = await supabase.from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true }).eq('source', SOURCE)
  const { count: snap } = await supabase.from('trader_snapshots')
    .select('*', { count: 'exact', head: true }).eq('source', SOURCE)
  console.log(`\n✅ Final: leaderboard_ranks(weex)=${lr}, trader_snapshots(weex)=${snap}`)
}

main().catch(e => { console.error(e); process.exit(1) })
