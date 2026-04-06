/**
 * Cron 任务共享工具
 * 提供认证、日志、脚本执行等共享功能
 * 集成熔断器、重试机制、遥测和告警通知
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { exec } from 'child_process'
import { promisify } from 'util'
import {
  getCircuitBreaker,
  withRetry,
  RetryPresets,
  isTransientError,
  getAllCircuitBreakerStats,
} from '@/lib/utils/circuit-breaker'
import { createLogger } from '@/lib/utils/logger'
import { recordScrapeMetrics } from '@/lib/scraper/telemetry'
import { getPlatformConfig } from '@/lib/scraper/config'

const execAsync = promisify(exec)
const cronLogger = createLogger('Cron')

// 脚本执行超时时间（毫秒）
export const SCRIPT_TIMEOUT = 180000 // 3分钟

// 获取平台熔断器
function getPlatformCircuitBreaker(platform: string) {
  return getCircuitBreaker(`cron-${platform}`, {
    failureThreshold: 3, // 3 次失败后熔断
    successThreshold: 1, // 1 次成功后恢复
    timeout: 300000, // 5 分钟后尝试恢复
    onStateChange: async (from, to, name) => {
      cronLogger.info(`熔断器 ${name} 状态变化: ${from} -> ${to}`)
      
      // 记录熔断器状态变化
      if (to === 'OPEN') {
        cronLogger.error(`熔断器已打开: ${name} - 平台 ${platform} 连续失败次数过多`)
      }
      if (from === 'OPEN' && to === 'HALF_OPEN') {
        cronLogger.info(`熔断器尝试恢复: ${name} - 平台 ${platform}`)
      }
      if (from === 'HALF_OPEN' && to === 'CLOSED') {
        cronLogger.info(`熔断器已恢复: ${name} - 平台 ${platform}`)
      }
    },
  })
}

// 平台脚本配置
export const PLATFORM_SCRIPTS: Record<string, Array<{ name: string; script: string; args: string[] }>> = {
  binance_futures: [
    { name: 'binance_futures_7d', script: 'scripts/import/import_binance_futures_api.mjs', args: ['7D'] },
    { name: 'binance_futures_30d', script: 'scripts/import/import_binance_futures_api.mjs', args: ['30D'] },
    { name: 'binance_futures_90d', script: 'scripts/import/import_binance_futures_api.mjs', args: ['90D'] },
  ],
  // binance_spot: PERMANENTLY REMOVED (2026-03-14) - repeatedly hangs 45-76min, blocks entire pipeline
  binance_web3: [
    { name: 'binance_web3_7d', script: 'scripts/import/import_binance_web3.mjs', args: ['7D'] },
    { name: 'binance_web3_30d', script: 'scripts/import/import_binance_web3.mjs', args: ['30D'] },
    { name: 'binance_web3_90d', script: 'scripts/import/import_binance_web3.mjs', args: ['90D'] },
  ],
  bybit: [
    { name: 'bybit_7d', script: 'scripts/import/import_bybit.mjs', args: ['7D'] },
    { name: 'bybit_30d', script: 'scripts/import/import_bybit.mjs', args: ['30D'] },
    { name: 'bybit_90d', script: 'scripts/import/import_bybit.mjs', args: ['90D'] },
  ],
  bybit_spot: [
    { name: 'bybit_spot_7d', script: 'scripts/import/import_bybit_spot.mjs', args: ['7D'] },
    { name: 'bybit_spot_30d', script: 'scripts/import/import_bybit_spot.mjs', args: ['30D'] },
    { name: 'bybit_spot_90d', script: 'scripts/import/import_bybit_spot.mjs', args: ['90D'] },
  ],
  // bitget_futures: DISABLED 2026-03-18 EMERGENCY (7th stuck >44min)
  // bitget_futures: [
  //   { name: 'bitget_futures_7d', script: 'scripts/import/import_bitget_futures_v2.mjs', args: ['7D'] },
  //   { name: 'bitget_futures_30d', script: 'scripts/import/import_bitget_futures_v2.mjs', args: ['30D'] },
  //   { name: 'bitget_futures_90d', script: 'scripts/import/import_bitget_futures_v2.mjs', args: ['90D'] },
  // ],
  bitget_spot: [
    { name: 'bitget_spot_7d', script: 'scripts/import/import_bitget_spot_v2.mjs', args: ['7D'] },
    { name: 'bitget_spot_30d', script: 'scripts/import/import_bitget_spot_v2.mjs', args: ['30D'] },
    { name: 'bitget_spot_90d', script: 'scripts/import/import_bitget_spot_v2.mjs', args: ['90D'] },
  ],
  mexc: [
    { name: 'mexc_7d', script: 'scripts/import/import_mexc.mjs', args: ['7D'] },
    { name: 'mexc_30d', script: 'scripts/import/import_mexc.mjs', args: ['30D'] },
    { name: 'mexc_90d', script: 'scripts/import/import_mexc.mjs', args: ['90D'] },
  ],
  coinex: [
    { name: 'coinex_7d', script: 'scripts/import/import_coinex.mjs', args: ['7D'] },
    { name: 'coinex_30d', script: 'scripts/import/import_coinex.mjs', args: ['30D'] },
    { name: 'coinex_90d', script: 'scripts/import/import_coinex.mjs', args: ['90D'] },
  ],
  okx_web3: [
    { name: 'okx_web3_7d', script: 'scripts/import/import_okx_web3.mjs', args: ['7D'] },
    { name: 'okx_web3_30d', script: 'scripts/import/import_okx_web3.mjs', args: ['30D'] },
    { name: 'okx_web3_90d', script: 'scripts/import/import_okx_web3.mjs', args: ['90D'] },
  ],
  kucoin: [
    { name: 'kucoin_7d', script: 'scripts/import/import_kucoin.mjs', args: ['7D'] },
    { name: 'kucoin_30d', script: 'scripts/import/import_kucoin.mjs', args: ['30D'] },
    { name: 'kucoin_90d', script: 'scripts/import/import_kucoin.mjs', args: ['90D'] },
  ],
  gmx: [
    { name: 'gmx_7d', script: 'scripts/import/import_gmx.mjs', args: ['7D'] },
    { name: 'gmx_30d', script: 'scripts/import/import_gmx.mjs', args: ['30D'] },
    // GMX 没有 90D 数据
  ],
  htx: [
    { name: 'htx_futures_7d', script: 'scripts/import/import_htx.mjs', args: ['7D'] },
    { name: 'htx_futures_30d', script: 'scripts/import/import_htx.mjs', args: ['30D'] },
    { name: 'htx_futures_90d', script: 'scripts/import/import_htx.mjs', args: ['90D'] },
  ],
  okx_futures: [
    { name: 'okx_futures_7d', script: 'scripts/import/import_okx_futures.mjs', args: ['7D'] },
    { name: 'okx_futures_30d', script: 'scripts/import/import_okx_futures.mjs', args: ['30D'] },
    { name: 'okx_futures_90d', script: 'scripts/import/import_okx_futures.mjs', args: ['90D'] },
  ],
  weex: [
    { name: 'weex_7d', script: 'scripts/import/import_weex.mjs', args: ['7D'] },
    { name: 'weex_30d', script: 'scripts/import/import_weex.mjs', args: ['30D'] },
    { name: 'weex_90d', script: 'scripts/import/import_weex.mjs', args: ['90D'] },
  ],
  bingx: [
    { name: 'bingx_7d', script: 'scripts/import/import_bingx.mjs', args: ['7D'] },
    { name: 'bingx_30d', script: 'scripts/import/import_bingx.mjs', args: ['30D'] },
    { name: 'bingx_90d', script: 'scripts/import/import_bingx.mjs', args: ['90D'] },
  ],
  gateio: [
    { name: 'gateio_7d', script: 'scripts/import/import_gateio.mjs', args: ['7D'] },
    { name: 'gateio_30d', script: 'scripts/import/import_gateio.mjs', args: ['30D'] },
    { name: 'gateio_90d', script: 'scripts/import/import_gateio.mjs', args: ['90D'] },
  ],
  phemex: [
    { name: 'phemex_7d', script: 'scripts/import/import_phemex.mjs', args: ['7D'] },
    { name: 'phemex_30d', script: 'scripts/import/import_phemex.mjs', args: ['30D'] },
    { name: 'phemex_90d', script: 'scripts/import/import_phemex.mjs', args: ['90D'] },
  ],
  xt: [
    { name: 'xt_7d', script: 'scripts/import/import_xt.mjs', args: ['7D'] },
    { name: 'xt_30d', script: 'scripts/import/import_xt.mjs', args: ['30D'] },
    { name: 'xt_90d', script: 'scripts/import/import_xt.mjs', args: ['90D'] },
  ],
  pionex: [
    { name: 'pionex_7d', script: 'scripts/import/import_pionex_v2.mjs', args: ['7D'] },
    { name: 'pionex_30d', script: 'scripts/import/import_pionex_v2.mjs', args: ['30D'] },
    { name: 'pionex_90d', script: 'scripts/import/import_pionex_v2.mjs', args: ['90D'] },
  ],
  kwenta: [
    { name: 'kwenta_7d', script: 'scripts/import/import_kwenta.mjs', args: ['7D'] },
    { name: 'kwenta_30d', script: 'scripts/import/import_kwenta.mjs', args: ['30D'] },
    { name: 'kwenta_90d', script: 'scripts/import/import_kwenta.mjs', args: ['90D'] },
  ],
  gains: [
    { name: 'gains_7d', script: 'scripts/import/import_gains.mjs', args: ['7D'] },
    { name: 'gains_30d', script: 'scripts/import/import_gains.mjs', args: ['30D'] },
    { name: 'gains_90d', script: 'scripts/import/import_gains.mjs', args: ['90D'] },
  ],
  mux: [
    { name: 'mux_7d', script: 'scripts/import/import_mux.mjs', args: ['7D'] },
    { name: 'mux_30d', script: 'scripts/import/import_mux.mjs', args: ['30D'] },
    { name: 'mux_90d', script: 'scripts/import/import_mux.mjs', args: ['90D'] },
  ],
  lbank: [
    { name: 'lbank_7d', script: 'scripts/import/import_lbank.mjs', args: ['7D'] },
    { name: 'lbank_30d', script: 'scripts/import/import_lbank.mjs', args: ['30D'] },
    { name: 'lbank_90d', script: 'scripts/import/import_lbank.mjs', args: ['90D'] },
  ],
  blofin: [
    { name: 'blofin_7d', script: 'scripts/import/import_blofin.mjs', args: ['7D'] },
    { name: 'blofin_30d', script: 'scripts/import/import_blofin.mjs', args: ['30D'] },
    { name: 'blofin_90d', script: 'scripts/import/import_blofin.mjs', args: ['90D'] },
  ],
}

export type ScriptResult = {
  name: string
  success: boolean
  output?: string
  error?: string
  duration?: number
}

/**
 * 获取 Supabase 环境变量
 */
export function getSupabaseEnv() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  return { url, serviceKey }
}

/**
 * 验证 Cron 请求授权
 * Vercel Cron 使用 Authorization: Bearer <CRON_SECRET> 格式
 */
export function isAuthorized(req: Request): boolean {
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret) {
    cronLogger.error('CRON_SECRET 环境变量未设置')
    return false
  }

  return authHeader === `Bearer ${cronSecret}`
}

/**
 * 创建 Supabase Admin 客户端
 */
export function createSupabaseAdmin(): SupabaseClient | null {
  try {
    return getSupabaseAdmin()
  } catch (err) {
    console.error('[cron/utils] Failed to create Supabase admin client:', err instanceof Error ? err.message : String(err))
    return null
  }
}

/**
 * 执行单个抓取脚本（内部实现）
 */
async function executeScriptInternal(
  scriptConfig: { name: string; script: string; args: string[] },
  env: Record<string, string>
): Promise<{ stdout: string; stderr: string }> {
  const { script, args } = scriptConfig
  const command = `node ${script}${args.length > 0 ? ` ${args.join(' ')}` : ''}`

  return execAsync(command, {
    cwd: process.cwd(),
    timeout: SCRIPT_TIMEOUT,
    env: {
      ...process.env,
      ...env,
    },
  })
}

/**
 * 执行单个抓取脚本
 * 带有重试、熔断器保护和遥测记录
 */
export async function executeScript(
  scriptConfig: { name: string; script: string; args: string[] },
  env: Record<string, string>
): Promise<ScriptResult> {
  const { name, args } = scriptConfig
  const startTime = Date.now()
  let retryCount = 0

  // 解析平台和时间窗口
  const [platform] = name.split('_').slice(0, -1).length > 0
    ? [name.replace(/_\d+[dD]$/, '')]
    : [name]
  const timeWindow = args[0] || '7D'

  try {
    cronLogger.info(`开始执行 ${name}...`)

    // 使用重试机制执行脚本
    const { stdout, stderr } = await withRetry(
      () => executeScriptInternal(scriptConfig, env),
      {
        ...RetryPresets.fast,
        maxRetries: 2, // 脚本执行最多重试 2 次
        isRetryable: (error) => {
          // 只重试网络相关错误，不重试脚本逻辑错误
          return isTransientError(error)
        },
        onRetry: (attempt, error, delay) => {
          retryCount = attempt
          cronLogger.warn(`${name} 第 ${attempt} 次重试，等待 ${Math.round(delay)}ms`)
        },
      }
    )

    const duration = Date.now() - startTime
    cronLogger.info(`${name} 完成，耗时 ${duration}ms`)

    // 解析输出获取交易员数量（如果有）
    const traderCountMatch = (stdout || '').match(/(?:imported|updated|count)[:\s]*(\d+)/i)
    const traderCount = traderCountMatch ? parseInt(traderCountMatch[1], 10) : 0

    // 记录遥测指标
    const config = getPlatformConfig(platform)
    await recordScrapeMetrics({
      platform,
      timeWindow,
      timestamp: Date.now(),
      duration,
      success: true,
      traderCount,
      method: config?.scrape.method || 'api',
      retryCount,
    })

    return {
      name,
      success: true,
      output: (stdout || stderr).substring(0, 500),
      duration,
    }
  } catch (error: unknown) {
    const duration = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : String(error)
    cronLogger.error(`${name} 失败:`, errorMessage)

    // 分类错误类型
    const errorType = classifyError(error)

    // 记录失败遥测
    const config = getPlatformConfig(platform)
    await recordScrapeMetrics({
      platform,
      timeWindow,
      timestamp: Date.now(),
      duration,
      success: false,
      traderCount: 0,
      errorType,
      errorMessage: errorMessage.substring(0, 200),
      method: config?.scrape.method || 'api',
      retryCount,
    })

    return {
      name,
      success: false,
      error: errorMessage.substring(0, 500),
      duration,
    }
  }
}

/**
 * 分类错误类型
 */
function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()

  if (message.includes('timeout') || message.includes('timed out')) {
    return 'timeout'
  }
  if (message.includes('network') || message.includes('econnrefused') || message.includes('enotfound')) {
    return 'network'
  }
  if (message.includes('rate limit') || message.includes('429') || message.includes('too many')) {
    return 'rate_limit'
  }
  if (message.includes('403') || message.includes('forbidden') || message.includes('blocked')) {
    return 'blocked'
  }
  if (message.includes('401') || message.includes('unauthorized')) {
    return 'auth'
  }
  if (message.includes('parse') || message.includes('json') || message.includes('unexpected token')) {
    return 'parse_error'
  }
  if (message.includes('validation') || message.includes('invalid')) {
    return 'validation'
  }

  return 'unknown'
}

/**
 * 执行平台的所有脚本
 * 使用熔断器保护，防止持续失败
 * 失败时发送告警通知
 */
export async function executePlatformScripts(platform: string): Promise<{
  platform: string
  results: ScriptResult[]
  ran_at: string
  circuitBreakerState: string
}> {
  const scripts = PLATFORM_SCRIPTS[platform]
  if (!scripts) {
    throw new Error(`未知平台: ${platform}`)
  }

  const circuitBreaker = getPlatformCircuitBreaker(platform)
  const { url, serviceKey } = getSupabaseEnv()
  const env = {
    SUPABASE_URL: url,
    SUPABASE_SERVICE_ROLE_KEY: serviceKey,
  }

  const results: ScriptResult[] = []
  const failedScripts: string[] = []

  // 使用熔断器保护整个平台的执行
  try {
    await circuitBreaker.execute(async () => {
      for (const scriptConfig of scripts) {
        const result = await executeScript(scriptConfig, env)
        results.push(result)

        // 记录失败的脚本
        if (!result.success) {
          failedScripts.push(result.name)
          throw new Error(`脚本 ${result.name} 执行失败: ${result.error}`)
        }
      }
    })
  } catch (error) {
    // 熔断器可能抛出错误，记录到结果中
    if (results.length === 0) {
      results.push({
        name: platform,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      })
      failedScripts.push(platform)
    }
    cronLogger.error(`平台 ${platform} 执行被熔断器阻止或失败:`, error)
  }

  // 记录执行结果
  const circuitBreakerState = circuitBreaker.getState()
  if (failedScripts.length > 0) {
    cronLogger.error(`爬虫执行失败: ${platform} - 失败脚本: ${failedScripts.join(', ')} - 熔断器状态: ${circuitBreakerState}`)
  } else if (circuitBreakerState === 'OPEN') {
    cronLogger.warn(`平台熔断器已打开: ${platform} - 请求将被阻止`)
  }

  return {
    platform,
    results,
    ran_at: new Date().toISOString(),
    circuitBreakerState,
  }
}

/**
 * 记录 Cron 执行日志
 */
export async function logCronExecution(
  supabase: SupabaseClient | null,
  name: string,
  results: ScriptResult[]
): Promise<void> {
  if (!supabase) return

  try {
    await supabase.from('cron_logs').insert([
      {
        name,
        ran_at: new Date().toISOString(),
        result: JSON.stringify(results),
      },
    ])
  } catch (error) {
    // 静默处理日志表不存在的情况
    cronLogger.warn('无法记录日志:', error)
  }
}

/**
 * 获取所有支持的平台列表
 */
export function getSupportedPlatforms(): string[] {
  return Object.keys(PLATFORM_SCRIPTS)
}

/**
 * 获取所有 Cron 熔断器状态
 */
export function getCronCircuitBreakerStats() {
  return getAllCircuitBreakerStats()
}

/**
 * 发送爬虫执行摘要告警
 * 用于批量执行后的统计通知
 */
export async function sendScrapeSummaryAlert(
  summary: {
    totalPlatforms: number
    successPlatforms: number
    failedPlatforms: number
    totalScripts: number
    successScripts: number
    failedScripts: number
    duration: number
    failedDetails?: Array<{ platform: string; scripts: string[] }>
  }
): Promise<void> {
  const { 
    totalPlatforms,
    successPlatforms,
    failedPlatforms,
    totalScripts,
    successScripts,
    failedScripts: _failedScripts,
    duration,
    failedDetails,
  } = summary

  if (failedPlatforms > 0) {
    const failedList = failedDetails
      ?.map(d => `${d.platform}: ${d.scripts.join(', ')}`)
      .join('\n') || '未知'

    cronLogger.error(`爬虫批量执行完成 - 有失败
平台: ${successPlatforms}/${totalPlatforms} 成功
脚本: ${successScripts}/${totalScripts} 成功
耗时: ${Math.round(duration / 1000)}s

失败详情:
${failedList}`)
  } else {
    cronLogger.info(`爬虫批量执行完成: ${successPlatforms}/${totalPlatforms} 平台成功, 耗时 ${Math.round(duration / 1000)}s`)
  }
}
