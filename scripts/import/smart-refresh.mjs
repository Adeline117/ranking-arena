#!/usr/bin/env node
/**
 * Smart Refresh - 智能数据刷新脚本
 * 自动尝试多个 API 端点，处理封锁和格式变化
 */

import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { sb } from './lib/index.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../..')

// Load env
try {
  for (const l of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) {
    const m = l.match(/^([^#=]+)=["']?(.+?)["']?$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {}

const PROXY = 'http://127.0.0.1:7890'

function curl(url, opts = {}) {
  const args = ['curl', '-s', '--max-time', String(opts.timeout || 30)]
  if (opts.proxy) args.push('-x', opts.proxy)
  if (opts.method === 'POST') args.push('-X', 'POST')
  if (opts.headers) Object.entries(opts.headers).forEach(([k, v]) => args.push('-H', `${k}: ${v}`))
  if (opts.body) args.push('-d', opts.body)
  args.push(url)
  try {
    const result = execSync(args.join(' '), { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 })
    if (result.startsWith('<!') || result.startsWith('<HTML')) return null
    return result
  } catch { return null }
}

function arenaScore(roi, dd, wr) {
  if (roi == null) return null
  roi = Math.min(9999, roi)
  const r = Math.min(70, roi > 0 ? Math.log(1 + roi / 100) * 25 : Math.max(-70, roi / 100 * 50))
  const d = dd != null ? Math.max(0, 15 * (1 - dd / 100)) : 7.5
  const s = wr != null ? Math.min(15, wr / 100 * 15) : 7.5
  return Math.max(0, Math.min(100, Math.round((r + d + s) * 10) / 10))
}

async function saveBatch(source, traders) {
  const now = new Date().toISOString()
  let saved = 0
  for (const t of traders) {
    if (!t.id) continue
    if (t.roi > 9999) t.roi = 9999
    const score = arenaScore(t.roi, t.dd, t.wr)
    const rec = {
      source,
      source_trader_id: String(t.id),
      roi: t.roi,
      pnl: t.pnl,
      win_rate: t.wr,
      max_drawdown: t.dd,
      arena_score: score,
      season_id: '30D',
      captured_at: now
    }
    const { error } = await sb.from('trader_snapshots').upsert(rec, { 
      onConflict: 'source,source_trader_id,season_id' 
    })
    if (!error) saved++
  }
  return saved
}

// Platform refresh functions
const platforms = {
  async hyperliquid() {
    const raw = curl('https://stats-data.hyperliquid.xyz/Mainnet/leaderboard', { proxy: PROXY, timeout: 45 })
    if (!raw) return 0
    const data = JSON.parse(raw)
    const traders = data.leaderboardRows?.slice(0, 500).map(r => {
      const p = r.windowPerformances?.find(x => x[0] === 'month')?.[1]
      return p ? { id: r.ethAddress, roi: parseFloat(p.roi) * 100, pnl: parseFloat(p.pnl) } : null
    }).filter(Boolean) || []
    return saveBatch('hyperliquid', traders)
  },

  async gmx() {
    // Use direct curl command for GMX due to body escaping issues
    try {
      const result = execSync(`curl -s --max-time 30 -x ${PROXY} 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql' -X POST -H 'Content-Type: application/json' -d '{"query":"{accountStats(limit:500,orderBy:realizedPnl_DESC){id wins losses realizedPnl maxCapital closedCount}}"}'`, { encoding: 'utf8', maxBuffer: 100*1024*1024 })
      const data = JSON.parse(result)
      const traders = data.data?.accountStats?.map(a => ({
        id: a.id,
        roi: parseFloat(a.maxCapital) > 0 ? parseFloat(a.realizedPnl) / parseFloat(a.maxCapital) * 100 : null,
        pnl: parseFloat(a.realizedPnl) / 1e30,
        wr: a.closedCount > 0 ? a.wins / a.closedCount * 100 : null
      })).filter(t => t.roi && t.roi < 10000) || []
      return saveBatch('gmx', traders)
    } catch { return 0 }
  },

  async okx() {
    const raw = curl('https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP', { timeout: 30 })
    if (!raw) return 0
    const data = JSON.parse(raw)
    const ranks = data.data?.[0]?.ranks || []
    const traders = ranks.map(a => ({
      id: a.uniqueName || a.nickName,
      roi: parseFloat(a.pnlRatio) * 100,
      pnl: parseFloat(a.pnl),
      wr: a.winRatio ? parseFloat(a.winRatio) * 100 : null
    })).filter(t => t.id && t.roi)
    return saveBatch('okx_futures', traders)
  },

  async aevo() {
    const raw = curl('https://api.aevo.xyz/leaderboard?limit=200', { timeout: 30 })
    if (!raw) return 0
    const data = JSON.parse(raw)
    const traders = (data.leaderboard?.monthly || data.leaderboard?.daily || []).map(a => ({
      id: a.username,
      pnl: a.pnl,
      roi: a.pnl // Aevo doesn't provide ROI directly, use PnL as proxy
    })).filter(t => t.id && t.pnl)
    return saveBatch('aevo', traders)
  },

  async jupiter() {
    // Jupiter perps uses different endpoint
    const raw = curl('https://perps-api.jup.ag/v1/traders?limit=200', { timeout: 30 })
    if (!raw) return 0
    try {
      const data = JSON.parse(raw)
      const traders = (data.traders || data || []).map(a => ({
        id: a.wallet || a.address,
        roi: a.pnlPercent || a.roi,
        pnl: a.totalPnl || a.pnl
      })).filter(t => t.id && t.roi)
      return saveBatch('jupiter_perps', traders)
    } catch { return 0 }
  },

  async bitget() {
    // Try multiple endpoints
    const endpoints = [
      'https://api.bitget.com/api/v2/copy/mix-trader/current-track-symbol?pageSize=100&pageNo=1',
      'https://api.bitget.com/api/mix/v1/trace/public/currentTrack?productType=umcbl&pageSize=100&pageNo=1'
    ]
    for (const url of endpoints) {
      const raw = curl(url, { timeout: 30 })
      if (raw) {
        try {
          const data = JSON.parse(raw)
          const list = data.data?.list || data.data || []
          const traders = list.map(a => ({
            id: a.visitorId || a.tradeId || a.uniqueName,
            roi: a.totalProfitRate ? parseFloat(a.totalProfitRate) * 100 : null,
            pnl: a.totalProfit ? parseFloat(a.totalProfit) : null,
            wr: a.winRate ? parseFloat(a.winRate) * 100 : null
          })).filter(t => t.id && t.roi)
          if (traders.length > 0) return saveBatch('bitget_futures', traders)
        } catch {}
      }
    }
    return 0
  },

  async htx() {
    const endpoints = [
      'https://www.htx.com/-/x/hbg/v1/copy/public/user/rank?size=100&statisticsType=30',
      'https://api.htx.com/v1/copy/public/user/rank?size=100'
    ]
    for (const url of endpoints) {
      const raw = curl(url, { timeout: 30, proxy: PROXY })
      if (raw) {
        try {
          const data = JSON.parse(raw)
          const list = data.data?.list || data.data || []
          const traders = list.map(a => ({
            id: a.uid,
            roi: parseFloat(a.roi) * 100,
            pnl: parseFloat(a.totalProfit),
            wr: parseFloat(a.winRate) * 100,
            dd: parseFloat(a.maxDrawDown) * 100
          })).filter(t => t.id && t.roi)
          if (traders.length > 0) return saveBatch('htx_futures', traders)
        } catch {}
      }
    }
    return 0
  }
}

async function main() {
  console.log('🚀 Smart Refresh 开始\n')
  const results = {}
  
  for (const [name, fn] of Object.entries(platforms)) {
    process.stdout.write(`${name}... `)
    try {
      const count = await fn()
      results[name] = count
      console.log(count > 0 ? `✅ ${count}` : '❌ 0')
    } catch (e) {
      results[name] = 0
      console.log(`❌ ${e.message.slice(0, 40)}`)
    }
  }

  // Summary
  console.log('\n📊 刷新结果:')
  const total = Object.values(results).reduce((a, b) => a + b, 0)
  Object.entries(results).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
    console.log(`  ${k}: ${v}`)
  })
  console.log(`\n总计新增/更新: ${total}`)

  // Get current stats
  const { data } = await sb.from('trader_snapshots').select('source, arena_score').eq('season_id', '30D')
  const counts = {}
  data.forEach(r => counts[r.source] = (counts[r.source] || 0) + 1)
  
  console.log('\n📈 当前数据库:')
  Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([s, n]) => console.log(`  ${s}: ${n}`))
  console.log(`\n总计: ${data.length} | 有Score: ${data.filter(r => r.arena_score).length}`)
}

main().catch(console.error)
