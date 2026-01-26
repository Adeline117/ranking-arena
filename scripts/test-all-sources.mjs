#!/usr/bin/env node
/**
 * 测试所有数据源抓取脚本并验证排行榜数据
 *
 * 功能：
 * 1. 检查每个平台在数据库中的数据状态
 * 2. 测试各个抓取脚本是否能正常运行
 * 3. 验证数据是否正确进入排行榜
 *
 * 用法：
 *   node scripts/test-all-sources.mjs          # 只检查数据库状态
 *   node scripts/test-all-sources.mjs --scrape # 运行抓取脚本
 *   node scripts/test-all-sources.mjs --platform=hyperliquid  # 只测试指定平台
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ 缺少环境变量: SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// 所有支持的平台及其对应的抓取脚本
const PLATFORMS = {
  // CEX 交易所
  binance_futures: { script: 'import_binance_futures.mjs', category: 'CEX', name: 'Binance Futures' },
  binance_spot: { script: 'import_binance_spot.mjs', category: 'CEX', name: 'Binance Spot' },
  binance_web3: { script: 'import_binance_web3.mjs', category: 'CEX', name: 'Binance Web3' },
  bybit: { script: 'import_bybit.mjs', category: 'CEX', name: 'Bybit' },
  bitget_futures: { script: 'import_bitget_futures_v2.mjs', category: 'CEX', name: 'Bitget Futures' },
  bitget_spot: { script: 'import_bitget_spot_v2.mjs', category: 'CEX', name: 'Bitget Spot' },
  mexc: { script: 'import_mexc.mjs', category: 'CEX', name: 'MEXC' },
  coinex: { script: 'import_coinex.mjs', category: 'CEX', name: 'CoinEx' },
  okx_futures: { script: 'import_okx_futures.mjs', category: 'CEX', name: 'OKX Futures' },
  okx_web3: { script: 'import_okx_web3.mjs', category: 'CEX', name: 'OKX Web3' },
  kucoin: { script: 'import_kucoin.mjs', category: 'CEX', name: 'KuCoin' },
  htx_futures: { script: 'import_htx.mjs', category: 'CEX', name: 'HTX Futures' },
  weex: { script: 'import_weex.mjs', category: 'CEX', name: 'Weex' },

  // DeFi / 链上
  gmx: { script: 'import_gmx.mjs', category: 'DeFi', name: 'GMX' },
  hyperliquid: { script: 'import_hyperliquid.mjs', category: 'DeFi', name: 'Hyperliquid' },
  dydx: { script: 'import_dydx.mjs', category: 'DeFi', name: 'dYdX' },

  // Dune Analytics
  dune_gmx: { script: 'import_dune.mjs', category: 'Dune', name: 'Dune GMX', args: ['gmx'] },
  dune_hyperliquid: { script: 'import_dune.mjs', category: 'Dune', name: 'Dune Hyperliquid', args: ['hyperliquid'] },
  dune_uniswap: { script: 'import_dune.mjs', category: 'Dune', name: 'Dune Uniswap', args: ['uniswap'] },
}

const WINDOWS = ['7D', '30D', '90D']

// 解析命令行参数
const args = process.argv.slice(2)
const shouldScrape = args.includes('--scrape')
const platformArg = args.find(a => a.startsWith('--platform='))
const targetPlatform = platformArg ? platformArg.split('=')[1] : null

/**
 * 检查平台在数据库中的数据状态
 */
async function checkPlatformData(platform) {
  const results = {
    platform,
    sources: 0,
    snapshots: {},
    latestCapture: null,
    topTrader: null,
  }

  // 检查 trader_sources 表
  const { count: sourcesCount } = await supabase
    .from('trader_sources')
    .select('*', { count: 'exact', head: true })
    .eq('source', platform)

  results.sources = sourcesCount || 0

  // 检查每个时间窗口的 trader_snapshots
  for (const window of WINDOWS) {
    const { data: snapshots, count } = await supabase
      .from('trader_snapshots')
      .select('source_trader_id, roi, arena_score, captured_at', { count: 'exact' })
      .eq('source', platform)
      .eq('season_id', window)
      .order('arena_score', { ascending: false })
      .limit(1)

    results.snapshots[window] = {
      count: count || 0,
      topTrader: snapshots?.[0] || null,
    }

    if (snapshots?.[0]?.captured_at) {
      const captureTime = new Date(snapshots[0].captured_at)
      if (!results.latestCapture || captureTime > results.latestCapture) {
        results.latestCapture = captureTime
        results.topTrader = snapshots[0]
      }
    }
  }

  return results
}

/**
 * 运行抓取脚本
 */
async function runScript(scriptPath, args = []) {
  return new Promise((resolve, reject) => {
    const fullPath = path.join(__dirname, 'import', scriptPath)
    console.log(`    运行: node ${scriptPath} ${args.join(' ')}`)

    const proc = spawn('node', [fullPath, ...args], {
      cwd: path.join(__dirname, '..'),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', data => {
      stdout += data.toString()
      // 实时输出关键信息
      const lines = data.toString().split('\n')
      lines.forEach(line => {
        if (line.includes('✓') || line.includes('✅') || line.includes('获取到') || line.includes('保存')) {
          console.log(`      ${line.trim()}`)
        }
      })
    })

    proc.stderr.on('data', data => {
      stderr += data.toString()
    })

    proc.on('close', code => {
      if (code === 0) {
        resolve({ success: true, stdout, stderr })
      } else {
        resolve({ success: false, stdout, stderr, code })
      }
    })

    proc.on('error', err => {
      resolve({ success: false, error: err.message })
    })

    // 超时 5 分钟
    setTimeout(() => {
      proc.kill()
      resolve({ success: false, error: 'Timeout (5 min)' })
    }, 5 * 60 * 1000)
  })
}

/**
 * 格式化时间差
 */
function formatTimeDiff(date) {
  if (!date) return 'N/A'
  const diffMs = Date.now() - new Date(date).getTime()
  const hours = Math.floor(diffMs / (1000 * 60 * 60))
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60))

  if (hours > 24) {
    return `${Math.floor(hours / 24)}天前`
  } else if (hours > 0) {
    return `${hours}小时前`
  } else {
    return `${minutes}分钟前`
  }
}

/**
 * 打印平台状态
 */
function printStatus(platform, config, data) {
  const status = data.sources > 0 ? '✅' : '❌'
  const freshness = data.latestCapture ? formatTimeDiff(data.latestCapture) : 'N/A'

  console.log(`\n${status} ${config.name} (${platform})`)
  console.log(`   分类: ${config.category}`)
  console.log(`   交易员源: ${data.sources}`)
  console.log(`   最后更新: ${freshness}`)

  console.log('   快照数据:')
  for (const window of WINDOWS) {
    const snap = data.snapshots[window]
    const count = snap?.count || 0
    const topRoi = snap?.topTrader?.roi?.toFixed(2) || 'N/A'
    const topScore = snap?.topTrader?.arena_score?.toFixed(2) || 'N/A'
    const icon = count > 0 ? '✓' : '✗'
    console.log(`     ${icon} ${window}: ${count} 条 (Top ROI: ${topRoi}%, Score: ${topScore})`)
  }
}

/**
 * 主函数
 */
async function main() {
  console.log('=' .repeat(60))
  console.log('数据源状态检查')
  console.log('=' .repeat(60))
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`模式: ${shouldScrape ? '抓取+检查' : '仅检查'}`)
  if (targetPlatform) {
    console.log(`目标平台: ${targetPlatform}`)
  }
  console.log('')

  const platformsToCheck = targetPlatform
    ? { [targetPlatform]: PLATFORMS[targetPlatform] }
    : PLATFORMS

  if (targetPlatform && !PLATFORMS[targetPlatform]) {
    console.error(`❌ 未知平台: ${targetPlatform}`)
    console.log(`可用平台: ${Object.keys(PLATFORMS).join(', ')}`)
    process.exit(1)
  }

  const summary = {
    total: 0,
    active: 0,
    stale: 0,
    empty: 0,
    scrapeSuccess: 0,
    scrapeFailed: 0,
  }

  // 按分类分组
  const byCategory = {}
  for (const [platform, config] of Object.entries(platformsToCheck)) {
    if (!byCategory[config.category]) {
      byCategory[config.category] = []
    }
    byCategory[config.category].push({ platform, config })
  }

  for (const [category, platforms] of Object.entries(byCategory)) {
    console.log(`\n${'─'.repeat(60)}`)
    console.log(`📁 ${category}`)
    console.log(`${'─'.repeat(60)}`)

    for (const { platform, config } of platforms) {
      summary.total++

      // 检查当前状态
      const beforeData = await checkPlatformData(platform)
      printStatus(platform, config, beforeData)

      // 判断状态
      const hasData = beforeData.sources > 0
      const isFresh = beforeData.latestCapture &&
        (Date.now() - new Date(beforeData.latestCapture).getTime()) < 6 * 60 * 60 * 1000 // 6 小时内

      if (!hasData) {
        summary.empty++
      } else if (isFresh) {
        summary.active++
      } else {
        summary.stale++
      }

      // 如果需要抓取
      if (shouldScrape && config.script) {
        console.log(`\n   🔄 运行抓取脚本...`)
        const result = await runScript(config.script, config.args || ['30D'])

        if (result.success) {
          console.log(`   ✅ 抓取成功`)
          summary.scrapeSuccess++

          // 重新检查数据
          const afterData = await checkPlatformData(platform)
          const newSnapshots = Object.values(afterData.snapshots).reduce((a, b) => a + (b.count || 0), 0) -
                              Object.values(beforeData.snapshots).reduce((a, b) => a + (b.count || 0), 0)
          if (newSnapshots > 0) {
            console.log(`   📊 新增 ${newSnapshots} 条快照`)
          }
        } else {
          console.log(`   ❌ 抓取失败: ${result.error || `退出码 ${result.code}`}`)
          summary.scrapeFailed++
          if (result.stderr) {
            console.log(`   错误: ${result.stderr.slice(0, 200)}`)
          }
        }
      }
    }
  }

  // 打印总结
  console.log(`\n${'='.repeat(60)}`)
  console.log('📊 总结')
  console.log(`${'='.repeat(60)}`)
  console.log(`总平台数: ${summary.total}`)
  console.log(`  ✅ 活跃 (6h内更新): ${summary.active}`)
  console.log(`  ⚠️  过期 (>6h未更新): ${summary.stale}`)
  console.log(`  ❌ 空数据: ${summary.empty}`)

  if (shouldScrape) {
    console.log(`\n抓取结果:`)
    console.log(`  ✅ 成功: ${summary.scrapeSuccess}`)
    console.log(`  ❌ 失败: ${summary.scrapeFailed}`)
  }

  // 检查 Rankings API 是否能正确返回数据
  console.log(`\n${'─'.repeat(60)}`)
  console.log('🔍 排行榜 API 验证')
  console.log(`${'─'.repeat(60)}`)

  for (const window of WINDOWS) {
    const { data, count } = await supabase
      .from('trader_snapshots')
      .select('source, arena_score', { count: 'exact' })
      .eq('season_id', window)
      .not('arena_score', 'is', null)
      .order('arena_score', { ascending: false })
      .limit(10)

    const platforms = [...new Set(data?.map(d => d.source) || [])]
    console.log(`  ${window}: ${count || 0} 条, 来自 ${platforms.length} 个平台`)
    if (data && data.length > 0) {
      console.log(`     Top 3 平台: ${platforms.slice(0, 3).join(', ')}`)
      console.log(`     最高 Arena Score: ${data[0]?.arena_score?.toFixed(2) || 'N/A'}`)
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log('✅ 检查完成')
  console.log(`${'='.repeat(60)}`)
}

main().catch(err => {
  console.error('❌ 错误:', err.message)
  process.exit(1)
})
