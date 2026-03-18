/**
 * QStash Cron Client
 * 
 * 使用 Upstash QStash 替代 Vercel Cron
 * 解决 child_process 在 serverless 失效的问题
 */

import { Client } from '@upstash/qstash'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('QStash')

// ===== 配置 =====

const QSTASH_TOKEN = process.env.QSTASH_TOKEN
const QSTASH_CURRENT_SIGNING_KEY = process.env.QSTASH_CURRENT_SIGNING_KEY
const QSTASH_NEXT_SIGNING_KEY = process.env.QSTASH_NEXT_SIGNING_KEY
const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://arena.trading'

// ===== 平台刷新配置 =====

export interface PlatformCronConfig {
  platform: string
  schedule: string  // Cron 表达式
  endpoint: string  // API 路由
  enabled: boolean
  priority: 'high' | 'medium' | 'low'
  retryCount?: number
  timeoutMs?: number
}

export const PLATFORM_CRON_CONFIGS: PlatformCronConfig[] = [
  // 高优先级 - 每小时
  { platform: 'binance_futures', schedule: '0 * * * *', endpoint: '/api/cron/binance-futures', enabled: true, priority: 'high' },
  // binance_spot: PERMANENTLY REMOVED (2026-03-14) - repeatedly hangs 45-76min, blocks entire pipeline
  { platform: 'okx_futures', schedule: '10 * * * *', endpoint: '/api/cron/okx-futures', enabled: true, priority: 'high' },
  { platform: 'bybit', schedule: '15 * * * *', endpoint: '/api/cron/bybit', enabled: true, priority: 'high' },
  
  // 中优先级 - 每 2 小时
  { platform: 'htx_futures', schedule: '20 */2 * * *', endpoint: '/api/cron/htx-futures', enabled: true, priority: 'medium' },
  { platform: 'mexc', schedule: '25 */2 * * *', endpoint: '/api/cron/mexc', enabled: true, priority: 'medium' },
  // bitget_futures/spot: DISABLED 2026-03-18 EMERGENCY #7 - VPS scraper hangs 44+ min repeatedly
  { platform: 'bitget_futures', schedule: '30 */2 * * *', endpoint: '/api/cron/bitget-futures', enabled: false, priority: 'medium' },
  { platform: 'bitget_spot', schedule: '35 */2 * * *', endpoint: '/api/cron/bitget-spot', enabled: false, priority: 'medium' },
  
  // 低优先级 - 每 4 小时
  { platform: 'hyperliquid', schedule: '40 */4 * * *', endpoint: '/api/cron/hyperliquid', enabled: true, priority: 'low' },
  { platform: 'gmx', schedule: '45 */4 * * *', endpoint: '/api/cron/gmx', enabled: true, priority: 'low' },
  { platform: 'gains', schedule: '50 */4 * * *', endpoint: '/api/cron/gains', enabled: true, priority: 'low' },
  { platform: 'dydx', schedule: '55 */4 * * *', endpoint: '/api/cron/dydx', enabled: false, priority: 'low' }, // Geo-blocked
]

// ===== QStash 客户端 =====

class QStashCronManager {
  private client: Client | null = null

  constructor() {
    if (QSTASH_TOKEN) {
      this.client = new Client({ token: QSTASH_TOKEN })
    } else {
      logger.warn('QStash token not configured, cron jobs will be disabled')
    }
  }

  /**
   * 调度单个平台刷新
   */
  async schedulePlatformRefresh(config: PlatformCronConfig): Promise<string | null> {
    if (!this.client) {
      logger.warn(`Cannot schedule ${config.platform}: QStash not configured`)
      return null
    }

    try {
      // Convert ms to seconds for QStash timeout (must be in format like '30s')
      const timeoutSec = config.timeoutMs ? Math.ceil(config.timeoutMs / 1000) : 30
      const result = await this.client.publishJSON({
        url: `${BASE_URL}${config.endpoint}`,
        body: { platform: config.platform, timestamp: new Date().toISOString() },
        retries: config.retryCount ?? 3,
        timeout: `${timeoutSec}s` as `${bigint}s`,
      })

      const messageId = 'messageId' in result ? result.messageId : undefined
      logger.info(`Scheduled ${config.platform} refresh`, { messageId })
      return messageId ?? null
    } catch (error) {
      logger.error(`Failed to schedule ${config.platform}:`, error)
      return null
    }
  }

  /**
   * 设置所有平台的定时任务
   */
  async setupAllSchedules(): Promise<void> {
    if (!this.client) {
      logger.warn('Cannot setup schedules: QStash not configured')
      return
    }

    const enabledConfigs = PLATFORM_CRON_CONFIGS.filter(c => c.enabled)
    
    for (const config of enabledConfigs) {
      try {
        await this.client.schedules.create({
          destination: `${BASE_URL}${config.endpoint}`,
          cron: config.schedule,
          retries: config.retryCount ?? 3,
        })
        logger.info(`Created schedule for ${config.platform}: ${config.schedule}`)
      } catch (error) {
        // 可能已存在
        logger.warn(`Schedule for ${config.platform} may already exist:`, error)
      }
    }
  }

  /**
   * 列出所有定时任务
   */
  async listSchedules() {
    if (!this.client) return []
    
    try {
      const schedules = await this.client.schedules.list()
      return schedules
    } catch (error) {
      logger.error('Failed to list schedules:', error)
      return []
    }
  }

  /**
   * 删除所有定时任务
   */
  async deleteAllSchedules(): Promise<void> {
    if (!this.client) return
    
    const schedules = await this.listSchedules()
    for (const schedule of schedules) {
      try {
        await this.client.schedules.delete(schedule.scheduleId)
        logger.info(`Deleted schedule: ${schedule.scheduleId}`)
      } catch (error) {
        logger.error(`Failed to delete schedule ${schedule.scheduleId}:`, error)
      }
    }
  }

  /**
   * 立即触发所有平台刷新 (用于手动刷新)
   */
  async triggerAllNow(): Promise<void> {
    const enabledConfigs = PLATFORM_CRON_CONFIGS.filter(c => c.enabled)
    
    // 按优先级分组，避免并发过多
    const highPriority = enabledConfigs.filter(c => c.priority === 'high')
    const mediumPriority = enabledConfigs.filter(c => c.priority === 'medium')
    const lowPriority = enabledConfigs.filter(c => c.priority === 'low')

    // 依次执行
    for (const config of highPriority) {
      await this.schedulePlatformRefresh(config)
      await delay(1000) // 1s 间隔
    }

    for (const config of mediumPriority) {
      await this.schedulePlatformRefresh(config)
      await delay(2000)
    }

    for (const config of lowPriority) {
      await this.schedulePlatformRefresh(config)
      await delay(3000)
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ===== 验证 QStash 签名 =====

export async function verifyQStashSignature(
  signature: string,
  body: string
): Promise<boolean> {
  if (!QSTASH_CURRENT_SIGNING_KEY) {
    logger.warn('QStash signing key not configured, skipping verification')
    return true // 开发环境跳过验证
  }

  try {
    const { Receiver } = await import('@upstash/qstash')
    const receiver = new Receiver({
      currentSigningKey: QSTASH_CURRENT_SIGNING_KEY,
      nextSigningKey: QSTASH_NEXT_SIGNING_KEY || '',
    })

    const isValid = await receiver.verify({
      signature,
      body,
    })

    return isValid
  } catch (error) {
    logger.error('QStash signature verification failed:', error)
    return false
  }
}

// ===== 导出单例 =====

export const qstashCron = new QStashCronManager()

export default qstashCron
