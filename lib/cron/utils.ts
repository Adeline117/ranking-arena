/**
 * Cron 任务共享工具
 * 提供认证、日志、脚本执行等共享功能
 * 集成熔断器、重试机制和告警通知
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { exec } from 'child_process'
import { promisify } from 'util'
import {
  getCircuitBreaker,
  withRetry,
  RetryPresets,
  isTransientError,
  getAllCircuitBreakerStats,
} from '@/lib/utils/circuit-breaker'
import { alertError, alertWarning, alertInfo } from '@/lib/utils/alerts'

const execAsync = promisify(exec)

// 脚本执行超时时间（毫秒）
export const SCRIPT_TIMEOUT = 180000 // 3分钟

// 获取平台熔断器
function getPlatformCircuitBreaker(platform: string) {
  return getCircuitBreaker(`cron-${platform}`, {
    failureThreshold: 3, // 3 次失败后熔断
    successThreshold: 1, // 1 次成功后恢复
    timeout: 300000, // 5 分钟后尝试恢复
    onStateChange: async (from, to, name) => {
      console.log(`[Cron] 熔断器 ${name} 状态变化: ${from} -> ${to}`)
      
      // 当熔断器打开时发送紧急告警
      if (to === 'OPEN') {
        await alertError(
          `熔断器已打开: ${name}`,
          `平台 ${platform} 连续失败次数过多，熔断器已打开，后续请求将被阻止 5 分钟`,
          { platform, from, to, circuitBreaker: name }
        ).catch(err => {
          console.error('[Cron] 发送熔断器告警失败:', err)
        })
      }
      
      // 当熔断器从打开恢复时发送通知
      if (from === 'OPEN' && to === 'HALF_OPEN') {
        await alertInfo(
          `熔断器尝试恢复: ${name}`,
          `平台 ${platform} 的熔断器正在尝试恢复，将允许下一次请求通过`,
          { platform, from, to, circuitBreaker: name }
        ).catch(err => {
          console.error('[Cron] 发送熔断器告警失败:', err)
        })
      }
      
      // 当熔断器完全恢复时发送通知
      if (from === 'HALF_OPEN' && to === 'CLOSED') {
        await alertInfo(
          `熔断器已恢复: ${name}`,
          `平台 ${platform} 的熔断器已恢复正常，所有请求将正常执行`,
          { platform, from, to, circuitBreaker: name }
        ).catch(err => {
          console.error('[Cron] 发送熔断器告警失败:', err)
        })
      }
    },
  })
}

// 平台脚本配置
export const PLATFORM_SCRIPTS: Record<string, Array<{ name: string; script: string; args: string[] }>> = {
  binance_futures: [
    { name: 'binance_futures_7d', script: 'scripts/import_binance_futures.mjs', args: ['7D'] },
    { name: 'binance_futures_30d', script: 'scripts/import_binance_futures.mjs', args: ['30D'] },
    { name: 'binance_futures_90d', script: 'scripts/import_binance_futures.mjs', args: ['90D'] },
  ],
  binance_spot: [
    { name: 'binance_spot_7d', script: 'scripts/import_binance_spot.mjs', args: ['7D'] },
    { name: 'binance_spot_30d', script: 'scripts/import_binance_spot.mjs', args: ['30D'] },
    { name: 'binance_spot_90d', script: 'scripts/import_binance_spot.mjs', args: ['90D'] },
  ],
  binance_web3: [
    { name: 'binance_web3_7d', script: 'scripts/import_binance_web3.mjs', args: ['7D'] },
    { name: 'binance_web3_30d', script: 'scripts/import_binance_web3.mjs', args: ['30D'] },
    { name: 'binance_web3_90d', script: 'scripts/import_binance_web3.mjs', args: ['90D'] },
  ],
  bybit: [
    { name: 'bybit_7d', script: 'scripts/import_bybit.mjs', args: ['7D'] },
    { name: 'bybit_30d', script: 'scripts/import_bybit.mjs', args: ['30D'] },
    { name: 'bybit_90d', script: 'scripts/import_bybit.mjs', args: ['90D'] },
  ],
  bitget_futures: [
    { name: 'bitget_futures_7d', script: 'scripts/import_bitget_futures.mjs', args: ['7D'] },
    { name: 'bitget_futures_30d', script: 'scripts/import_bitget_futures.mjs', args: ['30D'] },
    { name: 'bitget_futures_90d', script: 'scripts/import_bitget_futures.mjs', args: ['90D'] },
  ],
  bitget_spot: [
    { name: 'bitget_spot_7d', script: 'scripts/import_bitget_spot.mjs', args: ['7D'] },
    { name: 'bitget_spot_30d', script: 'scripts/import_bitget_spot.mjs', args: ['30D'] },
    { name: 'bitget_spot_90d', script: 'scripts/import_bitget_spot.mjs', args: ['90D'] },
  ],
  mexc: [
    { name: 'mexc_7d', script: 'scripts/import_mexc.mjs', args: ['7D'] },
    { name: 'mexc_30d', script: 'scripts/import_mexc.mjs', args: ['30D'] },
    { name: 'mexc_90d', script: 'scripts/import_mexc.mjs', args: ['90D'] },
  ],
  coinex: [
    { name: 'coinex_7d', script: 'scripts/import_coinex.mjs', args: ['7D'] },
    { name: 'coinex_30d', script: 'scripts/import_coinex.mjs', args: ['30D'] },
    { name: 'coinex_90d', script: 'scripts/import_coinex.mjs', args: ['90D'] },
  ],
  okx_web3: [
    { name: 'okx_web3_7d', script: 'scripts/import_okx_web3.mjs', args: ['7D'] },
    { name: 'okx_web3_30d', script: 'scripts/import_okx_web3.mjs', args: ['30D'] },
    { name: 'okx_web3_90d', script: 'scripts/import_okx_web3.mjs', args: ['90D'] },
  ],
  kucoin: [
    { name: 'kucoin_7d', script: 'scripts/import_kucoin.mjs', args: ['7D'] },
    { name: 'kucoin_30d', script: 'scripts/import_kucoin.mjs', args: ['30D'] },
    { name: 'kucoin_90d', script: 'scripts/import_kucoin.mjs', args: ['90D'] },
  ],
  gmx: [
    { name: 'gmx_7d', script: 'scripts/import_gmx.mjs', args: ['7D'] },
    { name: 'gmx_30d', script: 'scripts/import_gmx.mjs', args: ['30D'] },
    // GMX 没有 90D 数据
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
 */
export function isAuthorized(req: Request): boolean {
  const header = req.headers.get('x-cron-secret') || ''
  const secret = process.env.CRON_SECRET || ''
  // 如果没有配置 CRON_SECRET，在开发环境允许访问
  if (!secret && process.env.NODE_ENV === 'development') {
    return true
  }
  return Boolean(secret) && header === secret
}

/**
 * 创建 Supabase Admin 客户端
 */
export function createSupabaseAdmin(): SupabaseClient | null {
  const { url, serviceKey } = getSupabaseEnv()
  if (!url || !serviceKey) {
    return null
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false },
  })
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
 * 带有重试和熔断器保护
 */
export async function executeScript(
  scriptConfig: { name: string; script: string; args: string[] },
  env: Record<string, string>
): Promise<ScriptResult> {
  const { name } = scriptConfig
  const startTime = Date.now()

  try {
    console.log(`[Cron] 开始执行 ${name}...`)

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
          console.warn(`[Cron] ${name} 第 ${attempt} 次重试，等待 ${Math.round(delay)}ms`)
        },
      }
    )

    const duration = Date.now() - startTime
    console.log(`[Cron] ${name} 完成，耗时 ${duration}ms`)

    return {
      name,
      success: true,
      output: (stdout || stderr).substring(0, 500),
      duration,
    }
  } catch (error: unknown) {
    const duration = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error(`[Cron] ${name} 失败:`, errorMessage)

    return {
      name,
      success: false,
      error: errorMessage.substring(0, 500),
      duration,
    }
  }
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
    console.error(`[Cron] 平台 ${platform} 执行被熔断器阻止或失败:`, error)
  }

  // 发送告警通知
  const circuitBreakerState = circuitBreaker.getState()
  if (failedScripts.length > 0) {
    // 发送错误告警
    await alertError(
      `爬虫执行失败: ${platform}`,
      `失败脚本: ${failedScripts.join(', ')}\n熔断器状态: ${circuitBreakerState}`,
      { 
        platform, 
        failedScripts,
        circuitBreakerState,
        totalScripts: scripts.length,
        failedCount: failedScripts.length,
      }
    ).catch(err => {
      console.error('[Cron] 发送告警失败:', err)
    })
  } else if (circuitBreakerState === 'OPEN') {
    // 熔断器打开时发送警告
    await alertWarning(
      `平台熔断器已打开: ${platform}`,
      `平台 ${platform} 的熔断器当前处于打开状态，请求将被阻止`,
      { platform, circuitBreakerState }
    ).catch(err => {
      console.error('[Cron] 发送告警失败:', err)
    })
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
    console.warn('[Cron] 无法记录日志:', error)
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
    failedScripts,
    duration,
    failedDetails,
  } = summary

  if (failedPlatforms > 0) {
    const failedList = failedDetails
      ?.map(d => `${d.platform}: ${d.scripts.join(', ')}`)
      .join('\n') || '未知'

    await alertError(
      `爬虫批量执行完成 - 有失败`,
      `平台: ${successPlatforms}/${totalPlatforms} 成功\n` +
      `脚本: ${successScripts}/${totalScripts} 成功\n` +
      `耗时: ${Math.round(duration / 1000)}s\n\n` +
      `失败详情:\n${failedList}`,
      { 
        ...summary,
        type: 'scrape_summary',
      }
    ).catch(err => {
      console.error('[Cron] 发送摘要告警失败:', err)
    })
  } else {
    // 全部成功时可以选择不发送，或发送 info 级别
    // 这里我们只在有失败时发送告警
    console.log(`[Cron] 爬虫批量执行完成: ${successPlatforms}/${totalPlatforms} 平台成功, 耗时 ${Math.round(duration / 1000)}s`)
  }
}
