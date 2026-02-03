#!/usr/bin/env node
/**
 * 安全刷新脚本 - 逐平台串行处理，避免 SIGKILL
 * 
 * 特性:
 * - 每个平台独立运行，失败不影响其他
 * - 内存监控和日志
 * - 独立进程隔离，避免内存累积
 * - 完整日志记录到 logs/
 * 
 * 用法: node scripts/import/refresh-safe.mjs [--platform=xxx] [--skip-browser]
 */
import { spawn, execSync } from 'child_process'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../..')
const LOGS_DIR = join(ROOT, 'logs')
const PROXY = 'http://127.0.0.1:7890'

// 确保 logs 目录存在
if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true })

const TODAY = new Date().toISOString().split('T')[0]
const LOG_FILE = join(LOGS_DIR, `refresh-${TODAY}.log`)

function log(msg) {
  const ts = new Date().toISOString()
  const line = `[${ts}] ${msg}`
  console.log(line)
  try { appendFileSync(LOG_FILE, line + '\n') } catch {}
}

function memUsage() {
  const m = process.memoryUsage()
  return `RSS=${Math.round(m.rss/1024/1024)}MB Heap=${Math.round(m.heapUsed/1024/1024)}MB`
}

// 平台定义 - API 平台
const API_PLATFORMS = [
  { name: 'okx', script: 'import_okx_futures.mjs', timeout: 60000 },
  { name: 'htx', script: 'archive/import_htx_enhanced.mjs', timeout: 60000 },
  { name: 'gains', script: 'import_gains.mjs', timeout: 90000 },
  { name: 'dydx', script: 'import_dydx_enhanced.mjs', args: ['30D'], timeout: 180000 },
  { name: 'hyperliquid', inline: 'refreshHyperliquid', timeout: 60000 },
  { name: 'gmx', inline: 'refreshGMX', timeout: 60000 },
  { name: 'binance_futures', inline: 'refreshBinanceFutures', timeout: 120000 },
  { name: 'binance_spot', inline: 'refreshBinanceSpot', timeout: 120000 },
]

// 内联刷新函数 - 避免子进程开销
async function runInlineRefresh(name) {
  // Load env
  try {
    for (const l of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) {
      const m = l.match(/^([^#=]+)=["']?(.+?)["']?$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
    }
  } catch {}

  const { createClient } = await import('@supabase/supabase-js')
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

  const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
  function arenaScore(roi, pnl, dd, wr) {
    if (roi == null) return null
    const r = Math.min(70, roi > 0 ? Math.log(1 + roi / 100) * 25 : Math.max(-70, roi / 100 * 50))
    const d = dd != null ? Math.max(0, 15 * (1 - dd / 100)) : 7.5
    const s = wr != null ? Math.min(15, wr / 100 * 15) : 7.5
    return clip(Math.round((r + d + s) * 10) / 10, 0, 100)
  }

  async function saveBatch(source, traders, market = 'futures') {
    if (!traders.length) return 0
    const now = new Date().toISOString()
    for (let i = 0; i < traders.length; i += 50) {
      try {
        await sb.from('trader_sources').upsert(
          traders.slice(i, i + 50).map(t => ({
            source, source_trader_id: t.id, handle: t.name || t.id,
            avatar_url: t.avatar || null, market_type: t.market || market, is_active: true,
          })), { onConflict: 'source,source_trader_id' }
        )
      } catch {}
    }
    let saved = 0
    for (let i = 0; i < traders.length; i += 30) {
      const { error } = await sb.from('trader_snapshots').upsert(
        traders.slice(i, i + 30).map((t, j) => ({
          source, source_trader_id: t.id, season_id: '30D', rank: i + j + 1,
          roi: t.roi, pnl: t.pnl, win_rate: t.wr, max_drawdown: t.dd,
          trades_count: t.trades, arena_score: arenaScore(t.roi, t.pnl, t.dd, t.wr),
          captured_at: now,
        })), { onConflict: 'source,source_trader_id,season_id' }
      )
      if (!error) saved += Math.min(30, traders.length - i)
    }
    return saved
  }

  function curl(url, opts = {}) {
    const args = ['curl', '-s', '-m', String(opts.timeout || 30), '--compressed']
    if (opts.proxy) args.push('-x', opts.proxy)
    if (opts.method === 'POST') args.push('-X', 'POST')
    if (opts.headers) for (const [k, v] of Object.entries(opts.headers)) args.push('-H', `${k}: ${v}`)
    if (opts.body) args.push('-d', opts.body)
    if (opts.output) args.push('-o', opts.output)
    args.push(url)
    try {
      const result = execSync(args.slice(1).join(' '), { 
        encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout: (opts.timeout || 30) * 1000 + 5000,
        shell: '/bin/bash'
      })
      if (opts.output) return null
      return result || null
    } catch { return null }
  }

  // Hyperliquid
  if (name === 'refreshHyperliquid') {
    const raw = curl('https://stats-data.hyperliquid.xyz/Mainnet/leaderboard', { proxy: PROXY, timeout: 45 })
    if (!raw) throw new Error('Failed to fetch')
    const d = JSON.parse(raw)
    const traders = d.leaderboardRows
      .filter(x => { const p = x.windowPerformances?.find(w => w[0] === 'month'); return p && p[1]?.roi })
      .map(x => { const p = x.windowPerformances.find(w => w[0] === 'month')[1]; return { id: x.ethAddress, roi: parseFloat(p.roi) * 100, pnl: parseFloat(p.pnl) } })
      .filter(x => x.roi > 0).sort((a, b) => b.roi - a.roi).slice(0, 500)
    return await saveBatch('hyperliquid', traders)
  }

  // GMX
  if (name === 'refreshGMX') {
    const raw = curl('https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql', {
      proxy: PROXY, method: 'POST', timeout: 30,
      headers: { 'Content-Type': 'application/json' },
      body: '{"query":"{accountStats(limit:2000,orderBy:realizedPnl_DESC){id wins losses realizedPnl maxCapital closedCount}}"}'
    })
    if (!raw) throw new Error('Failed to fetch')
    const d = JSON.parse(raw)
    const traders = d.data.accountStats
      .filter(s => parseFloat(s.realizedPnl) > 0 && s.closedCount > 5)
      .map(s => {
        const pnl = parseFloat(s.realizedPnl) / 1e30, cap = parseFloat(s.maxCapital) / 1e30
        return { id: s.id, pnl, roi: cap > 0 ? (pnl / cap) * 100 : 0, wr: (s.wins + s.losses) > 0 ? (s.wins / (s.wins + s.losses)) * 100 : null }
      })
      .filter(t => t.roi > 0 && t.roi < 100000).sort((a, b) => b.roi - a.roi).slice(0, 500)
    return await saveBatch('gmx', traders)
  }

  // Binance Futures
  if (name === 'refreshBinanceFutures') {
    const all = []
    for (let p = 1; p <= 25; p++) {
      const body = { pageNumber: p, pageSize: 20, timeRange: '30D', dataType: 'ROI', favoriteOnly: false }
      const raw = curl('https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list', {
        proxy: PROXY, method: 'POST', timeout: 20,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify(body),
      })
      if (!raw) { log(`    Page ${p} failed`); continue }
      try {
        const d = JSON.parse(raw)
        const list = d.data?.list || []
        if (!list.length) break
        for (const it of list) {
          all.push({
            id: it.leadPortfolioId || '',
            name: it.nickname || '',
            roi: it.roi != null ? parseFloat(it.roi) * 100 : null,
            pnl: it.pnl != null ? parseFloat(it.pnl) : null,
            wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
            dd: it.maxDrawDown != null ? parseFloat(it.maxDrawDown) * 100 : null,
          })
        }
      } catch { break }
      await new Promise(r => setTimeout(r, 500))
    }
    const traders = all.filter(t => t.id).map(t => ({ ...t, market: 'futures' }))
    return await saveBatch('binance_futures', traders)
  }

  // Binance Spot
  if (name === 'refreshBinanceSpot') {
    const all = []
    for (let p = 1; p <= 25; p++) {
      const body = { pageNumber: p, pageSize: 20, timeRange: '30D', dataType: 'ROI', order: 'DESC', portfolioType: 'ALL' }
      const raw = curl('https://www.binance.com/bapi/futures/v1/friendly/future/spot-copy-trade/common/home-page-list', {
        proxy: PROXY, method: 'POST', timeout: 20,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify(body),
      })
      if (!raw) { log(`    Page ${p} failed`); continue }
      try {
        const d = JSON.parse(raw)
        const list = d.data?.list || []
        if (!list.length) break
        for (const it of list) {
          all.push({
            id: it.leadPortfolioId || '',
            name: it.nickname || '',
            roi: it.roi != null ? parseFloat(it.roi) : null,
            pnl: it.pnl != null ? parseFloat(it.pnl) : null,
            wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
            dd: it.mdd != null ? parseFloat(it.mdd) : null,
          })
        }
      } catch { break }
      await new Promise(r => setTimeout(r, 500))
    }
    const traders = all.filter(t => t.id).map(t => ({ ...t, market: 'spot' }))
    return await saveBatch('binance_spot', traders, 'spot')
  }

  throw new Error(`Unknown inline function: ${name}`)
}

// 运行外部脚本
function runScript(script, args = [], timeout) {
  return new Promise((resolve, reject) => {
    const scriptPath = join(__dirname, script)
    const proc = spawn('node', [scriptPath, ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    let stdout = '', stderr = ''
    proc.stdout.on('data', d => { stdout += d.toString() })
    proc.stderr.on('data', d => { stderr += d.toString() })

    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error('Timeout'))
    }, timeout)

    proc.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(`Exit ${code}: ${stderr.slice(-200)}`))
    })
  })
}

async function enableProxy() {
  try {
    await fetch('http://127.0.0.1:9090/configs', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'global' })
    })
    log('✓ Proxy enabled (global)')
  } catch (e) {
    log(`⚠ Proxy enable failed: ${e.message}`)
  }
}

async function disableProxy() {
  try {
    await fetch('http://127.0.0.1:9090/configs', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'direct' })
    })
    log('✓ Proxy disabled (direct)')
  } catch {}
}

async function main() {
  const args = process.argv.slice(2)
  const platFilter = args.find(a => a.startsWith('--platform='))?.split('=')[1]?.split(',')
  const skipBrowser = args.includes('--skip-browser')

  log('='.repeat(60))
  log('🔄 Safe Refresh Start')
  log(`Memory: ${memUsage()}`)
  log('='.repeat(60))

  await enableProxy()
  await new Promise(r => setTimeout(r, 1000))

  const results = {}
  let platforms = API_PLATFORMS

  if (platFilter) {
    platforms = platforms.filter(p => platFilter.includes(p.name))
  }

  for (const plat of platforms) {
    log(`\n▶ ${plat.name} (timeout: ${plat.timeout/1000}s)`)
    const startTime = Date.now()

    try {
      let count
      if (plat.inline) {
        count = await runInlineRefresh(plat.inline)
        log(`  ✅ ${plat.name}: ${count} traders saved`)
      } else {
        await runScript(plat.script, plat.args || [], plat.timeout)
        log(`  ✅ ${plat.name}: script completed`)
        count = 'OK'
      }
      results[plat.name] = typeof count === 'number' ? `✅ ${count}` : '✅'
    } catch (e) {
      log(`  ❌ ${plat.name}: ${e.message}`)
      results[plat.name] = `❌ ${e.message.slice(0, 50)}`
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    log(`  Time: ${elapsed}s | Memory: ${memUsage()}`)

    // GC hint
    if (global.gc) global.gc()
  }

  await disableProxy()

  // Summary
  log('\n' + '='.repeat(60))
  log('📊 Results:')
  for (const [k, v] of Object.entries(results)) {
    log(`  ${k}: ${v}`)
  }
  log('='.repeat(60))

  // Write status
  try {
    writeFileSync(join(ROOT, 'logs', 'last-refresh.json'), JSON.stringify({
      timestamp: new Date().toISOString(),
      results,
    }, null, 2))
  } catch {}
}

main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1) })
