/**
 * Ranking Arena Worker Service
 * Standalone data fetching service independent of Vercel
 * 
 * Features:
 * - Parallel platform fetching
 * - Proxy pool management with auto-failover
 * - Configurable scheduling
 * - Graceful shutdown
 * 
 * Usage:
 *   npx tsx worker/src/index.ts                    # Run all enabled platforms
 *   npx tsx worker/src/index.ts --platforms vertex,drift  # Run specific platforms
 *   npx tsx worker/src/index.ts --category dex-api # Run category
 *   npx tsx worker/src/index.ts --daemon           # Run as daemon with scheduling
 */

import { Scheduler } from './scheduler/index.js'
import { ProxyPoolManager } from './proxy-pool/index.js'
import { logger } from './logger.js'
import {
  executeFetcherJob,
  getEnabledPlatforms,
  getPlatformConfig,
  getPlatformsByCategory,
  getDeFiPlatforms,
  PLATFORM_CONFIGS,
} from './runners/fetcher-runner.js'
import type { PlatformConfig } from './types.js'

// ============================================
// Configuration
// ============================================

interface WorkerConfig {
  concurrency: number
  daemon: boolean
  platforms: string[]
  category?: string
  periods: string[]
}

function parseArgs(): WorkerConfig {
  const args = process.argv.slice(2)
  const config: WorkerConfig = {
    concurrency: 4,
    daemon: false,
    platforms: [],
    periods: ['7D', '30D', '90D'],
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--daemon':
      case '-d':
        config.daemon = true
        break
      case '--concurrency':
      case '-c':
        config.concurrency = parseInt(args[++i], 10) || 4
        break
      case '--platforms':
      case '-p':
        config.platforms = args[++i]?.split(',').filter(Boolean) || []
        break
      case '--category':
        config.category = args[++i]
        break
      case '--periods':
        config.periods = args[++i]?.split(',').filter(Boolean) || ['7D', '30D', '90D']
        break
      case '--defi':
        // Shortcut for DeFi protocols
        config.platforms = getDeFiPlatforms().map((p) => p.id)
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
    }
  }

  return config
}

function printHelp(): void {
  logger.info(`
Ranking Arena Worker Service

Usage:
  npx tsx worker/src/index.ts [options]

Options:
  --daemon, -d           Run as daemon with scheduled execution
  --concurrency, -c N    Max parallel jobs (default: 4)
  --platforms, -p LIST   Comma-separated platform IDs
  --category CAT         Run all platforms in category (cex-api, cex-browser, dex-api, dex-subgraph)
  --periods LIST         Comma-separated periods (default: 7D,30D,90D)
  --defi                 Run all DeFi protocols
  --help, -h             Show this help

Examples:
  npx tsx worker/src/index.ts                          # Run all enabled platforms
  npx tsx worker/src/index.ts --platforms vertex,drift # Run specific platforms
  npx tsx worker/src/index.ts --category dex-api       # Run all DEX API platforms
  npx tsx worker/src/index.ts --defi                   # Run DeFi protocols only
  npx tsx worker/src/index.ts --daemon                 # Run as background daemon

Available Platforms:
${PLATFORM_CONFIGS.map((p) => `  - ${p.id.padEnd(20)} (${p.category})`).join('\n')}
`)
}

// ============================================
// Worker Service
// ============================================

async function runWorker(config: WorkerConfig): Promise<void> {
  logger.info('╔═══════════════════════════════════════════════════════════╗')
  logger.info('║         Ranking Arena Worker Service                      ║')
  logger.info('╚═══════════════════════════════════════════════════════════╝')
  logger.info('')

  // Determine which platforms to run
  let platforms: PlatformConfig[] = []

  if (config.platforms.length > 0) {
    // Specific platforms requested
    for (const id of config.platforms) {
      const p = getPlatformConfig(id)
      if (p) {
        platforms.push(p)
      } else {
        logger.warn(`[Worker] Unknown platform: ${id}`)
      }
    }
  } else if (config.category) {
    // Category filter
    platforms = getPlatformsByCategory(config.category as PlatformConfig['category'])
  } else {
    // All enabled platforms
    platforms = getEnabledPlatforms()
  }

  if (platforms.length === 0) {
    logger.error('[Worker] No platforms to run', new Error('No platforms configured'))
    process.exit(1)
  }

  logger.info(`[Worker] Running ${platforms.length} platforms:`)
  platforms.forEach((p) => logger.info(`  - ${p.name} (${p.id})`))
  logger.info('')

  // Initialize proxy pool
  const proxyPool = new ProxyPoolManager({
    clashApiUrl: process.env.CLASH_API_URL || 'http://127.0.0.1:9090',
    clashApiSecret: process.env.CLASH_API_SECRET,
  })

  // Initialize scheduler
  const scheduler = new Scheduler(
    { maxConcurrency: config.concurrency },
    proxyPool
  )

  scheduler.setExecutor(executeFetcherJob)

  // Event listeners
  scheduler.on('job:started', ({ job }) => {
    logger.info(`[▶️] Started: ${job.platform}`)
  })

  scheduler.on('job:completed', ({ job, result }) => {
    type PeriodResult = { saved: number; error?: string }
    const periods = result.periods as Record<string, PeriodResult>
    const totalSaved = Object.values(periods).reduce((a, p) => a + p.saved, 0)
    const errors = Object.entries(periods)
      .filter(([_, p]) => p.error)
      .map(([period, p]) => `${period}: ${p.error}`)

    if (errors.length > 0) {
      logger.info(`[⚠️] Completed with errors: ${job.platform} (${totalSaved} records)`)
      errors.forEach((e) => logger.info(`     └─ ${e}`))
    } else {
      logger.info(`[✅] Completed: ${job.platform} (${totalSaved} records, ${result.duration}ms)`)
    }
  })

  scheduler.on('job:failed', ({ job, error }) => {
    logger.info(`[❌] Failed: ${job.platform} - ${error}`)
  })

  scheduler.on('job:retry', ({ job, attempt }) => {
    logger.info(`[🔄] Retrying: ${job.platform} (attempt ${attempt}/${job.maxRetries})`)
  })

  // Handle graceful shutdown
  const shutdown = async () => {
    logger.info('\n[Worker] Shutting down...')
    await scheduler.stop()
    logger.info('[Worker] Goodbye!')
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Start scheduler
  await scheduler.start()

  // Enqueue jobs
  for (const platform of platforms) {
    scheduler.enqueue({
      platform: platform.id,
      periods: config.periods,
      priority: 'normal',
      maxRetries: platform.maxRetries,
    })
  }

  logger.info(`[Worker] Enqueued ${platforms.length} jobs`)
  logger.info('')

  if (config.daemon) {
    // Daemon mode: keep running and re-schedule
    logger.info('[Worker] Running in daemon mode. Press Ctrl+C to stop.')
    
    // Keep process alive (cron scheduling handled externally)
    await new Promise(() => {})
  } else {
    // One-shot mode: wait for all jobs to complete
    const checkComplete = setInterval(() => {
      const state = scheduler.getState()
      if (state.pendingJobs === 0 && state.activeJobs === 0) {
        clearInterval(checkComplete)
        printSummary(scheduler)
        scheduler.stop().then(() => process.exit(0))
      }
    }, 1000)
  }
}

function printSummary(scheduler: Scheduler): void {
  const state = scheduler.getState()
  logger.info('')
  logger.info('╔═══════════════════════════════════════════════════════════╗')
  logger.info('║                     Execution Summary                      ║')
  logger.info('╠═══════════════════════════════════════════════════════════╣')
  logger.info(`║  ✅ Completed:  ${String(state.completedJobs).padStart(4)}                                    ║`)
  logger.info(`║  ❌ Failed:     ${String(state.failedJobs).padStart(4)}                                    ║`)
  logger.info('╚═══════════════════════════════════════════════════════════╝')
}

// ============================================
// Main
// ============================================

const config = parseArgs()
runWorker(config).catch((err) => {
  logger.error('[Worker] Fatal error', err instanceof Error ? err : new Error(String(err)))
  process.exit(1)
})
