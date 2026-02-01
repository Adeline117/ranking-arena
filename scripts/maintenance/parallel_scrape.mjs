#!/usr/bin/env node
/**
 * 并行爬虫运行脚本 (完整版)
 * 
 * 同时运行多个来源/时间段的爬虫，大幅提升效率
 * 
 * 用法:
 *   node scripts/parallel_scrape.mjs                    # 运行主要来源的 90D
 *   node scripts/parallel_scrape.mjs --fast            # 🚀 快速模式（只用API版本+优化版）
 *   node scripts/parallel_scrape.mjs --full            # 运行所有来源
 *   node scripts/parallel_scrape.mjs --period=7D       # 运行所有来源的 7D
 *   node scripts/parallel_scrape.mjs --source=binance  # 只运行 binance 相关
 *   node scripts/parallel_scrape.mjs --all             # 运行所有来源的所有时间段
 *   node scripts/parallel_scrape.mjs --fast --all      # 🚀 快速模式运行所有时间段
 */

import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 主要来源（默认运行）
const MAIN_SCRAPERS = {
  // API 版本（超快）
  binance_futures_api: 'import_binance_futures_api.mjs',
  // 优化过的浏览器版本
  binance_spot: 'import_binance_spot.mjs',
  bitget_futures: 'import_bitget_futures_v2.mjs',
  bitget_spot: 'import_bitget_spot_v2.mjs',
  bybit: 'import_bybit.mjs',
}

// 所有可用的来源
const ALL_SCRAPERS = {
  // API 版本（超快）
  binance_futures_api: 'import_binance_futures_api.mjs',
  // Binance
  binance_futures: 'import_binance_futures_api.mjs',
  binance_spot: 'import_binance_spot.mjs',
  binance_web3: 'import_binance_web3.mjs',
  // Bitget
  bitget_futures: 'import_bitget_futures_v2.mjs',
  bitget_spot: 'import_bitget_spot_v2.mjs',
  // 其他交易所
  bybit: 'import_bybit.mjs',
  okx_web3: 'import_okx_web3.mjs',
  kucoin: 'import_kucoin.mjs',
  mexc: 'import_mexc.mjs',
}

// 快速模式（只用最快的）
const FAST_SCRAPERS = {
  binance_futures: 'import_binance_futures_api.mjs',
  bitget_futures: 'import_bitget_futures_v2.mjs',
}

const PERIODS = ['7D', '30D', '90D']

// 解析命令行参数
function parseArgs() {
  const args = process.argv.slice(2)
  const options = {
    period: '90D',
    source: null,
    all: false,
    fast: false,
    full: false,  // 运行所有来源
    maxConcurrent: 3,
  }
  
  for (const arg of args) {
    if (arg.startsWith('--period=')) {
      options.period = arg.split('=')[1].toUpperCase()
    } else if (arg.startsWith('--source=')) {
      options.source = arg.split('=')[1].toLowerCase()
    } else if (arg === '--all') {
      options.all = true
    } else if (arg === '--fast') {
      options.fast = true
      options.maxConcurrent = 5
    } else if (arg === '--full') {
      options.full = true
    } else if (arg.startsWith('--max=')) {
      options.maxConcurrent = parseInt(arg.split('=')[1]) || 3
    }
  }
  
  return options
}

// 运行单个爬虫脚本
function runScraper(script, period) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, script)
    const startTime = Date.now()
    
    console.log(`🚀 启动: ${script} ${period}`)
    
    const proc = spawn('node', [scriptPath, period], {
      cwd: path.dirname(__dirname),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    
    let output = ''
    let errorOutput = ''
    
    proc.stdout.on('data', (data) => {
      output += data.toString()
    })
    
    proc.stderr.on('data', (data) => {
      errorOutput += data.toString()
    })
    
    proc.on('close', (code) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      
      if (code === 0) {
        // 提取保存的数量
        const savedMatch = output.match(/保存[：:]\s*(\d+)/)
        const saved = savedMatch ? savedMatch[1] : '?'
        console.log(`✅ 完成: ${script} ${period} | 保存: ${saved} | 耗时: ${elapsed}s`)
        resolve({ script, period, success: true, elapsed, saved })
      } else {
        console.log(`❌ 失败: ${script} ${period} | 耗时: ${elapsed}s`)
        if (errorOutput) {
          console.log(`   错误: ${errorOutput.slice(0, 200)}`)
        }
        resolve({ script, period, success: false, elapsed, error: errorOutput })
      }
    })
    
    proc.on('error', (err) => {
      console.log(`❌ 启动失败: ${script} ${period} | ${err.message}`)
      resolve({ script, period, success: false, error: err.message })
    })
  })
}

// 批量运行，控制并发
async function runBatch(tasks, maxConcurrent) {
  const results = []
  const running = new Set()
  const queue = [...tasks]
  
  while (queue.length > 0 || running.size > 0) {
    // 填充到最大并发数
    while (running.size < maxConcurrent && queue.length > 0) {
      const task = queue.shift()
      const promise = runScraper(task.script, task.period)
        .then(result => {
          running.delete(promise)
          results.push(result)
          return result
        })
      running.add(promise)
    }
    
    // 等待任一完成
    if (running.size > 0) {
      await Promise.race(running)
    }
  }
  
  return results
}

async function main() {
  const options = parseArgs()
  const startTime = Date.now()
  
  // 选择爬虫集合
  let scraperSet
  if (options.fast) {
    scraperSet = FAST_SCRAPERS
  } else if (options.full) {
    scraperSet = ALL_SCRAPERS
  } else {
    scraperSet = MAIN_SCRAPERS
  }
  
  let scrapers = Object.entries(scraperSet)
  
  // 筛选来源
  if (options.source) {
    scrapers = scrapers.filter(([key]) => key.includes(options.source))
  }
  
  // 筛选时间段
  const periods = options.all ? PERIODS : [options.period]
  
  // 构建任务列表
  const tasks = []
  for (const [name, script] of scrapers) {
    for (const period of periods) {
      tasks.push({ name, script, period })
    }
  }
  
  const modeLabel = options.fast ? ' (🚀 快速模式)' : options.full ? ' (完整模式)' : ''
  
  console.log(`\n========================================`)
  console.log(`🔄 并行爬虫运行器${modeLabel}`)
  console.log(`========================================`)
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`模式: ${options.fast ? 'API 版本（超快）' : options.full ? '所有来源' : '主要来源'}`)
  console.log(`最大并发: ${options.maxConcurrent}`)
  console.log(`任务数: ${tasks.length}`)
  console.log(`来源: ${scrapers.map(([k]) => k).join(', ')}`)
  console.log(`时间段: ${periods.join(', ')}`)
  console.log(`----------------------------------------\n`)
  
  if (tasks.length === 0) {
    console.log('⚠ 没有匹配的任务')
    return
  }
  
  // 运行所有任务
  const results = await runBatch(tasks, options.maxConcurrent)
  
  // 统计结果
  const successful = results.filter(r => r.success)
  const failed = results.filter(r => !r.success)
  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  const totalSaved = successful.reduce((sum, r) => sum + (parseInt(r.saved) || 0), 0)
  
  console.log(`\n========================================`)
  console.log(`📊 运行结果`)
  console.log(`========================================`)
  console.log(`总任务: ${results.length}`)
  console.log(`成功: ${successful.length}`)
  console.log(`失败: ${failed.length}`)
  console.log(`总保存: ${totalSaved} 条`)
  console.log(`总耗时: ${totalElapsed}s`)
  
  if (failed.length > 0) {
    console.log(`\n失败的任务:`)
    for (const f of failed) {
      console.log(`  - ${f.script} ${f.period}`)
    }
  }
  
  // 显示各来源结果
  console.log(`\n各来源详情:`)
  const bySource = new Map()
  for (const r of results) {
    const source = r.script.replace('import_', '').replace('.mjs', '')
    if (!bySource.has(source)) {
      bySource.set(source, [])
    }
    bySource.get(source).push(r)
  }
  
  for (const [source, sourceResults] of bySource) {
    const successCount = sourceResults.filter(r => r.success).length
    const totalCount = sourceResults.length
    const saved = sourceResults.reduce((sum, r) => sum + (parseInt(r.saved) || 0), 0)
    const status = successCount === totalCount ? '✅' : successCount > 0 ? '⚠️' : '❌'
    console.log(`  ${status} ${source}: ${successCount}/${totalCount} 成功, ${saved} 条`)
  }
  
  console.log(`========================================\n`)
}

main().catch(console.error)
