/**
 * 性能瓶颈深度剖析
 * 实测数据 + 完整分析
 */

import { performance } from 'perf_hooks'
import { createSupabaseAdmin } from '@/lib/cron/utils'
import { getInlineFetcher } from '@/lib/cron/fetchers'
import { runEnrichment } from '@/lib/cron/enrichment-runner'

// 测试1：完整fetch+enrich周期时间分解
async function testFullCycle() {
  console.log('\n=== 测试1: 完整Fetch+Enrich周期时间分解 ===\n')
  
  const platform = 'gmx' // 选一个中等规模平台测试
  const supabase = createSupabaseAdmin()
  if (!supabase) throw new Error('Supabase not configured')
  
  const fetcher = getInlineFetcher(platform)
  if (!fetcher) throw new Error(`No fetcher for ${platform}`)
  
  // Step 1: Fetch阶段
  console.log(`测试平台: ${platform}`)
  const fetchStart = performance.now()
  const fetchResult = await fetcher(supabase, ['90D'])
  const fetchTime = performance.now() - fetchStart
  
  const fetchedCount = fetchResult.periods['90D']?.saved || 0
  console.log(`\n✅ Fetch阶段: ${Math.round(fetchTime)}ms`)
  console.log(`   获取交易员数量: ${fetchedCount}`)
  console.log(`   平均每个trader: ${Math.round(fetchTime / Math.max(fetchedCount, 1))}ms`)
  
  // Step 2: Enrichment阶段（测试前10个）
  if (fetchedCount > 0) {
    console.log(`\n开始Enrichment测试 (前10个trader)...`)
    const enrichStart = performance.now()
    const enrichResult = await runEnrichment({
      platform,
      period: '90D',
      limit: 10,
    })
    const enrichTime = performance.now() - enrichStart
    
    console.log(`\n✅ Enrichment阶段: ${Math.round(enrichTime)}ms`)
    console.log(`   成功enriched: ${enrichResult.summary.enriched}`)
    console.log(`   失败: ${enrichResult.summary.failed}`)
    console.log(`   平均每个trader: ${Math.round(enrichTime / Math.max(enrichResult.summary.total, 1))}ms`)
  }
  
  const totalTime = performance.now() - fetchStart
  console.log(`\n⏱️  总耗时: ${Math.round(totalTime)}ms`)
  console.log(`   Fetch占比: ${((fetchTime / totalTime) * 100).toFixed(1)}%`)
  
  return {
    platform,
    fetchTime: Math.round(fetchTime),
    fetchedCount,
    avgFetchPerTrader: Math.round(fetchTime / Math.max(fetchedCount, 1)),
  }
}

// 测试2：平台API响应时间对比
async function testPlatformAPISpeed() {
  console.log('\n\n=== 测试2: 平台API响应时间对比 ===\n')
  
  const platforms = [
    { name: 'binance_futures', url: 'https://www.binance.com/bapi/futures/v1/public/future/leaderboard/getLeaderboardRank', method: 'POST' },
    { name: 'bybit', url: 'https://api2.bybit.com/fapi/beehive/public/v1/common/leader-data/detail', method: 'GET' },
    { name: 'okx_futures', url: 'https://www.okx.com/priapi/v1/ecotrade/public/leads-trading/trading-data-public-leads', method: 'GET' },
    { name: 'hyperliquid', url: 'https://api.hyperliquid.xyz/info', method: 'POST' },
    { name: 'gmx', url: 'https://subgraph.satsuma-prod.com/3b2ced13c8d9/gmx/synthetics-arbitrum-stats/api', method: 'POST' },
    { name: 'dydx', url: 'https://indexer.dydx.trade/v4/historicalPnl/dydx1z9s2qvjxf6yfnhpr28fwvmtktr58hucu07kxgw', method: 'GET' },
    { name: 'jupiter', url: 'https://jup.ag/api/leaderboard', method: 'GET' },
  ]
  
  const results = []
  
  for (const platform of platforms) {
    const start = performance.now()
    let status = 'success'
    let httpStatus = 0
    
    try {
      const opts: RequestInit = {
        method: platform.method,
        headers: { 'User-Agent': 'RankingArena/Test', 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10000),
      }
      
      if (platform.method === 'POST') {
        opts.body = JSON.stringify({})
      }
      
      const response = await fetch(platform.url, opts)
      httpStatus = response.status
      status = response.ok ? 'success' : `HTTP ${response.status}`
    } catch (err: any) {
      status = err.name === 'TimeoutError' ? 'timeout' : 'error'
    }
    
    const duration = performance.now() - start
    results.push({
      platform: platform.name,
      duration: Math.round(duration),
      status,
      httpStatus,
    })
    
    const statusSymbol = status === 'success' ? '✅' : (status === 'timeout' ? '⏱️' : '❌')
    console.log(`${statusSymbol} ${platform.name.padEnd(20)} ${Math.round(duration).toString().padStart(6)}ms  ${status}`)
    
    await new Promise(r => setTimeout(r, 300))
  }
  
  // 分析
  const successful = results.filter(r => r.status === 'success')
  const avgSuccess = successful.reduce((sum, r) => sum + r.duration, 0) / successful.length
  const slowPlatforms = results.filter(r => r.duration > 1000)
  
  console.log(`\n📊 统计:`)
  console.log(`   成功响应: ${successful.length}/${results.length}`)
  console.log(`   平均响应时间: ${Math.round(avgSuccess)}ms`)
  console.log(`   慢平台 (>1s): ${slowPlatforms.map(p => p.platform).join(', ') || '无'}`)
  
  return results
}

// 测试3：数据库操作性能
async function testDatabasePerformance() {
  console.log('\n\n=== 测试3: 数据库操作性能 ===\n')
  
  const supabase = createSupabaseAdmin()
  if (!supabase) throw new Error('Supabase not configured')
  
  // 3.1 查询性能
  console.log('3.1 查询性能测试:')
  
  const start1 = performance.now()
  const { data: q1 } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, roi, pnl')
    .eq('source', 'binance_futures')
    .eq('season_id', '90D')
    .order('arena_score', { ascending: false })
    .limit(100)
  const query1Time = performance.now() - start1
  console.log(`   查询100条记录 (带索引): ${Math.round(query1Time)}ms`)
  
  const start2 = performance.now()
  const { data: q2 } = await supabase
    .from('trader_snapshots')
    .select('*')
    .eq('source', 'binance_futures')
    .eq('season_id', '90D')
    .limit(100)
  const query2Time = performance.now() - start2
  console.log(`   查询100条完整记录: ${Math.round(query2Time)}ms`)
  
  // 3.2 Upsert性能（模拟）
  console.log('\n3.2 Batch Upsert性能:')
  const mockData = Array(50).fill(null).map((_, i) => ({
    source: 'test_perf',
    source_trader_id: `perf_test_${Date.now()}_${i}`,
    season_id: '90D',
    roi: Math.random() * 100,
    pnl: Math.random() * 10000,
    arena_score: Math.random() * 100,
  }))
  
  const start3 = performance.now()
  const { error } = await supabase
    .from('trader_snapshots')
    .upsert(mockData, { onConflict: 'source,source_trader_id,season_id' })
  const upsertTime = performance.now() - start3
  
  if (error) {
    console.log(`   ❌ Upsert 50条失败: ${error.message}`)
  } else {
    console.log(`   ✅ Upsert 50条记录: ${Math.round(upsertTime)}ms (${Math.round(upsertTime/50)}ms/条)`)
    
    // 清理测试数据
    await supabase.from('trader_snapshots').delete().eq('source', 'test_perf')
  }
  
  return {
    query100: Math.round(query1Time),
    queryFull: Math.round(query2Time),
    upsert50: Math.round(upsertTime),
  }
}

// 测试4：并发策略对比
async function testConcurrencyStrategy() {
  console.log('\n\n=== 测试4: 并发策略对比 ===\n')
  
  const mockAPICall = async (id: number, delayMs: number) => {
    await new Promise(r => setTimeout(r, delayMs))
    return { id, result: 'ok' }
  }
  
  const tasks = Array(30).fill(null).map((_, i) => ({ id: i, delay: 100 + Math.random() * 200 }))
  
  // 并发度对比
  const concurrencies = [1, 3, 5, 7, 10]
  const results = []
  
  for (const concurrency of concurrencies) {
    const start = performance.now()
    
    for (let i = 0; i < tasks.length; i += concurrency) {
      const batch = tasks.slice(i, i + concurrency)
      await Promise.all(batch.map(t => mockAPICall(t.id, t.delay)))
    }
    
    const duration = performance.now() - start
    const speedup: number = concurrencies[0] === 1 ? 1 : results[0].duration / duration
    
    results.push({ concurrency, duration: Math.round(duration), speedup: speedup.toFixed(2) })
    console.log(`   并发度=${concurrency.toString().padStart(2)}: ${Math.round(duration).toString().padStart(6)}ms  (${speedup.toFixed(2)}x加速)`)
  }
  
  // Promise.all vs Promise.allSettled
  console.log('\n对比容错策略:')
  const testTasks = Array(10).fill(null).map((_, i) => ({
    id: i,
    delay: 50 + Math.random() * 100,
    shouldFail: i === 5, // 第6个任务失败
  }))
  
  const mockWithFailure = async (task: any) => {
    await new Promise(r => setTimeout(r, task.delay))
    if (task.shouldFail) throw new Error('Mock failure')
    return { id: task.id }
  }
  
  // Promise.all - 一个失败全失败
  const start1 = performance.now()
  try {
    await Promise.all(testTasks.map(mockWithFailure))
  } catch (err) {
    // Expected
  }
  const allTime = performance.now() - start1
  console.log(`   Promise.all (遇错退出): ${Math.round(allTime)}ms ❌`)
  
  // Promise.allSettled - 继续执行
  const start2 = performance.now()
  const settled = await Promise.allSettled(testTasks.map(mockWithFailure))
  const allSettledTime = performance.now() - start2
  const succeeded = settled.filter(r => r.status === 'fulfilled').length
  console.log(`   Promise.allSettled (容错): ${Math.round(allSettledTime)}ms ✅ (${succeeded}/${testTasks.length}成功)`)
  
  return results
}

// 测试5：内存/计算压力
async function testMemoryAndComputation() {
  console.log('\n\n=== 测试5: 内存/计算压力分析 ===\n')
  
  // 5.1 Equity curve计算
  console.log('5.1 Equity Curve计算压力:')
  const mockCurve = Array(90).fill(null).map((_, i) => ({
    date: new Date(Date.now() - (90 - i) * 86400000).toISOString().split('T')[0],
    roi: Math.random() * 100 - 50,
    pnl: Math.random() * 10000 - 5000,
  }))
  
  const start1 = performance.now()
  // 模拟指标计算
  const maxDrawdown = mockCurve.reduce((max, point, i) => {
    const peak = mockCurve.slice(0, i + 1).reduce((p, pt) => Math.max(p, pt.roi), -Infinity)
    const drawdown = (peak - point.roi) / Math.max(peak, 0.01) * 100
    return Math.max(max, drawdown)
  }, 0)
  const calcTime = performance.now() - start1
  
  console.log(`   计算90天equity curve指标: ${Math.round(calcTime)}ms`)
  console.log(`   数据大小: ${JSON.stringify(mockCurve).length} bytes`)
  
  // 5.2 批量处理内存占用
  console.log('\n5.2 批量数据处理:')
  const batchSize = 100
  const mockBatch = Array(batchSize).fill(null).map((_, i) => ({
    traderId: `trader_${i}`,
    curve: mockCurve,
    stats: { roi: Math.random() * 100, pnl: Math.random() * 10000, trades: Math.floor(Math.random() * 1000) },
  }))
  
  const memUsed = process.memoryUsage()
  console.log(`   当前内存使用:`)
  console.log(`     RSS: ${Math.round(memUsed.rss / 1024 / 1024)}MB`)
  console.log(`     Heap Used: ${Math.round(memUsed.heapUsed / 1024 / 1024)}MB`)
  console.log(`     Heap Total: ${Math.round(memUsed.heapTotal / 1024 / 1024)}MB`)
  
  const batchSizeBytes = JSON.stringify(mockBatch).length
  console.log(`   100个trader数据大小: ${Math.round(batchSizeBytes / 1024)}KB`)
  
  return {
    equityCurveCalcMs: Math.round(calcTime),
    batchSizeKB: Math.round(batchSizeBytes / 1024),
    memoryMB: Math.round(memUsed.heapUsed / 1024 / 1024),
  }
}

// 主函数
async function main() {
  console.log('🔍 Ranking Arena 性能瓶颈深度剖析')
  console.log('='.repeat(60))
  console.log(`执行时间: ${new Date().toISOString()}`)
  
  try {
    // 测试1-5
    const fullCycleResult = await testFullCycle()
    const apiResults = await testPlatformAPISpeed()
    const dbResults = await testDatabasePerformance()
    const concResults = await testConcurrencyStrategy()
    const memResults = await testMemoryAndComputation()
    
    // 生成报告
    console.log('\n\n')
    console.log('='.repeat(60))
    console.log('📊 性能瓶颈分析报告')
    console.log('='.repeat(60))
    
    console.log('\n## 1. 完整周期时间分解')
    console.log(`平台: ${fullCycleResult.platform}`)
    console.log(`Fetch阶段: ${fullCycleResult.fetchTime}ms (${fullCycleResult.fetchedCount}个trader)`)
    console.log(`平均每个trader: ${fullCycleResult.avgFetchPerTrader}ms`)
    
    console.log('\n## 2. 平台API性能对比')
    const fastAPIs = apiResults.filter(r => r.status === 'success' && r.duration < 500)
    const slowAPIs = apiResults.filter(r => r.duration > 1000)
    console.log(`快速平台 (<500ms): ${fastAPIs.map(r => r.platform).join(', ')}`)
    console.log(`慢速平台 (>1s): ${slowAPIs.map(r => r.platform).join(', ')}`)
    
    console.log('\n## 3. 数据库性能')
    console.log(`查询100条: ${dbResults.query100}ms`)
    console.log(`Upsert 50条: ${dbResults.upsert50}ms (${Math.round(dbResults.upsert50/50)}ms/条)`)
    
    console.log('\n## 4. 并发优化建议')
    console.log(`当前并发度7的性能: ${concResults.find(r => r.concurrency === 7)?.speedup}x加速`)
    console.log(`推荐并发度: 7-10 (平衡速度和稳定性)`)
    console.log(`容错策略: 必须使用 Promise.allSettled`)
    
    console.log('\n## 5. 内存/计算压力')
    console.log(`Equity curve计算: ${memResults.equityCurveCalcMs}ms/trader`)
    console.log(`批量数据大小: ${memResults.batchSizeKB}KB/100个trader`)
    console.log(`当前内存占用: ${memResults.memoryMB}MB`)
    
    console.log('\n## Quick Wins (立即优化)')
    console.log('1. ✅ 提高GMX并发度到15 (已优化)')
    console.log('2. 🔧 慢平台(hyperliquid/gmx/dydx)禁用inline enrichment，用专门job')
    console.log('3. 🔧 Batch upsert改为批次更小(20条/次)减少锁竞争')
    console.log('4. 🔧 API调用添加per-trader timeout (15s)')
    console.log('5. 🔧 Redis缓存API响应减少重复调用')
    
    console.log('\n分析完成 ✅')
    
  } catch (err) {
    console.error('\n❌ 测试失败:', err)
    throw err
  }
}

main()
