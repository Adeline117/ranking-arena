/**
 * 通过 Cloudflare Worker 代理抓取数据
 *
 * 支持平台: Binance Futures, Binance Spot, KuCoin
 *
 * 用法:
 *   node scripts/import/import_via_proxy.mjs [platform] [period]
 *   node scripts/import/import_via_proxy.mjs binance_futures ALL
 *   node scripts/import/import_via_proxy.mjs binance_spot 30D
 *   node scripts/import/import_via_proxy.mjs kucoin ALL
 *   node scripts/import/import_via_proxy.mjs all ALL
 *
 * 环境变量:
 *   CLOUDFLARE_PROXY_URL - Cloudflare Worker 代理 URL (必须)
 *   CLOUDFLARE_PROXY_SECRET - 代理密钥 (可选)
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const PROXY_URL = process.env.CLOUDFLARE_PROXY_URL
const PROXY_SECRET = process.env.CLOUDFLARE_PROXY_SECRET

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

if (!PROXY_URL) {
  console.error('Error: CLOUDFLARE_PROXY_URL must be set')
  console.error('Deploy the Cloudflare Worker first:')
  console.error('  cd cloudflare-worker && npm install && npm run deploy')
  console.error('Then set CLOUDFLARE_PROXY_URL in .env')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Arena Score 计算
const ARENA_CONFIG = {
  PARAMS: {
    '7D': { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
    '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
    '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
  },
  MAX_RETURN_SCORE: 70,
  MAX_PNL_SCORE: 15,
  MAX_DRAWDOWN_SCORE: 8,
  MAX_STABILITY_SCORE: 7,
  PNL_PARAMS: {
    '7D': { base: 500, coeff: 0.40 },
    '30D': { base: 2000, coeff: 0.35 },
    '90D': { base: 5000, coeff: 0.30 },
  },
}

const clip = (v, min, max) => Math.max(min, Math.min(max, v))
const safeLog1p = x => x <= -1 ? 0 : Math.log(1 + x)
const getPeriodDays = p => p === '7D' ? 7 : p === '30D' ? 30 : 90

function calculateArenaScore(roi, pnl, maxDrawdown, winRate, period) {
  const params = ARENA_CONFIG.PARAMS[period] || ARENA_CONFIG.PARAMS['90D']
  const days = getPeriodDays(period)
  const wr = winRate !== null && winRate !== undefined ? (winRate <= 1 ? winRate * 100 : winRate) : null
  const intensity = (365 / days) * safeLog1p((roi || 0) / 100)
  const r0 = Math.tanh(params.tanhCoeff * intensity)
  const returnScore = r0 > 0 ? clip(ARENA_CONFIG.MAX_RETURN_SCORE * Math.pow(r0, params.roiExponent), 0, ARENA_CONFIG.MAX_RETURN_SCORE) : 0
  // PnL score (0-15)
  const pnlParams = ARENA_CONFIG.PNL_PARAMS[period] || ARENA_CONFIG.PNL_PARAMS['90D']
  let pnlScore = 0
  if (pnl !== null && pnl !== undefined && pnl > 0) {
    const logArg = 1 + pnl / pnlParams.base
    if (logArg > 0) {
      pnlScore = clip(ARENA_CONFIG.MAX_PNL_SCORE * Math.tanh(pnlParams.coeff * Math.log(logArg)), 0, ARENA_CONFIG.MAX_PNL_SCORE)
    }
  }
  const drawdownScore = maxDrawdown !== null ? clip(ARENA_CONFIG.MAX_DRAWDOWN_SCORE * clip(1 - Math.abs(maxDrawdown) / params.mddThreshold, 0, 1), 0, 8) : 4
  const stabilityScore = wr !== null ? clip(ARENA_CONFIG.MAX_STABILITY_SCORE * clip((wr - 45) / (params.winRateCap - 45), 0, 1), 0, 7) : 3.5
  return Math.round((returnScore + pnlScore + drawdownScore + stabilityScore) * 100) / 100
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 平台配置
const PLATFORMS = {
  binance_futures: {
    name: 'Binance Futures',
    endpoint: '/binance/copy-trading',
    source: 'binance_futures',
    parseResponse: (data) => {
      if (data.code !== '000000' || !data.data?.list) return []
      return data.data.list.map(item => ({
        traderId: String(item.leadPortfolioId || item.portfolioId || item.encryptedUid || ''),
        nickname: item.nickName || item.nickname || null,
        avatar: item.userPhoto || null,
        roi: parseFloat(item.roi ?? 0),
        pnl: parseFloat(item.pnl ?? 0),
        winRate: parseFloat(item.winRate ?? 0),
        maxDrawdown: parseFloat(item.mdd ?? 0),
        followers: parseInt(item.copierCount ?? 0),
      }))
    },
    buildParams: (period, page) => `?period=${period}&page=${page}`,
  },
  binance_spot: {
    name: 'Binance Spot',
    endpoint: '/binance/spot-copy-trading',
    source: 'binance_spot',
    parseResponse: (data) => {
      if (data.code !== '000000' || !data.data?.list) return []
      return data.data.list.map(item => ({
        traderId: String(item.leadPortfolioId || item.portfolioId || item.encryptedUid || ''),
        nickname: item.nickName || item.nickname || null,
        avatar: item.userPhoto || null,
        roi: parseFloat(item.roi ?? 0),
        pnl: parseFloat(item.pnl ?? 0),
        winRate: parseFloat(item.winRate ?? 0),
        maxDrawdown: parseFloat(item.mdd ?? 0),
        followers: parseInt(item.copierCount ?? 0),
      }))
    },
    buildParams: (period, page) => `?period=${period}&page=${page}`,
  },
  kucoin: {
    name: 'KuCoin',
    endpoint: '/kucoin/copy-trading',
    source: 'kucoin',
    parseResponse: (data) => {
      if (!data.data?.items) return []
      return data.data.items.map(item => ({
        traderId: String(item.leaderUid || item.uid || ''),
        nickname: item.nickName || item.nickname || null,
        avatar: item.avatar || null,
        roi: parseFloat(item.roi ?? item.totalRoi ?? 0) * 100, // KuCoin ROI 是小数
        pnl: parseFloat(item.totalPnl ?? item.pnl ?? 0),
        winRate: parseFloat(item.winRate ?? 0) * 100,
        maxDrawdown: parseFloat(item.maxDrawdown ?? 0) * 100,
        followers: parseInt(item.copierCount ?? item.followerCount ?? 0),
        daysAsLead: parseInt(item.daysAsLead ?? 0),
      }))
    },
    buildParams: (period, page) => `?page=${page}&pageSize=20`,
    filterByPeriod: (traders, period) => {
      const minDays = period === '7D' ? 7 : period === '30D' ? 30 : 90
      return traders.filter(t => (t.daysAsLead || 0) >= minDays)
    },
  },
}

async function fetchViaProxy(endpoint, params = '') {
  const url = `${PROXY_URL}${endpoint}${params}`
  const headers = { 'Accept': 'application/json' }
  if (PROXY_SECRET) {
    headers['X-Proxy-Secret'] = PROXY_SECRET
  }

  const response = await fetch(url, { headers })
  if (!response.ok) {
    throw new Error(`Proxy returned ${response.status}`)
  }
  return response.json()
}

async function fetchPlatformData(platform, period, targetCount = 100) {
  const config = PLATFORMS[platform]
  if (!config) throw new Error(`Unknown platform: ${platform}`)

  console.log(`\n📋 获取 ${config.name} ${period} 数据...`)

  const traders = new Map()
  let page = 1
  const maxPages = 10

  while (traders.size < targetCount && page <= maxPages) {
    try {
      const params = config.buildParams(period, page)
      const data = await fetchViaProxy(config.endpoint, params)
      let items = config.parseResponse(data)

      if (items.length === 0) {
        console.log(`  第 ${page} 页无数据`)
        break
      }

      // 按周期过滤（如果需要）
      if (config.filterByPeriod) {
        items = config.filterByPeriod(items, period)
      }

      for (const item of items) {
        if (item.traderId && !traders.has(item.traderId)) {
          traders.set(item.traderId, item)
        }
      }

      console.log(`  第 ${page} 页: +${items.length} 条, 累计 ${traders.size}`)
      page++
      await sleep(500)
    } catch (e) {
      console.log(`  ⚠ 第 ${page} 页失败: ${e.message}`)
      break
    }
  }

  console.log(`  ✓ 共获取 ${traders.size} 个交易员`)
  return Array.from(traders.values())
}

async function saveTraders(traders, source, period) {
  if (traders.length === 0) return 0

  console.log(`\n💾 保存 ${traders.length} 条 ${source} ${period} 数据...`)

  // 排序
  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  const top100 = traders.slice(0, 100)
  const capturedAt = new Date().toISOString()

  // Upsert trader_sources
  const sourcesData = top100.map(t => ({
    source,
    source_type: 'leaderboard',
    source_trader_id: t.traderId,
    handle: t.nickname,
    avatar_url: t.avatar || null,
    is_active: true,
  }))

  await supabase.from('trader_sources').upsert(sourcesData, { onConflict: 'source,source_trader_id' })

  // Insert trader_snapshots
  const snapshotsData = top100.map((t, idx) => {
    const wr = t.winRate !== null ? (t.winRate <= 1 ? t.winRate * 100 : t.winRate) : null
    return {
      source,
      source_trader_id: t.traderId,
      season_id: period,
      rank: idx + 1,
      roi: t.roi || 0,
      pnl: t.pnl || 0,
      win_rate: wr,
      max_drawdown: t.maxDrawdown || null,
      followers: t.followers || 0,
      arena_score: calculateArenaScore(t.roi, t.pnl, t.maxDrawdown, wr, period),
      captured_at: capturedAt,
    }
  })

  const { error } = await supabase.from('trader_snapshots').upsert(snapshotsData, { onConflict: 'source,source_trader_id,season_id' })

  if (error) {
    console.log(`  ⚠ 批量插入失败: ${error.message}`)
    // 逐条重试
    let saved = 0
    for (const s of snapshotsData) {
      const { error: e } = await supabase.from('trader_snapshots').upsert(s, { onConflict: 'source,source_trader_id,season_id' })
      if (!e) saved++
    }
    return saved
  }

  console.log(`  ✓ 保存成功: ${snapshotsData.length} 条`)
  return snapshotsData.length
}

async function main() {
  const platformArg = process.argv[2]?.toLowerCase() || 'all'
  const periodArg = process.argv[3]?.toUpperCase() || 'ALL'

  const platforms = platformArg === 'all' ? Object.keys(PLATFORMS) : [platformArg]
  const periods = periodArg === 'ALL' ? ['7D', '30D', '90D'] : [periodArg]

  console.log('\n' + '='.repeat(60))
  console.log('通过 Cloudflare Worker 代理抓取数据')
  console.log('='.repeat(60))
  console.log('代理 URL:', PROXY_URL)
  console.log('平台:', platforms.join(', '))
  console.log('周期:', periods.join(', '))
  console.log('='.repeat(60))

  // 检查代理连接
  console.log('\n🔍 检查代理连接...')
  try {
    const health = await fetchViaProxy('/health')
    console.log('  ✓ 代理正常:', health.status)
  } catch (e) {
    console.error('  ✗ 代理连接失败:', e.message)
    console.error('  请确保已部署 Cloudflare Worker 并设置正确的 URL')
    process.exit(1)
  }

  const results = []
  const startTime = Date.now()

  for (const platform of platforms) {
    if (!PLATFORMS[platform]) {
      console.log(`\n⚠ 未知平台: ${platform}，跳过`)
      continue
    }

    for (const period of periods) {
      console.log(`\n${'='.repeat(50)}`)
      console.log(`📊 ${PLATFORMS[platform].name} - ${period}`)
      console.log('='.repeat(50))

      try {
        const traders = await fetchPlatformData(platform, period)

        if (traders.length > 0) {
          // 显示 TOP 5
          traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
          console.log(`\n📋 TOP 5:`)
          traders.slice(0, 5).forEach((t, i) => {
            console.log(`  ${i + 1}. ${t.nickname || t.traderId.slice(0, 10)}: ROI ${t.roi?.toFixed(2)}%`)
          })

          const saved = await saveTraders(traders, PLATFORMS[platform].source, period)
          results.push({ platform, period, count: traders.length, saved, topRoi: traders[0]?.roi || 0 })
        } else {
          console.log(`\n⚠ 无数据`)
          results.push({ platform, period, count: 0, saved: 0, topRoi: 0 })
        }
      } catch (e) {
        console.log(`\n✗ 错误: ${e.message}`)
        results.push({ platform, period, count: 0, saved: 0, error: e.message })
      }

      await sleep(1000)
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)

  console.log('\n' + '='.repeat(60))
  console.log('✅ 全部完成！')
  console.log('='.repeat(60))
  console.log('📊 结果:')
  for (const r of results) {
    const status = r.error ? `✗ ${r.error}` : `${r.saved} 条`
    console.log(`   ${r.platform} ${r.period}: ${status}`)
  }
  console.log(`   总耗时: ${totalTime}s`)
  console.log('='.repeat(60))
}

main().catch(console.error)
