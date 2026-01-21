#!/usr/bin/env node
/**
 * 全交易所爬虫测试脚本
 * 
 * 测试所有交易所的：
 * 1. 排行榜抓取
 * 2. 交易员详情抓取
 * 
 * 用法:
 *   node scripts/test_all_scrapers.mjs                    # 测试所有
 *   node scripts/test_all_scrapers.mjs --leaderboard     # 只测试排行榜
 *   node scripts/test_all_scrapers.mjs --details         # 只测试详情
 *   node scripts/test_all_scrapers.mjs --source=binance  # 只测试特定来源
 *   node scripts/test_all_scrapers.mjs --period=7D       # 指定时间段
 *   node scripts/test_all_scrapers.mjs --limit=10        # 详情抓取限制数量
 *   node scripts/test_all_scrapers.mjs --max=2           # 最大并发数
 */

import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 排行榜脚本配置
const LEADERBOARD_SCRIPTS = {
  binance_futures_api: { script: 'import_binance_futures_api.mjs', name: 'Binance Futures (API)' },
  binance_futures: { script: 'import_binance_futures.mjs', name: 'Binance Futures (Browser)' },
  binance_spot: { script: 'import_binance_spot.mjs', name: 'Binance Spot' },
  binance_web3: { script: 'import_binance_web3.mjs', name: 'Binance Web3' },
  bitget_futures: { script: 'import_bitget_futures_v2.mjs', name: 'Bitget Futures' },
  bitget_spot: { script: 'import_bitget_spot_v2.mjs', name: 'Bitget Spot' },
  bybit: { script: 'import_bybit.mjs', name: 'Bybit' },
  okx_web3: { script: 'import_okx_web3.mjs', name: 'OKX Web3' },
  kucoin: { script: 'import_kucoin.mjs', name: 'KuCoin' },
  mexc: { script: 'import_mexc.mjs', name: 'MEXC' },
}

// 详情脚本配置
const DETAIL_SCRIPTS = {
  binance_futures: { script: 'fetch_all_binance_details.mjs', name: 'Binance Futures 详情' },
  binance_web3: { script: 'fetch_binance_web3_trader_details.mjs', name: 'Binance Web3 详情' },
  bitget: { script: 'fetch_bitget_trader_details.mjs', name: 'Bitget 详情' },
  bybit: { script: 'fetch_bybit_trader_details.mjs', name: 'Bybit 详情' },
  okx_web3: { script: 'fetch_okx_trader_details.mjs', name: 'OKX Web3 详情' },
  kucoin: { script: 'fetch_kucoin_trader_details.mjs', name: 'KuCoin 详情' },
  mexc: { script: 'fetch_mexc_trader_details.mjs', name: 'MEXC 详情' },
}

// 解析命令行参数
function parseArgs() {
  const args = process.argv.slice(2)
  const options = {
    leaderboard: true,
    details: true,
    source: null,
    period: '90D',
    limit: 10,
    maxConcurrent: 2,
  }
  
  for (const arg of args) {
    if (arg === '--leaderboard') {
      options.leaderboard = true
      options.details = false
    } else if (arg === '--details') {
      options.leaderboard = false
      options.details = true
    } else if (arg.startsWith('--source=')) {
      options.source = arg.split('=')[1].toLowerCase()
    } else if (arg.startsWith('--period=')) {
      options.period = arg.split('=')[1].toUpperCase()
    } else if (arg.startsWith('--limit=')) {
      options.limit = parseInt(arg.split('=')[1]) || 10
    } else if (arg.startsWith('--max=')) {
      options.maxConcurrent = parseInt(arg.split('=')[1]) || 2
    }
  }
  
  // 如果没有指定特定类型，则两个都运行
  if (!args.includes('--leaderboard') && !args.includes('--details')) {
    options.leaderboard = true
    options.details = true
  }
  
  return options
}

// 运行脚本
function runScript(script, args = []) {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, script)
    const startTime = Date.now()
    
    const proc = spawn('node', [scriptPath, ...args], {
      cwd: path.dirname(__dirname),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    
    let output = ''
    let errorOutput = ''
    
    proc.stdout.on('data', (data) => {
      const str = data.toString()
      output += str
      // 实时打印关键信息
      if (str.includes('✓') || str.includes('✗') || str.includes('完成') || 
          str.includes('TOP') || str.includes('保存')) {
        process.stdout.write('    ' + str.trim().split('\n').slice(0, 3).join('\n    ') + '\n')
      }
    })
    
    proc.stderr.on('data', (data) => {
      errorOutput += data.toString()
    })
    
    proc.on('close', (code) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      
      // 提取保存数量
      const savedMatch = output.match(/保存[：:]\s*(\d+)/) || output.match(/成功[：:]\s*(\d+)/)
      const saved = savedMatch ? savedMatch[1] : '?'
      
      resolve({
        script,
        success: code === 0,
        elapsed,
        saved,
        error: errorOutput.slice(0, 200),
      })
    })
    
    proc.on('error', (err) => {
      resolve({
        script,
        success: false,
        elapsed: '0',
        saved: '0',
        error: err.message,
      })
    })
  })
}

// 批量运行（控制并发）
async function runBatch(tasks, maxConcurrent) {
  const results = []
  const running = new Set()
  const queue = [...tasks]
  
  while (queue.length > 0 || running.size > 0) {
    while (running.size < maxConcurrent && queue.length > 0) {
      const task = queue.shift()
      const promise = task.run()
        .then(result => {
          running.delete(promise)
          results.push({ ...result, name: task.name })
          return result
        })
      running.add(promise)
    }
    
    if (running.size > 0) {
      await Promise.race(running)
    }
  }
  
  return results
}

async function main() {
  const options = parseArgs()
  const startTime = Date.now()
  
  console.log(`\n╔════════════════════════════════════════════════╗`)
  console.log(`║        全交易所爬虫测试                        ║`)
  console.log(`╚════════════════════════════════════════════════╝`)
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`测试类型: ${options.leaderboard ? '排行榜' : ''}${options.leaderboard && options.details ? ' + ' : ''}${options.details ? '详情' : ''}`)
  console.log(`来源筛选: ${options.source || '全部'}`)
  console.log(`时间段: ${options.period}`)
  console.log(`详情限制: ${options.limit} 个`)
  console.log(`最大并发: ${options.maxConcurrent}`)
  console.log(`────────────────────────────────────────────────`)
  
  const allResults = {
    leaderboard: [],
    details: [],
  }
  
  // ===== 1. 排行榜测试 =====
  if (options.leaderboard) {
    console.log(`\n📋 排行榜抓取测试`)
    console.log(`────────────────────────────────────────────────`)
    
    let scripts = Object.entries(LEADERBOARD_SCRIPTS)
    
    // 筛选来源
    if (options.source) {
      scripts = scripts.filter(([key]) => key.includes(options.source))
    }
    
    // 默认只测试主要来源（避免测试太多）
    const mainSources = ['binance_futures_api', 'bitget_futures', 'bybit', 'okx_web3', 'kucoin', 'mexc']
    if (!options.source) {
      scripts = scripts.filter(([key]) => mainSources.includes(key))
    }
    
    const leaderboardTasks = scripts.map(([key, config]) => ({
      name: config.name,
      run: () => {
        console.log(`\n  🚀 ${config.name}...`)
        return runScript(config.script, [options.period])
      },
    }))
    
    if (leaderboardTasks.length > 0) {
      allResults.leaderboard = await runBatch(leaderboardTasks, options.maxConcurrent)
    }
  }
  
  // ===== 2. 详情测试 =====
  if (options.details) {
    console.log(`\n📊 交易员详情抓取测试`)
    console.log(`────────────────────────────────────────────────`)
    
    let scripts = Object.entries(DETAIL_SCRIPTS)
    
    // 筛选来源
    if (options.source) {
      scripts = scripts.filter(([key]) => key.includes(options.source))
    }
    
    const detailTasks = scripts.map(([key, config]) => ({
      name: config.name,
      run: () => {
        console.log(`\n  🔍 ${config.name}...`)
        return runScript(config.script, [`--limit=${options.limit}`])
      },
    }))
    
    if (detailTasks.length > 0) {
      // 详情抓取较慢，减少并发
      allResults.details = await runBatch(detailTasks, Math.min(options.maxConcurrent, 2))
    }
  }
  
  // ===== 结果汇总 =====
  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  
  console.log(`\n╔════════════════════════════════════════════════╗`)
  console.log(`║        测试结果汇总                            ║`)
  console.log(`╚════════════════════════════════════════════════╝`)
  
  if (allResults.leaderboard.length > 0) {
    console.log(`\n📋 排行榜结果:`)
    console.log(`┌──────────────────────────┬────────┬────────┬────────┐`)
    console.log(`│ 来源                     │ 状态   │ 保存   │ 耗时   │`)
    console.log(`├──────────────────────────┼────────┼────────┼────────┤`)
    
    for (const r of allResults.leaderboard) {
      const status = r.success ? '✅' : '❌'
      const name = (r.name || r.script).substring(0, 22).padEnd(22)
      const saved = String(r.saved).padStart(5)
      const time = `${r.elapsed}s`.padStart(6)
      console.log(`│ ${name} │  ${status}    │${saved} │${time} │`)
    }
    
    console.log(`└──────────────────────────┴────────┴────────┴────────┘`)
    
    const successCount = allResults.leaderboard.filter(r => r.success).length
    const totalSaved = allResults.leaderboard.reduce((sum, r) => sum + (parseInt(r.saved) || 0), 0)
    console.log(`  成功: ${successCount}/${allResults.leaderboard.length}, 总保存: ${totalSaved} 条`)
  }
  
  if (allResults.details.length > 0) {
    console.log(`\n📊 详情结果:`)
    console.log(`┌──────────────────────────┬────────┬────────┬────────┐`)
    console.log(`│ 来源                     │ 状态   │ 成功   │ 耗时   │`)
    console.log(`├──────────────────────────┼────────┼────────┼────────┤`)
    
    for (const r of allResults.details) {
      const status = r.success ? '✅' : '❌'
      const name = (r.name || r.script).substring(0, 22).padEnd(22)
      const saved = String(r.saved).padStart(5)
      const time = `${r.elapsed}s`.padStart(6)
      console.log(`│ ${name} │  ${status}    │${saved} │${time} │`)
    }
    
    console.log(`└──────────────────────────┴────────┴────────┴────────┘`)
    
    const successCount = allResults.details.filter(r => r.success).length
    console.log(`  成功: ${successCount}/${allResults.details.length}`)
  }
  
  // 失败列表
  const failures = [
    ...allResults.leaderboard.filter(r => !r.success),
    ...allResults.details.filter(r => !r.success),
  ]
  
  if (failures.length > 0) {
    console.log(`\n❌ 失败项:`)
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.error?.slice(0, 100) || '未知错误'}`)
    }
  }
  
  console.log(`\n────────────────────────────────────────────────`)
  console.log(`总耗时: ${totalElapsed}s`)
  console.log(`测试完成时间: ${new Date().toISOString()}`)
  console.log(``)
  
  // 返回退出码
  const hasFailures = failures.length > 0
  process.exit(hasFailures ? 1 : 0)
}

main().catch(error => {
  console.error('测试脚本执行失败:', error)
  process.exit(1)
})
