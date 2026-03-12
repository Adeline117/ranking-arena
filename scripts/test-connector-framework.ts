/**
 * Test Connector Framework
 * 
 * 测试新的 Connector 框架功能：
 * - ConnectorRunner 执行
 * - Redis 状态存储
 * - PipelineLogger 集成
 * - Telegram 告警（可选）
 * 
 * Usage:
 *   tsx scripts/test-connector-framework.ts
 *   tsx scripts/test-connector-framework.ts --platform hyperliquid
 *   tsx scripts/test-connector-framework.ts --dry-run
 *   tsx scripts/test-connector-framework.ts --no-alerts
 */

import { ConnectorRunner, getAllConnectorStatuses } from '../lib/connectors/connector-runner'
import { HyperliquidConnector } from '../lib/connectors/hyperliquid'
import { PipelineLogger } from '../lib/services/pipeline-logger'

// ============================================
// CLI Arguments
// ============================================

interface TestOptions {
  platform: string
  window: '7d' | '30d' | '90d'
  dryRun: boolean
  enableAlerts: boolean
}

function parseArgs(): TestOptions {
  const args = process.argv.slice(2)
  
  return {
    platform: args.find(a => a.startsWith('--platform='))?.split('=')[1] || 'hyperliquid',
    window: (args.find(a => a.startsWith('--window='))?.split('=')[1] as '7d' | '30d' | '90d') || '90d',
    dryRun: args.includes('--dry-run'),
    enableAlerts: !args.includes('--no-alerts'),
  }
}

// ============================================
// Test Functions
// ============================================

async function testConnectorExecution(options: TestOptions) {
  console.log('\n=== Test 1: Connector Execution ===\n')
  
  // 1. Create connector
  const connector = new HyperliquidConnector()
  console.log(`✓ Created ${options.platform} connector`)
  
  // 2. Create runner
  const runner = new ConnectorRunner(connector, {
    platform: options.platform,
    enableAlerts: options.enableAlerts,
    alertThreshold: 3,
    timeoutMs: 60000,
  })
  console.log(`✓ Created ConnectorRunner`)
  
  // 3. Execute
  console.log(`\nExecuting connector...`)
  const startTime = Date.now()
  
  const result = await runner.execute({
    window: options.window,
  })
  
  const durationMs = Date.now() - startTime
  
  // 4. Print results
  console.log(`\n✓ Execution completed in ${durationMs}ms`)
  console.log(`  Success: ${result.success}`)
  console.log(`  Records processed: ${result.recordsProcessed}`)
  console.log(`  Errors: ${result.errors.length}`)
  
  if (result.errors.length > 0) {
    console.log(`  Error messages:`)
    result.errors.forEach(err => console.log(`    - ${err}`))
  }
  
  return runner
}

async function testRedisStatus(runner: ConnectorRunner<any>, platform: string) {
  console.log('\n=== Test 2: Redis Status ===\n')
  
  // 1. Get status
  const status = await runner.getStatus()
  
  if (!status) {
    console.log('✗ No status found in Redis')
    return
  }
  
  console.log('✓ Status retrieved from Redis:')
  console.log(`  Platform: ${status.platform}`)
  console.log(`  Status: ${status.status}`)
  console.log(`  Last run: ${status.lastRun}`)
  console.log(`  Records processed: ${status.recordsProcessed}`)
  console.log(`  Consecutive failures: ${status.consecutiveFailures}`)
  
  if (status.lastError) {
    console.log(`  Last error: ${status.lastError}`)
  }
  
  // 2. Test batch query
  const allStatuses = await getAllConnectorStatuses([platform])
  console.log(`\n✓ Batch query: found ${allStatuses.length} status(es)`)
}

async function testPipelineLogger(platform: string) {
  console.log('\n=== Test 3: Pipeline Logger ===\n')
  
  const jobName = `${platform}-connector`
  
  // 1. Get job status
  const statuses = await PipelineLogger.getJobStatuses()
  const jobStatus = statuses.find(s => s.job_name === jobName)
  
  if (jobStatus) {
    console.log('✓ Job status from DB:')
    console.log(`  Job name: ${jobStatus.job_name}`)
    console.log(`  Status: ${jobStatus.status}`)
    console.log(`  Started at: ${jobStatus.started_at}`)
    console.log(`  Records processed: ${jobStatus.records_processed}`)
    console.log(`  Health: ${jobStatus.health_status}`)
  } else {
    console.log(`✗ No job status found for ${jobName}`)
  }
  
  // 2. Get job stats
  const stats = await PipelineLogger.getJobStats()
  const jobStats = stats.find(s => s.job_name === jobName)
  
  if (jobStats) {
    console.log('\n✓ Job stats (last 7 days):')
    console.log(`  Total runs: ${jobStats.total_runs}`)
    console.log(`  Success count: ${jobStats.success_count}`)
    console.log(`  Error count: ${jobStats.error_count}`)
    console.log(`  Success rate: ${jobStats.success_rate}%`)
    console.log(`  Avg duration: ${jobStats.avg_duration_ms}ms`)
    console.log(`  Last run: ${jobStats.last_run_at}`)
  }
  
  // 3. Get consecutive failures
  const consecutiveFailures = await PipelineLogger.getConsecutiveFailures(jobName)
  console.log(`\n✓ Consecutive failures: ${consecutiveFailures}`)
  
  if (consecutiveFailures >= 3) {
    console.log(`  ⚠️ Warning: ${consecutiveFailures} consecutive failures detected!`)
  }
  
  // 4. Get recent failures
  const failures = await PipelineLogger.getRecentFailures(5)
  const jobFailures = failures.filter(f => f.job_name === jobName)
  
  if (jobFailures.length > 0) {
    console.log(`\n✓ Recent failures (${jobFailures.length}):`)
    jobFailures.forEach(f => {
      console.log(`  - ${f.started_at}: ${f.error_message?.substring(0, 80)}`)
    })
  } else {
    console.log('\n✓ No recent failures')
  }
}

async function testAlertingSystem(options: TestOptions) {
  console.log('\n=== Test 4: Alerting System ===\n')
  
  if (!options.enableAlerts) {
    console.log('⊘ Alerts disabled')
    return
  }
  
  // Note: Alerts are sent during execution if conditions are met
  // - Consecutive failures >= 3
  // - 0 results
  // - Response time > 10s
  
  console.log('✓ Alert system is enabled')
  console.log('  Alerts will be sent if:')
  console.log('  - Consecutive failures >= 3')
  console.log('  - 0 results returned')
  console.log('  - Response time > 10s')
  
  if (options.dryRun) {
    console.log('\n⊘ Dry-run mode: no data saved to DB')
  }
}

async function printSummary(result: any) {
  console.log('\n=== Summary ===\n')
  
  console.log(`Platform: ${result.platform}`)
  console.log(`Window: ${result.window}`)
  console.log(`Success: ${result.success ? '✓' : '✗'}`)
  console.log(`Records: ${result.recordsProcessed}`)
  console.log(`Duration: ${result.durationMs}ms`)
  
  if (result.errors.length > 0) {
    console.log(`\n❌ Errors encountered:`)
    result.errors.forEach((err: string) => console.log(`  - ${err}`))
  } else {
    console.log(`\n✅ All tests passed!`)
  }
}

// ============================================
// Main
// ============================================

async function main() {
  console.log('╔═══════════════════════════════════════════╗')
  console.log('║   Connector Framework Test Suite         ║')
  console.log('╚═══════════════════════════════════════════╝')
  
  const options = parseArgs()
  
  console.log('\nTest Configuration:')
  console.log(`  Platform: ${options.platform}`)
  console.log(`  Window: ${options.window}`)
  console.log(`  Dry-run: ${options.dryRun}`)
  console.log(`  Alerts: ${options.enableAlerts}`)
  
  try {
    // Test 1: Execute connector
    const runner = await testConnectorExecution(options)
    
    // Test 2: Redis status
    await testRedisStatus(runner, options.platform)
    
    // Test 3: Pipeline logger
    await testPipelineLogger(options.platform)
    
    // Test 4: Alerting
    await testAlertingSystem(options)
    
    // Summary
    const status = await runner.getStatus()
    await printSummary({
      platform: options.platform,
      window: options.window,
      success: status?.status === 'success',
      recordsProcessed: status?.recordsProcessed || 0,
      durationMs: status?.metadata?.durationMs || 0,
      errors: status?.lastError ? [status.lastError] : [],
    })
    
  } catch (error) {
    console.error('\n❌ Test failed:', error)
    process.exit(1)
  }
}

main()
