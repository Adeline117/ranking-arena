/**
 * Puppeteer Batch Import — BingX + BitMart + Gains
 * 
 * Uses headless Chrome to bypass CF challenges and API restrictions.
 * Mac Mini only (VPS Puppeteer is broken).
 *
 * Usage: node scripts/import/import_puppeteer_batch.mjs [bingx|bitmart|gains|all]
 */
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { getSupabaseClient, calculateArenaScore, sleep } from '../lib/shared.mjs'

puppeteer.use(StealthPlugin())
const supabase = getSupabaseClient()

const target = process.argv[2]?.toLowerCase() || 'all'

async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })
}

// ── BingX ────────────────────────────────────────────────
async function importBingx(browser) {
  console.log('\n=== BingX Futures Import ===')
  const page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
  
  const traders = []
  for (const timeType of ['2']) { // 30D
    const period = { '1': '7D', '2': '30D', '3': '90D' }[timeType]
    console.log(`  Fetching ${period}...`)
    
    // Navigate to BingX copy trading page to get cookies
    await page.goto('https://bingx.com/en/CopyTrading/leaderBoard', { waitUntil: 'networkidle0', timeout: 30000 })
    await sleep(3000)
    
    // Intercept API response
    let apiData = null
    page.on('response', async (response) => {
      const url = response.url()
      if (url.includes('leaderboard/rank') || url.includes('copy-trade')) {
        try { apiData = await response.json() } catch {}
      }
    })
    
    // Try fetching via page context
    const result = await page.evaluate(async (tt) => {
      try {
        const res = await fetch(`https://api-app.qq-os.com/api/copy-trade-facade/v2/leaderboard/rank?pageIndex=1&pageSize=100&timeType=${tt}`, {
          credentials: 'include',
        })
        return await res.json()
      } catch (e) {
        return { error: e.message }
      }
    }, timeType)
    
    const list = result?.data?.rankList || result?.data?.list || []
    console.log(`  Got ${list.length} traders for ${period}`)
    
    for (const t of list) {
      const uid = String(t.uid || t.id || '')
      if (!uid) continue
      
      let roi = parseFloat(String(t.roi || t.roiRate || 0))
      if (roi > 0 && roi < 5) roi *= 100 // Convert decimal to percent
      
      let wr = t.winRate != null ? parseFloat(String(t.winRate)) : null
      if (wr != null && wr > 0 && wr <= 1) wr *= 100
      
      let mdd = t.maxDrawdown != null ? Math.abs(parseFloat(String(t.maxDrawdown))) : null
      if (mdd != null && mdd > 0 && mdd <= 1) mdd *= 100
      
      traders.push({
        source: 'bingx',
        source_trader_id: uid,
        season_id: period,
        nickname: t.nickName || t.nickname || `Trader_${uid.slice(0, 8)}`,
        avatar_url: t.avatar || t.photoUrl || null,
        roi,
        pnl: parseFloat(String(t.pnl || t.totalProfit || 0)),
        win_rate: wr,
        max_drawdown: mdd,
        followers: parseInt(String(t.copierNum || t.followers || 0)),
        trades_count: parseInt(String(t.tradeCount || t.totalCount || 0)) || null,
        arena_score: calculateArenaScore(roi, parseFloat(String(t.pnl || 0)), mdd, wr, period),
        captured_at: new Date().toISOString(),
      })
    }
  }
  
  await page.close()
  
  if (traders.length > 0) {
    // Save trader_sources
    const sources = traders.map(t => ({
      source: t.source,
      source_trader_id: t.source_trader_id,
      nickname: t.nickname,
      avatar_url: t.avatar_url,
    }))
    const uniqueSources = [...new Map(sources.map(s => [s.source_trader_id, s])).values()]
    
    for (let i = 0; i < uniqueSources.length; i += 50) {
      await supabase.from('trader_sources').upsert(uniqueSources.slice(i, i + 50), {
        onConflict: 'source,source_trader_id',
      })
    }
    
    // Save snapshots
    for (let i = 0; i < traders.length; i += 50) {
      const batch = traders.slice(i, i + 50).map(({ nickname, avatar_url, ...rest }) => rest)
      const { error } = await supabase.from('trader_snapshots').upsert(batch, {
        onConflict: 'source,source_trader_id,season_id',
        ignoreDuplicates: false,
      })
      if (error) console.error(`  Batch ${i} error:`, error.message)
    }
    console.log(`  ✅ Saved ${traders.length} BingX traders`)
  } else {
    console.log('  ⚠ No BingX traders found')
  }
  
  return traders.length
}

// ── BitMart ──────────────────────────────────────────────
async function importBitmart(browser) {
  console.log('\n=== BitMart Import ===')
  const page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
  
  // Go to BitMart copy trading page
  await page.goto('https://www.bitmart.com/copy-trading', { waitUntil: 'networkidle0', timeout: 30000 })
  await sleep(5000) // Wait for CF challenge
  
  // Try to fetch API with cookies
  const result = await page.evaluate(async () => {
    try {
      const res = await fetch('/api/copy-trading/v1/public/trader/list?page=1&size=100&period=30&sort=roi&order=desc')
      return await res.json()
    } catch (e) {
      return { error: e.message }
    }
  })
  
  const list = result?.data?.list || []
  console.log(`  Got ${list.length} BitMart traders`)
  
  if (list.length > 0) {
    const traders = list.map(t => ({
      source: 'bitmart',
      source_trader_id: String(t.trader_id || t.uid || t.id),
      season_id: '30D',
      roi: parseFloat(String(t.roi || 0)) * (Math.abs(parseFloat(String(t.roi || 0))) < 5 ? 100 : 1),
      pnl: parseFloat(String(t.pnl || 0)),
      win_rate: t.win_rate != null ? parseFloat(String(t.win_rate)) * (parseFloat(String(t.win_rate)) <= 1 ? 100 : 1) : null,
      max_drawdown: t.max_drawdown != null ? Math.abs(parseFloat(String(t.max_drawdown))) : null,
      followers: parseInt(String(t.follower_count || 0)),
      captured_at: new Date().toISOString(),
    }))
    
    for (let i = 0; i < traders.length; i += 50) {
      const { error } = await supabase.from('trader_snapshots').upsert(traders.slice(i, i + 50), {
        onConflict: 'source,source_trader_id,season_id',
      })
      if (error) console.error(`  Batch error:`, error.message)
    }
    console.log(`  ✅ Saved ${traders.length} BitMart traders`)
  }
  
  await page.close()
  return list.length
}

// ── Gains ────────────────────────────────────────────────
async function importGains(browser) {
  console.log('\n=== Gains Network Import ===')
  const page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
  
  const chains = ['arbitrum', 'polygon', 'base']
  let totalTraders = 0
  
  for (const chain of chains) {
    console.log(`  Fetching ${chain}...`)
    const url = `https://backend-${chain}.gains.trade/leaderboard/all`
    
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 }).catch(() => {})
    await sleep(2000)
    
    let data = null
    try {
      const text = await page.evaluate(() => document.body.innerText)
      data = JSON.parse(text)
    } catch {
      console.log(`    ⚠ ${chain}: could not parse response`)
      continue
    }
    
    if (!data || typeof data !== 'object') continue
    
    for (const [periodKey, traders] of Object.entries(data)) {
      if (!Array.isArray(traders) || traders.length === 0) continue
      
      const period = { '7': '7D', '30': '30D', '90': '90D' }[periodKey] || null
      if (!period) continue
      
      const rows = traders.slice(0, 200).map(t => ({
        source: 'gains',
        source_trader_id: (t.address || '').toLowerCase(),
        season_id: period,
        roi: parseFloat(String(t.roi || t.total_pnl_percentage || 0)),
        pnl: parseFloat(String(t.total_pnl_usd || t.pnl || 0)),
        win_rate: t.wins != null && t.total_trades ? (t.wins / t.total_trades * 100) : null,
        trades_count: parseInt(String(t.total_trades || 0)) || null,
        captured_at: new Date().toISOString(),
      })).filter(r => r.source_trader_id)
      
      if (rows.length > 0) {
        for (let i = 0; i < rows.length; i += 50) {
          const { error } = await supabase.from('trader_snapshots').upsert(rows.slice(i, i + 50), {
            onConflict: 'source,source_trader_id,season_id',
          })
          if (error) console.error(`    ${chain}/${period} batch error:`, error.message)
        }
        totalTraders += rows.length
        console.log(`    ${chain}/${period}: ${rows.length} traders`)
      }
    }
  }
  
  await page.close()
  console.log(`  ✅ Total Gains traders: ${totalTraders}`)
  return totalTraders
}

// ── Main ─────────────────────────────────────────────────
async function main() {
  console.log('Puppeteer Batch Import')
  console.log(`Target: ${target}`)
  console.log(`Time: ${new Date().toISOString()}\n`)
  
  const browser = await launchBrowser()
  const results = {}
  
  try {
    if (target === 'all' || target === 'bingx') results.bingx = await importBingx(browser)
    if (target === 'all' || target === 'bitmart') results.bitmart = await importBitmart(browser)
    if (target === 'all' || target === 'gains') results.gains = await importGains(browser)
  } finally {
    await browser.close()
  }
  
  console.log('\n=== Results ===')
  for (const [k, v] of Object.entries(results)) {
    console.log(`  ${k}: ${v} traders`)
  }
}

main().catch(console.error)
