#!/usr/bin/env node
/**
 * Enrich trader_snapshots with win_rate, max_drawdown, trades_count, aum
 * for MEXC, Bitget Spot, Bitget Futures, and BloFin.
 *
 * Uses puppeteer (browser) for Bitget (Cloudflare) and MEXC.
 * Uses playwright for BloFin (Cloudflare).
 *
 * Usage:
 *   node scripts/import/enrich_snapshots_all.mjs [mexc|bitget_spot|bitget_futures|blofin] [--dry-run]
 */

import 'dotenv/config'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { sb, sleep, cs } from './lib/index.mjs'

puppeteer.use(StealthPlugin())

const DRY_RUN = process.argv.includes('--dry-run')
const PROXY = 'http://127.0.0.1:7890'
const SEASONS = ['7D', '30D', '90D']
const BITGET_CYCLE = { '7D': 7, '30D': 30, '90D': 90 }

// ============================================
// Helpers
// ============================================
async function countNulls(source) {
  const result = {}
  for (const s of SEASONS) {
    const { data } = await sb.from('trader_snapshots')
      .select('id', { count: 'exact', head: true })
      .eq('source', source).eq('season_id', s)
    const { count: wrNull } = await sb.from('trader_snapshots')
      .select('id', { count: 'exact', head: true })
      .eq('source', source).eq('season_id', s).is('win_rate', null)
    const { count: mddNull } = await sb.from('trader_snapshots')
      .select('id', { count: 'exact', head: true })
      .eq('source', source).eq('season_id', s).is('max_drawdown', null)
    const { count: tcNull } = await sb.from('trader_snapshots')
      .select('id', { count: 'exact', head: true })
      .eq('source', source).eq('season_id', s).is('trades_count', null)
    result[s] = { total: data, wrNull, mddNull, tcNull }
  }
  return result
}

async function getDistinctTraderIds(source) {
  // Get all unique source_trader_ids that have at least one null field
  const { data } = await sb.from('trader_snapshots')
    .select('source_trader_id')
    .eq('source', source)
    .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
  if (!data) return []
  return [...new Set(data.map(r => r.source_trader_id))]
}

async function updateSnapshots(source, traderId, updates) {
  if (DRY_RUN || Object.keys(updates).length === 0) return 0
  let count = 0
  for (const s of SEASONS) {
    // Get existing snapshot
    const { data: snaps } = await sb.from('trader_snapshots')
      .select('id, roi, pnl, win_rate, max_drawdown, trades_count, aum')
      .eq('source', source)
      .eq('source_trader_id', traderId)
      .eq('season_id', s)

    if (!snaps?.length) continue

    for (const snap of snaps) {
      const u = {}
      if (snap.win_rate == null && updates.win_rate != null) u.win_rate = updates.win_rate
      if (snap.max_drawdown == null && updates.max_drawdown != null) u.max_drawdown = updates.max_drawdown
      if (snap.trades_count == null && updates.trades_count != null) u.trades_count = updates.trades_count
      if (snap.aum == null && updates.aum != null) u.aum = updates.aum

      if (Object.keys(u).length === 0) continue

      // Recalculate arena_score
      const roi = snap.roi
      const pnl = snap.pnl
      const mdd = u.max_drawdown ?? snap.max_drawdown
      const wr = u.win_rate ?? snap.win_rate
      const score = cs(roi, pnl, mdd, wr)
      if (score != null) u.arena_score = score

      const { error } = await sb.from('trader_snapshots').update(u).eq('id', snap.id)
      if (!error) count++
    }
  }
  return count
}

// ============================================
// Bitget (spot + futures) enrichment
// ============================================
async function enrichBitget(source) {
  const isSpot = source === 'bitget_spot'
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Enriching ${source} via Bitget cycleData API`)
  console.log(`${'='.repeat(60)}`)

  const traderIds = await getDistinctTraderIds(source)
  // Filter to valid hex IDs
  const validIds = traderIds.filter(id => /^[a-f0-9]{10,}$/.test(id))
  console.log(`Traders needing enrichment: ${traderIds.length} (valid hex: ${validIds.length})`)

  if (validIds.length === 0) return

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  let enriched = 0, errors = 0

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

    console.log('Getting Cloudflare clearance...')
    await page.goto('https://www.bitget.com/copy-trading', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
    await sleep(5000)
    await page.evaluate(() => {
      document.querySelectorAll('button').forEach(btn => {
        if ((btn.textContent || '').match(/OK|Got|Accept|I understand/i)) try { btn.click() } catch {}
      })
    }).catch(() => {})
    await sleep(1000)
    console.log('Browser ready')

    for (let i = 0; i < validIds.length; i++) {
      const tid = validIds[i]
      try {
        // Use 90D cycleData (most comprehensive)
        const result = await page.evaluate(async (uid) => {
          try {
            const r = await fetch('/v1/trigger/trace/public/cycleData', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ languageType: 0, triggerUserId: uid, cycleTime: 90 }),
            })
            return await r.json()
          } catch (e) { return { error: e.message } }
        }, tid)

        if (result?.code === '00000' && result.data?.statisticsDTO) {
          const s = result.data.statisticsDTO
          const updates = {}
          if (s.winningRate != null) {
            let wr = parseFloat(s.winningRate)
            if (wr > 0 && wr <= 1) wr *= 100
            updates.win_rate = Math.round(wr * 100) / 100
          }
          if (s.maxRetracement != null) {
            updates.max_drawdown = Math.round(Math.abs(parseFloat(s.maxRetracement)) * 100) / 100
          }
          if (s.totalTrades != null) {
            updates.trades_count = parseInt(s.totalTrades)
          }
          if (s.aum != null) {
            updates.aum = parseFloat(s.aum)
          }

          if (Object.keys(updates).length > 0) {
            const n = await updateSnapshots(source, tid, updates)
            if (n > 0) enriched++
          }
        } else if (result?.error || result?.code !== '00000') {
          // Check if we got blocked
          if (result?.msg?.includes('frequent') || result?.msg?.includes('limit')) {
            console.log(`  Rate limited, waiting 10s...`)
            await sleep(10000)
            i-- // retry
            continue
          }
          errors++
        }
      } catch (e) {
        errors++
      }

      if ((i + 1) % 50 === 0 || i === validIds.length - 1) {
        console.log(`  [${i + 1}/${validIds.length}] enriched=${enriched} errors=${errors}`)
      }
      await sleep(600 + Math.random() * 400)
    }
  } finally {
    await browser.close()
  }

  console.log(`✅ ${source}: enriched ${enriched} traders, ${errors} errors`)
}

// ============================================
// MEXC enrichment
// ============================================
async function enrichMEXC() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Enriching MEXC via browser API`)
  console.log(`${'='.repeat(60)}`)

  const traderIds = await getDistinctTraderIds('mexc')
  const numericIds = traderIds.filter(id => /^\d+$/.test(id))
  const handleIds = traderIds.filter(id => !/^\d+$/.test(id))
  console.log(`Traders needing enrichment: ${traderIds.length} (numeric: ${numericIds.length}, handles: ${handleIds.length})`)

  if (traderIds.length === 0) return

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      `--proxy-server=${PROXY}`,
    ],
  })

  let enriched = 0, errors = 0

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

    console.log('Loading MEXC copy trading page...')
    await page.goto('https://www.mexc.com/futures/copyTrade/home', { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {})
    await sleep(8000)

    // Close popups
    await page.evaluate(() => {
      document.querySelectorAll('button, [class*="close"]').forEach(el => {
        const text = (el.textContent || '').trim()
        if (['关闭', 'OK', 'Got it', '确定', 'Close', 'I understand', '知道了'].some(t => text.includes(t))) {
          try { el.click() } catch {}
        }
      })
    }).catch(() => {})
    await sleep(2000)

    // Discover which API endpoints work
    console.log('Discovering MEXC API endpoints...')
    const endpoints = [
      'https://contract.mexc.com/api/v1/copytrading/v2/public/trader/detail',
      'https://contract.mexc.com/api/v1/copytrading/public/trader/detail',
      'https://futures.mexc.com/api/v1/contract/copyTrade/leader/detail',
    ]

    let workingEndpoint = null
    const testId = numericIds[0] || '03923304'

    for (const ep of endpoints) {
      const result = await page.evaluate(async (url, tid) => {
        try {
          const r = await fetch(`${url}?traderId=${tid}`)
          const j = await r.json()
          return j
        } catch (e) { return { error: e.message } }
      }, ep, testId)
      
      if (result?.success !== false && result?.data) {
        workingEndpoint = ep
        console.log(`  ✅ Working endpoint: ${ep}`)
        console.log(`  Sample data keys: ${Object.keys(result.data).join(', ')}`)
        break
      } else {
        console.log(`  ❌ ${ep}: ${result?.message || result?.error || 'no data'}`)
      }
    }

    // Also try in-page fetch (same origin)
    if (!workingEndpoint) {
      console.log('  Trying same-origin API paths...')
      const paths = [
        '/api/copy-trade/v1/detail/',
        '/api/platform/spot/market/copy-trade/trader/detail/',
      ]
      for (const path of paths) {
        const result = await page.evaluate(async (p, tid) => {
          try {
            const r = await fetch(p + tid)
            const text = await r.text()
            try { return JSON.parse(text) } catch { return { raw: text.slice(0, 200) } }
          } catch (e) { return { error: e.message } }
        }, path, testId)

        if (result?.data) {
          workingEndpoint = path
          console.log(`  ✅ Working path: ${path}`)
          break
        } else {
          console.log(`  ❌ ${path}: ${JSON.stringify(result).slice(0, 100)}`)
        }
      }
    }

    // Try the trader list/search API as fallback (can get win_rate from list results)
    if (!workingEndpoint) {
      console.log('  Trying list/search API for batch data...')
      
      // Try to get data from the rank/list API
      const listEndpoints = [
        { url: '/api/copy-trade/v1/rank', method: 'POST', body: { pageNum: 1, pageSize: 100, period: 90 } },
        { url: '/api/copy-trade/v1/list', method: 'POST', body: { pageNum: 1, pageSize: 100, period: 90 } },
      ]
      
      for (const le of listEndpoints) {
        const result = await page.evaluate(async (ep) => {
          try {
            const opts = ep.method === 'POST' 
              ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ep.body) }
              : {}
            const r = await fetch(ep.url, opts)
            const text = await r.text()
            try { return JSON.parse(text) } catch { return { raw: text.slice(0, 300) } }
          } catch (e) { return { error: e.message } }
        }, le)
        console.log(`  ${le.url}: ${JSON.stringify(result).slice(0, 200)}`)
      }
    }

    // Process numeric IDs if we found a working endpoint
    if (workingEndpoint) {
      console.log(`\nProcessing ${numericIds.length} numeric IDs...`)
      for (let i = 0; i < numericIds.length; i++) {
        const tid = numericIds[i]
        try {
          const isPath = workingEndpoint.startsWith('/')
          const url = isPath ? `${workingEndpoint}${tid}` : `${workingEndpoint}?traderId=${tid}`
          
          const result = await page.evaluate(async (u) => {
            try {
              const r = await fetch(u)
              return await r.json()
            } catch (e) { return { error: e.message } }
          }, url)

          if (result?.data) {
            const d = result.data
            const updates = {}
            
            // Try various field names
            const wr = d.winRatio ?? d.winRate ?? d.win_rate
            if (wr != null) {
              let v = parseFloat(wr)
              if (v > 0 && v <= 1) v *= 100
              updates.win_rate = Math.round(v * 100) / 100
            }
            
            const mdd = d.maxDrawdown ?? d.mdd ?? d.max_drawdown
            if (mdd != null) {
              let v = Math.abs(parseFloat(mdd))
              if (v > 0 && v <= 1) v *= 100
              updates.max_drawdown = Math.round(v * 100) / 100
            }
            
            const tc = d.tradeCount ?? d.totalTrades ?? d.trades_count ?? d.orderCount
            if (tc != null) updates.trades_count = parseInt(tc)
            
            const aum = d.aum ?? d.assets
            if (aum != null) updates.aum = parseFloat(aum)
            
            if (Object.keys(updates).length > 0) {
              const n = await updateSnapshots('mexc', tid, updates)
              if (n > 0) enriched++
            }
          }
        } catch { errors++ }

        if ((i + 1) % 50 === 0 || i === numericIds.length - 1) {
          console.log(`  [${i + 1}/${numericIds.length}] enriched=${enriched} errors=${errors}`)
        }
        await sleep(500 + Math.random() * 300)
      }
    } else {
      console.log('\n⚠ No working MEXC API endpoint found. Trying browser scraping approach...')
      
      // Fallback: navigate to individual trader pages and scrape
      const allIds = [...numericIds, ...handleIds]
      for (let i = 0; i < Math.min(allIds.length, 50); i++) {
        const tid = allIds[i]
        try {
          // Navigate to trader profile page
          await page.goto(`https://www.mexc.com/futures/copyTrade/trader/${tid}`, {
            waitUntil: 'networkidle2', timeout: 15000
          }).catch(() => {})
          await sleep(3000)
          
          // Extract data from the page
          const data = await page.evaluate(() => {
            const text = document.body.innerText || ''
            const result = {}
            
            // Look for win rate patterns
            const wrMatch = text.match(/(?:Win Rate|胜率)[:\s]*([0-9.]+)%/i)
            if (wrMatch) result.win_rate = parseFloat(wrMatch[1])
            
            // Max drawdown
            const mddMatch = text.match(/(?:Max Drawdown|最大回撤)[:\s]*([0-9.]+)%/i)
            if (mddMatch) result.max_drawdown = parseFloat(mddMatch[1])
            
            // Trades count
            const tcMatch = text.match(/(?:Total Trades|交易次数|Trades)[:\s]*([0-9,]+)/i)
            if (tcMatch) result.trades_count = parseInt(tcMatch[1].replace(/,/g, ''))
            
            return Object.keys(result).length > 0 ? result : null
          })
          
          if (data) {
            const n = await updateSnapshots('mexc', tid, data)
            if (n > 0) enriched++
          }
        } catch { errors++ }

        if ((i + 1) % 10 === 0) {
          console.log(`  [${i + 1}/${Math.min(allIds.length, 50)}] enriched=${enriched} errors=${errors}`)
        }
      }
    }

    // Handle non-numeric IDs via search
    if (workingEndpoint && handleIds.length > 0) {
      console.log(`\nProcessing ${handleIds.length} handle IDs via search...`)
      let searchOk = 0
      for (let i = 0; i < handleIds.length; i++) {
        const handle = handleIds[i]
        try {
          // Search by keyword
          const searchResult = await page.evaluate(async (keyword) => {
            const endpoints = [
              `https://contract.mexc.com/api/v1/copytrading/v2/public/trader/list?pageNum=1&pageSize=20&keyword=${encodeURIComponent(keyword)}`,
              `https://contract.mexc.com/api/v1/copytrading/public/trader/list?pageNum=1&pageSize=20&keyword=${encodeURIComponent(keyword)}`,
            ]
            for (const url of endpoints) {
              try {
                const r = await fetch(url)
                const j = await r.json()
                if (j?.data?.list?.length) return j.data.list
              } catch {}
            }
            return null
          }, handle)

          if (searchResult) {
            const match = searchResult.find(t =>
              (t.nickName || t.name || '').toLowerCase() === handle.toLowerCase()
            )
            if (match) {
              const d = match
              const updates = {}
              const wr = d.winRatio ?? d.winRate
              if (wr != null) {
                let v = parseFloat(wr)
                if (v > 0 && v <= 1) v *= 100
                updates.win_rate = Math.round(v * 100) / 100
              }
              const mdd = d.maxDrawdown ?? d.mdd
              if (mdd != null) {
                let v = Math.abs(parseFloat(mdd))
                if (v > 0 && v <= 1) v *= 100
                updates.max_drawdown = Math.round(v * 100) / 100
              }
              const tc = d.tradeCount ?? d.totalTrades
              if (tc != null) updates.trades_count = parseInt(tc)

              if (Object.keys(updates).length > 0) {
                const n = await updateSnapshots('mexc', handle, updates)
                if (n > 0) { enriched++; searchOk++ }
              }
            }
          }
        } catch { errors++ }

        if ((i + 1) % 50 === 0) {
          console.log(`  [${i + 1}/${handleIds.length}] searchOk=${searchOk} errors=${errors}`)
        }
        await sleep(500)
      }
    }
  } finally {
    await browser.close()
  }

  console.log(`✅ MEXC: enriched ${enriched} traders, ${errors} errors`)
}

// ============================================
// BloFin enrichment
// ============================================
async function enrichBloFin() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Enriching BloFin via browser API`)
  console.log(`${'='.repeat(60)}`)

  const traderIds = await getDistinctTraderIds('blofin')
  console.log(`Traders needing enrichment: ${traderIds.length}`)

  if (traderIds.length === 0) return

  // Use puppeteer with proxy for BloFin (CF protected)
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      `--proxy-server=${PROXY}`,
    ],
  })

  let enriched = 0, errors = 0

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

    console.log('Loading BloFin copy trading page...')
    await page.goto('https://blofin.com/copy-trade?tab=leaderboard&module=futures', {
      waitUntil: 'domcontentloaded', timeout: 45000
    }).catch(() => {})
    await sleep(10000)

    const title = await page.title()
    console.log(`Page title: ${title}`)
    if (title.includes('moment') || title.includes('Check')) {
      console.log('Cloudflare challenge, waiting...')
      await sleep(20000)
    }

    // Discover detail API
    console.log('Discovering BloFin detail API...')
    const detailEndpoints = [
      { path: '/uapi/v1/copy/trader/detail', method: 'POST' },
      { path: '/uapi/v1/copy/trader/detail', method: 'GET' },
      { path: '/uapi/v1/copy/trader/info', method: 'POST' },
      { path: '/uapi/v1/copy/trader/info', method: 'GET' },
    ]

    const testId = traderIds[0]
    let workingDetail = null

    for (const ep of detailEndpoints) {
      const result = await page.evaluate(async (path, method, uid) => {
        try {
          const opts = method === 'POST'
            ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uniqueName: uid }) }
            : {}
          const url = method === 'GET' ? `${path}?uniqueName=${uid}` : path
          const r = await fetch(url, opts)
          return await r.json()
        } catch (e) { return { error: e.message } }
      }, ep.path, ep.method, testId)

      console.log(`  ${ep.method} ${ep.path}: ${JSON.stringify(result).slice(0, 200)}`)
      if (result?.code === 200 && result?.data) {
        workingDetail = ep
        console.log(`  ✅ Working!`)
        break
      }
    }

    // Also try the rank endpoint to get data for all traders at once
    console.log('Trying rank endpoint for batch data...')
    const rankResult = await page.evaluate(async () => {
      try {
        const r = await fetch('/uapi/v1/copy/trader/rank', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nick_name: '', limit: 200 }),
        })
        return await r.json()
      } catch (e) { return { error: e.message } }
    })

    if (rankResult?.code === 200 && rankResult.data) {
      // Build a map of trader data from rank results
      const traderMap = new Map()
      for (const [key, list] of Object.entries(rankResult.data)) {
        if (!Array.isArray(list)) continue
        for (const t of list) {
          const id = String(t.uid || t.uniqueName || '')
          if (!id) continue
          const existing = traderMap.get(id) || {}
          traderMap.set(id, {
            ...existing,
            win_rate: t.winRate != null ? (parseFloat(t.winRate) <= 1 ? parseFloat(t.winRate) * 100 : parseFloat(t.winRate)) : existing.win_rate,
            max_drawdown: t.mdd != null ? Math.abs(parseFloat(t.mdd)) : existing.max_drawdown,
            trades_count: t.trades_count ?? t.totalTrades ?? existing.trades_count,
            aum: t.aum != null ? parseFloat(t.aum) : existing.aum,
          })
        }
      }

      console.log(`  Rank data: ${traderMap.size} traders`)

      // Update snapshots from rank data
      for (const tid of traderIds) {
        const data = traderMap.get(tid)
        if (data && Object.values(data).some(v => v != null)) {
          const n = await updateSnapshots('blofin', tid, data)
          if (n > 0) enriched++
        }
      }
    }

    // Try individual detail fetches for remaining traders
    if (workingDetail) {
      const remaining = traderIds.filter(async tid => {
        // Check if still has nulls
        return true // Process all, updateSnapshots will skip if already filled
      })

      console.log(`\nFetching individual details for ${remaining.length} traders...`)
      for (let i = 0; i < remaining.length; i++) {
        const tid = remaining[i]
        try {
          const result = await page.evaluate(async (path, method, uid) => {
            try {
              const opts = method === 'POST'
                ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uniqueName: uid }) }
                : {}
              const url = method === 'GET' ? `${path}?uniqueName=${uid}` : path
              const r = await fetch(url, opts)
              return await r.json()
            } catch (e) { return { error: e.message } }
          }, workingDetail.path, workingDetail.method, tid)

          if (result?.code === 200 && result?.data) {
            const d = result.data
            const updates = {}
            if (d.winRate != null) {
              let v = parseFloat(d.winRate)
              if (v > 0 && v <= 1) v *= 100
              updates.win_rate = Math.round(v * 100) / 100
            }
            if (d.mdd != null) updates.max_drawdown = Math.round(Math.abs(parseFloat(d.mdd)) * 100) / 100
            if (d.totalTrades != null) updates.trades_count = parseInt(d.totalTrades)
            if (d.aum != null) updates.aum = parseFloat(d.aum)

            if (Object.keys(updates).length > 0) {
              const n = await updateSnapshots('blofin', tid, updates)
              if (n > 0) enriched++
            }
          }
        } catch { errors++ }

        if ((i + 1) % 20 === 0 || i === remaining.length - 1) {
          console.log(`  [${i + 1}/${remaining.length}] enriched=${enriched} errors=${errors}`)
        }
        await sleep(800 + Math.random() * 400)
      }
    }
  } finally {
    await browser.close()
  }

  console.log(`✅ BloFin: enriched ${enriched} traders, ${errors} errors`)
}

// ============================================
// Main
// ============================================
async function main() {
  const target = process.argv[2]?.toLowerCase()
  const targets = target && !target.startsWith('--')
    ? [target]
    : ['bitget_futures', 'bitget_spot', 'mexc', 'blofin']

  console.log(`\n${'#'.repeat(60)}`)
  console.log(`# Snapshot Enrichment — ${new Date().toISOString()}`)
  console.log(`# Targets: ${targets.join(', ')}`)
  console.log(`# Dry run: ${DRY_RUN}`)
  console.log(`${'#'.repeat(60)}`)

  // Before counts
  console.log('\n--- BEFORE ---')
  const beforeCounts = {}
  for (const t of targets) {
    beforeCounts[t] = await countNulls(t)
    for (const [s, c] of Object.entries(beforeCounts[t])) {
      console.log(`  ${t} ${s}: WR null=${c.wrNull}, MDD null=${c.mddNull}, TC null=${c.tcNull}`)
    }
  }

  // Run enrichments
  for (const t of targets) {
    if (t === 'bitget_futures' || t === 'bitget_spot') {
      await enrichBitget(t)
    } else if (t === 'mexc') {
      await enrichMEXC()
    } else if (t === 'blofin') {
      await enrichBloFin()
    }
  }

  // After counts
  console.log('\n--- AFTER ---')
  for (const t of targets) {
    const after = await countNulls(t)
    for (const [s, c] of Object.entries(after)) {
      const b = beforeCounts[t][s]
      const wrDelta = b.wrNull - c.wrNull
      const mddDelta = b.mddNull - c.mddNull
      const tcDelta = b.tcNull - c.tcNull
      console.log(`  ${t} ${s}: WR ${b.wrNull}→${c.wrNull} (${wrDelta>0?'+':''}${wrDelta}), MDD ${b.mddNull}→${c.mddNull} (${mddDelta>0?'+':''}${mddDelta}), TC ${b.tcNull}→${c.tcNull} (${tcDelta>0?'+':''}${tcDelta})`)
    }
  }

  console.log('\n✅ All done!')
}

main().catch(console.error)
