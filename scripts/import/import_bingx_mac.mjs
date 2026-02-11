/**
 * BingX Copy Trading - Mac Mini版 (Playwright + API Pagination)
 *
 * Strategy: Use Playwright to load the page (bypasses CF), intercept the
 * signed API request headers, then paginate through ALL traders via the
 * recommend endpoint.
 *
 * API: POST api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/recommend?pageId={n}&pageSize=50
 * Returns: { data: { total, result: [{ trader, rankStat }] } }
 *
 * Usage: node scripts/import/import_bingx_mac.mjs [7D|30D|90D|ALL]
 */
import { chromium } from 'playwright'
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'bingx'
const PAGE_SIZE = 50
const API_BASE = 'https://api-app.qq-os.com'
const RECOMMEND_PATH = '/api/copy-trade-facade/v2/trader/new/recommend'
const PROXY = 'http://127.0.0.1:7890'

// Period mapping for BingX fields
const PERIOD_MAP = {
  '7D':  { roiField: 'strRecent7DaysRate',  pnlField: 'cumulativeProfitLoss7d',  winRateField: 'winRate7d',  mddField: 'maxDrawDown7dV2' },
  '30D': { roiField: 'strRecent30DaysRate', pnlField: 'cumulativeProfitLoss30d', winRateField: 'winRate30d', mddField: 'maxDrawDown30dV2' },
  '90D': { roiField: 'strRecent90DaysRate', pnlField: 'cumulativeProfitLoss90d', winRateField: 'winRate90d', mddField: 'maxDrawDown90dV2' },
}

function parsePercent(s) {
  if (s === null || s === undefined) return 0
  if (typeof s === 'number') return s
  return parseFloat(String(s).replace(/[+%,]/g, '')) || 0
}

function parseNumber(s) {
  if (s === null || s === undefined) return 0
  if (typeof s === 'number') return s
  return parseFloat(String(s).replace(/[+,]/g, '')) || 0
}

function extractTrader(item, period) {
  const t = item.trader || {}
  const rs = item.rankStat || {}
  const uid = String(t.uid || '')
  if (!uid || uid === 'undefined') return null
  const name = t.nickName || t.realNickName || ''
  if (!name) return null

  const pm = PERIOD_MAP[period]
  const roi = parsePercent(rs[pm.roiField])
  const pnl = parseNumber(rs[pm.pnlField])
  const winRate = typeof rs[pm.winRateField] === 'number' ? rs[pm.winRateField] * 100 : parsePercent(rs.winRate)
  const mdd = parsePercent(rs[pm.mddField]) || parsePercent(rs.maxDrawDown)
  const copiers = parseInt(rs.strFollowerNum) || 0

  return {
    uid,
    name,
    avatar: t.avatar || null,
    shortUid: t.shortUid || null,
    roi,
    pnl,
    winRate,
    mdd,
    copiers,
  }
}

/**
 * Use Playwright to get a browser context that passes CF, then paginate the API
 */
async function scrapeAllTraders() {
  console.log('🚀 BingX: 启动浏览器获取API签名...')
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: PROXY },
  })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  })
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })

  const page = await context.newPage()
  let capturedHeaders = null

  // Capture signed headers from the first recommend request
  page.on('request', req => {
    if (req.url().includes('recommend') && req.method() === 'POST' && !capturedHeaders) {
      const h = req.headers()
      capturedHeaders = {
        'platformid': h['platformid'],
        'appid': h['appid'],
        'mainappid': h['mainappid'],
        'lang': h['lang'] || 'en',
        'appsiteid': h['appsiteid'] || '0',
        'timezone': h['timezone'] || '-8',
        'x-requested-with': 'XMLHttpRequest',
        'accept': 'application/json, text/plain, */*',
        'channel': h['channel'] || 'official',
        'device_id': h['device_id'],
        'reg_channel': h['reg_channel'] || 'official',
        'sign': h['sign'],
        'antideviceid': h['antideviceid'] || '',
        'accept-language': 'en-US',
        'app_version': h['app_version'] || '5.3.28',
        'device_brand': h['device_brand'],
        'traceid': h['traceid'],
        'timestamp': h['timestamp'],
        'user-agent': h['user-agent'],
        'referer': 'https://bingx.com/',
        'origin': 'https://bingx.com',
      }
      console.log('  ✅ Captured API headers')
    }
  })

  console.log('  导航到 CopyTrading...')
  await page.goto('https://bingx.com/en/copytrading/', { timeout: 60000, waitUntil: 'domcontentloaded' })
  await sleep(15000)

  if (!capturedHeaders) {
    console.log('  ⚠️ No headers captured from initial load, trying scroll...')
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 500))
      await sleep(2000)
    }
  }

  if (!capturedHeaders) {
    console.error('  ❌ Failed to capture API headers')
    await browser.close()
    return []
  }

  // Now use the browser context to make paginated requests
  console.log('\n📡 开始分页抓取所有traders...')
  const allResults = []
  let total = 0
  let pageId = 0

  while (true) {
    const url = `${API_BASE}${RECOMMEND_PATH}?pageId=${pageId}&pageSize=${PAGE_SIZE}`
    
    try {
      const response = await page.evaluate(async ({ url, headers }) => {
        const resp = await fetch(url, {
          method: 'POST',
          headers,
          credentials: 'include',
        })
        return resp.json()
      }, { url, headers: capturedHeaders })

      if (response.code !== 0) {
        console.log(`  ⚠️ Page ${pageId}: code=${response.code}, msg=${response.msg}`)
        // Try with updated timestamp
        capturedHeaders.timestamp = String(Date.now())
        const retry = await page.evaluate(async ({ url, headers }) => {
          const resp = await fetch(url, { method: 'POST', headers, credentials: 'include' })
          return resp.json()
        }, { url, headers: capturedHeaders })
        if (retry.code !== 0) {
          console.log(`  ❌ Retry failed, stopping.`)
          break
        }
      }

      const results = response.data?.result || []
      total = response.data?.total || total

      if (results.length === 0) {
        console.log(`  Page ${pageId}: empty, done.`)
        break
      }

      allResults.push(...results)
      console.log(`  Page ${pageId}: +${results.length} traders (${allResults.length}/${total})`)

      if (allResults.length >= total) break

      pageId++
      await sleep(800 + Math.random() * 500)
    } catch (e) {
      console.error(`  ❌ Page ${pageId} error: ${e.message}`)
      break
    }
  }

  await browser.close()
  console.log(`\n📊 抓取完成: ${allResults.length} raw results (total reported: ${total})`)
  return allResults
}

async function saveTraders(rawResults, period) {
  // Extract and deduplicate
  const traders = new Map()
  for (const item of rawResults) {
    const t = extractTrader(item, period)
    if (t && !traders.has(t.uid)) {
      traders.set(t.uid, t)
    }
  }

  const traderList = [...traders.values()]
  if (traderList.length === 0) return 0

  // Sort by ROI descending for ranking
  traderList.sort((a, b) => b.roi - a.roi)
  const capturedAt = new Date().toISOString()

  // Save sources
  const sources = traderList.map(t => ({
    source: SOURCE,
    source_trader_id: t.uid,
    handle: t.name,
    avatar_url: t.avatar,
    profile_url: `https://bingx.com/en/CopyTrading/trader-detail/${t.shortUid || t.uid}`,
    is_active: true,
  }))

  for (let i = 0; i < sources.length; i += 50) {
    const { error } = await supabase.from('trader_sources').upsert(sources.slice(i, i + 50), { onConflict: 'source,source_trader_id' })
    if (error) console.log(`  ⚠️ source upsert error: ${error.message}`)
  }

  // Save snapshots
  let saved = 0
  const snapshots = traderList.map((t, idx) => {
    const scores = calculateArenaScore(t.roi, t.pnl, t.mdd, t.winRate, period)
    return {
      source: SOURCE,
      source_trader_id: t.uid,
      season_id: period,
      rank: idx + 1,
      roi: t.roi,
      pnl: t.pnl,
      win_rate: t.winRate,
      max_drawdown: t.mdd,
      followers: t.copiers,
      arena_score: scores.totalScore,
      captured_at: capturedAt,
    }
  })

  for (let i = 0; i < snapshots.length; i += 50) {
    const batch = snapshots.slice(i, i + 50)
    const { error } = await supabase.from('trader_snapshots').upsert(batch, { onConflict: 'source,source_trader_id,season_id' })
    if (!error) saved += batch.length
    else console.log(`  ⚠️ snapshot upsert error: ${error.message}`)
  }

  return saved
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])
  console.log('BingX 数据抓取开始...')
  console.log(`周期: ${periods.join(', ')}`)

  const rawResults = await scrapeAllTraders()

  if (rawResults.length === 0) {
    console.log('❌ 未获取到数据')
    process.exit(1)
  }

  let totalSaved = 0
  for (const period of periods) {
    const saved = await saveTraders(rawResults, period)
    totalSaved += saved
    console.log(`  ${period}: saved ${saved} traders`)
  }

  console.log(`\n✅ BingX 完成，共保存 ${totalSaved} 条记录`)
}

main().catch(e => { console.error(e); process.exit(1) })
