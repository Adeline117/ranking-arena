#!/usr/bin/env node
/**
 * VPS-local cron: fetch traders via Playwright scraper and write to Supabase.
 * Runs on the same VPS as the scraper, so no network hop — much faster than
 * Vercel crons going through HTTP proxy chain.
 *
 * Calls scraper at localhost:3457, writes to Supabase via REST API.
 *
 * Usage: node scraper-cron.mjs [platform1,platform2,...]
 * Default: all scraper platforms (bybit, bitget_futures, mexc, bingx)
 *
 * Crontab: 0 0,3,6,9,12,15,18,21 * * * node /opt/arena-cron/scraper-cron.mjs
 */

const SCRAPER_URL = 'http://localhost:3457'
const SCRAPER_KEY = 'arena-proxy-sg-2026'
const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'PASTE_SERVICE_ROLE_KEY_HERE'

// ============================================
// Platform configs: scraper endpoint + periods
// ============================================

const PLATFORMS = {
  bybit: {
    source: 'bybit',
    market_type: 'futures',
    useBatch: true,
    endpoint: '/bybit/leaderboard-batch',
    singleEndpoint: '/bybit/leaderboard',
    periods: {
      'DATA_DURATION_SEVEN_DAY': '7D',
      'DATA_DURATION_THIRTY_DAY': '30D',
      'DATA_DURATION_NINETY_DAY': '90D',
    },
    pageSize: 50,
    extractList: (data) => data?.result?.data || data?.result?.leaderDetails || [],
    normalize: (raw) => {
      const mv = Array.isArray(raw.metricValues) ? raw.metricValues : null
      return {
        trader_key: String(raw.leaderMark || raw.leaderUserId || ''),
        display_name: raw.nickName || null,
        roi: num(raw.roi) ?? parsePercent(mv?.[0]),
        pnl: num(raw.pnl),
        win_rate: num(raw.winRate) ?? parsePercent(mv?.[3]),
        max_drawdown: num(raw.maxDrawdown) ?? parsePercent(mv?.[1]),
        sharpe_ratio: num(raw.sharpeRatio) ?? parsePercent(mv?.[5]),
        followers: num(raw.followerCount) ?? num(raw.maxFollowerCount),
      }
    },
  },

  bitget_futures: {
    source: 'bitget_futures',
    market_type: 'futures',
    endpoint: '/bitget/leaderboard',
    periods: {
      'WEEKLY': '7D',
      'THIRTY_DAYS': '30D',
      'THREE_MONTHS': '90D',
    },
    pageSize: 100,
    extractList: (data) => data?.data?.traderList || [],
    normalize: (raw) => {
      // traderList API returns profitRate/returnRate as decimal ratios (0.155 = 15.5%)
      // and winningRate as decimal (0.72 = 72%). Must convert to percentage.
      const rawRoi = num(raw.profitRate ?? raw.returnRate)
      const rawWr = num(raw.winningRate)
      const rawMdd = num(raw.maxDrawdown)
      return {
        trader_key: String(raw.traderUid || raw.traderId || ''),
        display_name: raw.nickName || raw.traderName || null,
        roi: rawRoi != null ? rawRoi * 100 : null,
        pnl: num(raw.totalProfit ?? raw.allTotalRevenue),
        win_rate: raw.winRate != null ? num(raw.winRate) : (rawWr != null ? rawWr * 100 : null),
        max_drawdown: rawMdd != null && Math.abs(rawMdd) <= 1 ? rawMdd * 100 : rawMdd,
        sharpe_ratio: null,
        followers: num(raw.followerCount ?? raw.traceNum),
      }
    },
  },

  mexc: {
    source: 'mexc',
    market_type: 'futures',
    // 2026-03-31: Direct API with mobile UA bypasses CF WAF (no scraper needed)
    directApi: 'https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/top?limit=100',
    directHeaders: { 'User-Agent': 'MEXC/1.0 (iPhone; iOS 17.0)', 'Accept': 'application/json' },
    endpoint: '/mexc/leaderboard', // VPS scraper fallback
    periods: {
      '1': '7D',
      '2': '30D',
      '3': '90D',
    },
    pageSize: 50,
    extractList: (data) => {
      // MEXC API returns multiple category lists — merge all unique traders
      const dataObj = data?.data ?? {}
      const categories = [
        'comprehensives', 'rois', 'pnls', 'followers', 'newTraders',
        'highPressureTraders', 'lowPressureTraders', 'bullsTraders', 'bearsTraders',
        'intradayTraders', 'longTermTraders', 'goldTraders', 'silverTraders',
        'list', 'resultList',
      ]
      const seen = new Set()
      const merged = []
      for (const key of categories) {
        const list = dataObj[key]
        if (!Array.isArray(list)) continue
        for (const item of list) {
          const uid = String(item.uid || '')
          if (!uid || seen.has(uid)) continue
          seen.add(uid)
          merged.push(item)
        }
      }
      return merged
    },
    normalize: (raw) => {
      const rawRoi = num(raw.yield ?? raw.roi ?? raw.totalRoi ?? raw.pnlRate)
      const roi = rawRoi != null ? (Math.abs(rawRoi) <= 1 ? rawRoi * 100 : rawRoi) : null
      const rawWr = num(raw.winRate ?? raw.totalWinRate)
      const winRate = rawWr != null ? (rawWr <= 1 ? rawWr * 100 : rawWr) : null
      const rawMdd = num(raw.maxRetrace ?? raw.maxDrawdown7 ?? raw.mdd ?? raw.maxDrawdown)
      const maxDrawdown = rawMdd != null ? Math.abs(rawMdd <= 1 ? rawMdd * 100 : rawMdd) : null
      return {
        trader_key: String(raw.uid ?? raw.traderId ?? raw.id ?? raw.userId ?? ''),
        display_name: raw.nickname ?? raw.nickName ?? raw.name ?? null,
        avatar_url: raw.avatar ?? null,
        roi,
        pnl: num(raw.pnl ?? raw.totalPnl ?? raw.profit),
        win_rate: winRate,
        max_drawdown: maxDrawdown,
        sharpe_ratio: null,
        followers: num(raw.followers ?? raw.followerCount ?? raw.copierCount),
        aum: num(raw.equity),
        platform_rank: num(raw.order),
      }
    },
  },

  bingx: {
    source: 'bingx',
    market_type: 'futures',
    endpoint: '/bingx/leaderboard',
    periods: {
      '2': '30D',
    },
    pageSize: 50,
    extractList: (data) => {
      if (data?.data?.global?.result) return data.data.global.result
      if (data?.data?.result) return data.data.result
      if (Array.isArray(data?.data)) return data.data
      return []
    },
    normalize: (raw) => {
      // BingX multi-rank nests trader data under traderInfoVo
      const info = raw.traderInfoVo || {}
      const rawRoi = num(raw.cumulativePnlRate7Days ?? raw.roi ?? raw.roiRate ?? raw.returnRate)
      const roi = rawRoi != null ? (Math.abs(rawRoi) <= 1 ? rawRoi * 100 : rawRoi) : null
      const rawWr = num(raw.winRate)
      const winRate = rawWr != null ? (rawWr <= 1 ? rawWr * 100 : rawWr) : null
      const rawMdd = num(raw.maxDrawdown)
      const maxDrawdown = rawMdd != null ? Math.abs(rawMdd <= 1 ? rawMdd * 100 : rawMdd) : null
      return {
        trader_key: String(info.trader || info.apiIdentity || raw.uniqueId || raw.uid || ''),
        display_name: info.traderName || raw.traderName || raw.nickname || null,
        roi,
        pnl: num(raw.totalEarnings ?? raw.pnl ?? raw.totalPnl ?? raw.profit),
        win_rate: winRate,
        max_drawdown: maxDrawdown,
        sharpe_ratio: null,
        followers: num(raw.followerNum ?? raw.followers ?? raw.followerCount),
      }
    },
  },

  coinex: {
    source: 'coinex',
    market_type: 'futures',
    // CoinEx has no CF protection — direct API works from VPS (geo-blocked from Vercel hnd1)
    directApi: 'https://www.coinex.com/res/copy-trading/public/traders?page=1&limit=50&sort_by=roi&period={period}',
    endpoint: '/coinex/leaderboard', // VPS scraper fallback (currently broken/hanging)
    periods: {
      '7d': '7D',
      '30d': '30D',
      '90d': '90D',
    },
    pageSize: 50,
    extractList: (data) => {
      return data?.data?.data || data?.data?.items || []
    },
    normalize: (raw) => {
      const rawRoi = num(raw.profit_rate)
      // CoinEx returns ROI as decimal (1.33 = 133%)
      const roi = rawRoi != null ? rawRoi * 100 : null
      const rawWr = num(raw.winning_rate)
      const winRate = rawWr != null ? rawWr * 100 : null
      const rawMdd = num(raw.mdd)
      const maxDrawdown = rawMdd != null ? Math.abs(rawMdd) * 100 : null
      return {
        trader_key: String(raw.trader_id ?? ''),
        display_name: raw.nickname ?? null,
        avatar_url: raw.avatar ?? null,
        roi,
        pnl: num(raw.profit_amount ?? raw.total_profit_amount),
        win_rate: winRate,
        max_drawdown: maxDrawdown,
        sharpe_ratio: null,
        followers: num(raw.cur_follower_num),
      }
    },
  },
}

// ============================================
// Helpers
// ============================================

function num(val) {
  if (val === null || val === undefined) return null
  const n = Number(val)
  return isNaN(n) ? null : n
}

function parsePercent(val) {
  if (!val) return null
  const cleaned = String(val).replace(/[+%]/g, '').trim()
  if (!cleaned || cleaned === '--') return null
  const n = Number(cleaned)
  return isNaN(n) ? null : n
}

function ts() {
  return new Date().toISOString()
}

function log(msg) {
  console.log('[' + ts() + '] ' + msg)
}

// ============================================
// Scraper client
// ============================================

async function callScraper(endpoint, params = {}, timeoutMs = 180000) {
  const url = new URL(endpoint, SCRAPER_URL)
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v))
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url.toString(), {
      headers: { 'x-proxy-key': SCRAPER_KEY },
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) {
      throw new Error('Scraper returned ' + res.status + ': ' + (await res.text().catch(() => '')))
    }
    return await res.json()
  } catch (err) {
    clearTimeout(timeout)
    throw err
  }
}

// ============================================
// Supabase REST API client
// ============================================

async function supabaseUpsert(table, rows, onConflict) {
  if (!rows.length) return { count: 0 }

  const CHUNK = 200
  let total = 0

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)

    const res = await fetch(SUPABASE_URL + '/rest/v1/' + table + '?on_conflict=' + onConflict, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(chunk),
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error('Supabase ' + table + ' upsert error (' + res.status + '): ' + errText)
    }
    total += chunk.length
  }

  return { count: total }
}

// ============================================
// Build snapshot rows from normalized data
// ============================================

function buildSnapshotRows(normalized, platform, marketType, window) {
  const now = new Date().toISOString()

  return normalized
    .filter(t => t.trader_key)
    .map(t => {
      const roiCapped = t.roi != null && Math.abs(t.roi) > 100000 ? null : (t.roi ?? null)

      return {
        platform,
        market_type: marketType,
        trader_key: t.trader_key,
        window: window,
        as_of_ts: now,
        roi_pct: roiCapped,
        pnl_usd: t.pnl ?? null,
        win_rate: t.win_rate ?? null,
        max_drawdown: t.max_drawdown ?? null,
        arena_score: t.roi != null ? 0 : null,
        sharpe_ratio: t.sharpe_ratio ?? null,
        trades_count: null,
        followers: t.followers ?? null,
        copiers: null,
        metrics: {
          roi: t.roi ?? null,
          pnl: t.pnl ?? null,
          win_rate: t.win_rate ?? null,
          max_drawdown: t.max_drawdown ?? null,
          trades_count: null,
          followers: t.followers ?? null,
          copiers: null,
          sharpe_ratio: t.sharpe_ratio ?? null,
          arena_score: null,
          aum: null,
        },
      }
    })
}

function buildV1Rows(normalized, source, window) {
  const now = new Date().toISOString()

  return normalized
    .filter(t => t.trader_key)
    .map(t => ({
      source: source,
      source_trader_id: t.trader_key,
      season_id: window,
      rank: null,
      roi: t.roi ?? null,
      pnl: t.pnl ?? null,
      followers: t.followers ?? null,
      win_rate: t.win_rate ?? null,
      max_drawdown: t.max_drawdown ?? null,
      trades_count: null,
      arena_score: null,
      captured_at: now,
    }))
}

// ============================================
// Fetch one platform
// ============================================

async function fetchPlatform(platformKey) {
  const config = PLATFORMS[platformKey]
  if (!config) {
    log('Unknown platform: ' + platformKey)
    return { platform: platformKey, error: 'unknown platform' }
  }

  log('--- ' + platformKey + ' ---')
  let totalTraders = 0
  const results = {}

  // Bybit supports batch endpoint (all periods in one browser session)
  if (config.useBatch) {
    const periodKeys = Object.keys(config.periods)
    log('  Calling batch endpoint with ' + periodKeys.length + ' periods...')

    try {
      const data = await callScraper(config.endpoint, {
        durations: periodKeys.join(','),
        pageSize: config.pageSize,
      })

      for (const [periodKey, window] of Object.entries(config.periods)) {
        const periodData = data[periodKey]
        if (!periodData || periodData.error) {
          log('  ' + window + ': ERROR - ' + (periodData?.error || 'no data'))
          results[window] = { error: periodData?.error || 'no data' }
          continue
        }

        const rawList = config.extractList(periodData)
        if (!rawList.length) {
          log('  ' + window + ': 0 traders (empty)')
          results[window] = { count: 0 }
          continue
        }

        const normalized = rawList.map(config.normalize)
        const v2Rows = buildSnapshotRows(normalized, config.source, config.market_type, window)
        const v1Rows = buildV1Rows(normalized, config.source, window)

        const [v2Result, v1Result] = await Promise.all([
          supabaseUpsert('trader_snapshots_v2', v2Rows, 'platform,trader_key,window').catch(e => ({ error: e.message })),
          supabaseUpsert('trader_snapshots', v1Rows, 'source,source_trader_id,season_id').catch(e => ({ error: e.message })),
        ])

        log('  ' + window + ': ' + normalized.length + ' traders -> v2: ' + (v2Result.count ?? v2Result.error) + ', v1: ' + (v1Result.count ?? v1Result.error))
        results[window] = { count: normalized.length }
        totalTraders += normalized.length
      }
    } catch (err) {
      log('  BATCH ERROR: ' + err.message)
      results['batch'] = { error: err.message }
    }

    return { platform: platformKey, totalTraders, results }
  }

  // Non-batch: call scraper once per period
  for (const [periodKey, window] of Object.entries(config.periods)) {
    log('  Fetching ' + window + ' (param=' + periodKey + ')...')

    try {
      let data
      // Direct API bypass: use mobile UA instead of VPS scraper (faster, no CF WAF issues)
      if (config.directApi) {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 30000)
        try {
          // Substitute {period} placeholder with actual period key (e.g., 90d for CoinEx)
          const apiUrl = config.directApi.replace('{period}', periodKey)
          const res = await fetch(apiUrl, {
            headers: config.directHeaders || {},
            signal: controller.signal,
          })
          clearTimeout(timeout)
          if (res.ok) {
            data = await res.json()
            log('  Direct API success (status ' + res.status + ')')
          } else {
            log('  Direct API failed (status ' + res.status + '), falling back to scraper')
            data = null
          }
        } catch (directErr) {
          clearTimeout(timeout)
          log('  Direct API error: ' + directErr.message + ', falling back to scraper')
          data = null
        }
      }

      // Fallback: VPS Playwright scraper
      if (!data) {
        const params = { pageSize: config.pageSize }
        if (platformKey === 'bitget_futures') {
          params.period = periodKey
        } else if (platformKey === 'mexc') {
          params.periodType = periodKey
        } else if (platformKey === 'bingx') {
          params.timeType = periodKey
        }
        const scraperTimeout = platformKey === 'mexc' ? 300000 : 120000
        data = await callScraper(config.endpoint, params, scraperTimeout)
      }
      const rawList = config.extractList(data)

      if (!rawList.length) {
        log('  ' + window + ': 0 traders (empty)')
        results[window] = { count: 0 }
        continue
      }

      const normalized = rawList.map(config.normalize)
      const v2Rows = buildSnapshotRows(normalized, config.source, config.market_type, window)
      const v1Rows = buildV1Rows(normalized, config.source, window)

      const [v2Result, v1Result] = await Promise.all([
        supabaseUpsert('trader_snapshots_v2', v2Rows, 'platform,trader_key,window').catch(e => ({ error: e.message })),
        supabaseUpsert('trader_snapshots', v1Rows, 'source,source_trader_id,season_id').catch(e => ({ error: e.message })),
      ])

      log('  ' + window + ': ' + normalized.length + ' traders -> v2: ' + (v2Result.count ?? v2Result.error) + ', v1: ' + (v1Result.count ?? v1Result.error))
      results[window] = { count: normalized.length }
      totalTraders += normalized.length
    } catch (err) {
      log('  ' + window + ': ERROR - ' + err.message)
      results[window] = { error: err.message }
    }

    // Small delay between periods to avoid overwhelming the scraper queue
    if (Object.keys(config.periods).length > 1) {
      await new Promise(r => setTimeout(r, 2000))
    }
  }

  return { platform: platformKey, totalTraders, results }
}

// ============================================
// Main
// ============================================

async function main() {
  const startTime = Date.now()
  const args = process.argv[2]
  const requestedPlatforms = args
    ? args.split(',').map(p => p.trim())
    : Object.keys(PLATFORMS)

  log('=== VPS Scraper Cron Start ===')
  log('Platforms: ' + requestedPlatforms.join(', '))

  // Verify scraper is up
  try {
    const health = await fetch(SCRAPER_URL + '/health')
    const h = await health.json()
    log('Scraper: v' + (h.version || '?') + ', busy=' + h.busy + ', queued=' + h.queued)
  } catch (err) {
    log('ERROR: Scraper not reachable at ' + SCRAPER_URL + ': ' + err.message)
    process.exit(1)
  }

  // Process platforms sequentially (scraper has a single-request queue anyway)
  const allResults = []
  for (const p of requestedPlatforms) {
    try {
      const result = await fetchPlatform(p)
      allResults.push(result)
    } catch (err) {
      log('FATAL ERROR on ' + p + ': ' + err.message)
      allResults.push({ platform: p, error: err.message })
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  const totalTraders = allResults.reduce((sum, r) => sum + (r.totalTraders || 0), 0)

  log('=== VPS Scraper Cron Done ===')
  log('Total: ' + totalTraders + ' traders across ' + requestedPlatforms.length + ' platforms in ' + elapsed + 's')

  for (const r of allResults) {
    if (r.error) {
      log('  ' + r.platform + ': FAILED - ' + r.error)
    } else {
      log('  ' + r.platform + ': ' + r.totalTraders + ' traders')
    }
  }
}

main().catch(err => {
  log('UNHANDLED ERROR: ' + err.message)
  console.error(err)
  process.exit(1)
})
