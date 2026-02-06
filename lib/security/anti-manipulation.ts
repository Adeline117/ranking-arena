/**
 * Anti-Manipulation Detection System
 * 
 * 检测并防止刷榜行为:
 * 1. 同一毫秒多账号刷单
 * 2. 异常交易模式
 * 3. 关联账户检测
 */

import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('AntiManipulation')

// ===== 类型定义 =====

export interface TradeEvent {
  traderId: string
  platform: string
  timestamp: Date
  symbol: string
  side: 'buy' | 'sell'
  size: number
  price: number
  ip?: string
  deviceFingerprint?: string
}

export interface ManipulationAlert {
  type: ManipulationType
  severity: 'low' | 'medium' | 'high' | 'critical'
  traders: string[]
  evidence: Record<string, unknown>
  timestamp: Date
  autoAction?: 'flag' | 'suspend' | 'ban'
}

export type ManipulationType =
  | 'SAME_MS_TRADES'      // 同毫秒多账户交易
  | 'WASH_TRADING'        // 对敲交易
  | 'COORDINATED_TRADES'  // 协调交易
  | 'ABNORMAL_WIN_RATE'   // 异常胜率
  | 'RELATED_ACCOUNTS'    // 关联账户
  | 'IP_CLUSTER'          // IP 聚集

// ===== 配置 =====

const CONFIG = {
  // 同毫秒交易检测
  sameMs: {
    windowMs: 100,           // 100ms 窗口
    minTraders: 3,           // 最少 3 个账户
    severity: 'high' as const,
  },
  // 对敲检测
  washTrading: {
    windowMs: 5000,          // 5s 窗口
    priceDeviation: 0.001,   // 0.1% 价格偏差
    severity: 'critical' as const,
  },
  // 协调交易检测
  coordinated: {
    windowMs: 1000,          // 1s 窗口
    minTraders: 5,           // 最少 5 个账户
    sameDirection: true,     // 同方向
    severity: 'medium' as const,
  },
  // 异常胜率
  abnormalWinRate: {
    threshold: 0.95,         // 95% 胜率
    minTrades: 50,           // 最少 50 笔
    severity: 'medium' as const,
  },
}

// ===== 内存缓存 (生产环境应使用 Redis) =====

class TradeWindow {
  private trades: Map<string, TradeEvent[]> = new Map()
  private cleanupInterval: NodeJS.Timeout

  constructor(private maxAgeMs: number = 60000) {
    this.cleanupInterval = setInterval(() => this.cleanup(), 30000)
  }

  add(trade: TradeEvent): void {
    const key = this.getKey(trade)
    const existing = this.trades.get(key) || []
    existing.push(trade)
    this.trades.set(key, existing)
  }

  getRecent(symbol: string, platform: string, windowMs: number): TradeEvent[] {
    const key = `${platform}:${symbol}`
    const trades = this.trades.get(key) || []
    const cutoff = Date.now() - windowMs
    return trades.filter(t => t.timestamp.getTime() > cutoff)
  }

  private getKey(trade: TradeEvent): string {
    return `${trade.platform}:${trade.symbol}`
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.maxAgeMs
    for (const [key, trades] of this.trades.entries()) {
      const filtered = trades.filter(t => t.timestamp.getTime() > cutoff)
      if (filtered.length === 0) {
        this.trades.delete(key)
      } else {
        this.trades.set(key, filtered)
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval)
    this.trades.clear()
  }
}

// ===== 检测器 =====

export class AntiManipulationDetector {
  private tradeWindow = new TradeWindow()
  private alerts: ManipulationAlert[] = []
  private flaggedTraders = new Set<string>()
  private suspendedTraders = new Set<string>()
  private bannedTraders = new Set<string>()

  /**
   * 处理新交易事件
   */
  async processTrade(trade: TradeEvent): Promise<ManipulationAlert[]> {
    const newAlerts: ManipulationAlert[] = []

    // 检查是否已被封禁
    if (this.bannedTraders.has(trade.traderId)) {
      logger.warn(`Blocked trade from banned trader: ${trade.traderId}`)
      return []
    }

    // 添加到窗口
    this.tradeWindow.add(trade)

    // 运行检测
    const recentTrades = this.tradeWindow.getRecent(
      trade.symbol,
      trade.platform,
      CONFIG.sameMs.windowMs
    )

    // 1. 同毫秒多账户检测
    const sameMsAlert = this.detectSameMsTrades(trade, recentTrades)
    if (sameMsAlert) newAlerts.push(sameMsAlert)

    // 2. 对敲检测
    const washAlert = this.detectWashTrading(trade, recentTrades)
    if (washAlert) newAlerts.push(washAlert)

    // 3. 协调交易检测
    const coordAlert = this.detectCoordinatedTrades(trade, recentTrades)
    if (coordAlert) newAlerts.push(coordAlert)

    // 执行自动操作
    for (const alert of newAlerts) {
      await this.executeAutoAction(alert)
      this.alerts.push(alert)
    }

    return newAlerts
  }

  /**
   * 检测同毫秒多账户交易
   */
  private detectSameMsTrades(
    trade: TradeEvent,
    recentTrades: TradeEvent[]
  ): ManipulationAlert | null {
    const tradeTime = trade.timestamp.getTime()
    
    // 找出同毫秒窗口内的交易
    const sameMsTrades = recentTrades.filter(t => 
      Math.abs(t.timestamp.getTime() - tradeTime) < CONFIG.sameMs.windowMs &&
      t.traderId !== trade.traderId
    )

    // 统计唯一交易员
    const uniqueTraders = new Set(sameMsTrades.map(t => t.traderId))
    uniqueTraders.add(trade.traderId)

    if (uniqueTraders.size >= CONFIG.sameMs.minTraders) {
      const traders = Array.from(uniqueTraders)
      
      logger.warn(`🚨 Same-MS trades detected: ${traders.length} traders in ${CONFIG.sameMs.windowMs}ms`, {
        traders,
        symbol: trade.symbol,
        platform: trade.platform,
      })

      return {
        type: 'SAME_MS_TRADES',
        severity: CONFIG.sameMs.severity,
        traders,
        evidence: {
          windowMs: CONFIG.sameMs.windowMs,
          traderCount: traders.length,
          symbol: trade.symbol,
          platform: trade.platform,
          trades: sameMsTrades.map(t => ({
            traderId: t.traderId,
            timestamp: t.timestamp.toISOString(),
            side: t.side,
            size: t.size,
          })),
        },
        timestamp: new Date(),
        autoAction: 'flag',
      }
    }

    return null
  }

  /**
   * 检测对敲交易 (同价格买卖)
   */
  private detectWashTrading(
    trade: TradeEvent,
    recentTrades: TradeEvent[]
  ): ManipulationAlert | null {
    // 找出相反方向的交易
    const oppositeTrades = recentTrades.filter(t =>
      t.traderId !== trade.traderId &&
      t.side !== trade.side &&
      Math.abs(t.price - trade.price) / trade.price < CONFIG.washTrading.priceDeviation
    )

    if (oppositeTrades.length > 0) {
      const traders = [trade.traderId, ...oppositeTrades.map(t => t.traderId)]
      
      logger.error(`🚨 Wash trading detected`, {
        traders,
        symbol: trade.symbol,
        price: trade.price,
      })

      return {
        type: 'WASH_TRADING',
        severity: CONFIG.washTrading.severity,
        traders: [...new Set(traders)],
        evidence: {
          symbol: trade.symbol,
          price: trade.price,
          priceDeviation: CONFIG.washTrading.priceDeviation,
          oppositeTrades: oppositeTrades.map(t => ({
            traderId: t.traderId,
            side: t.side,
            price: t.price,
          })),
        },
        timestamp: new Date(),
        autoAction: 'suspend',
      }
    }

    return null
  }

  /**
   * 检测协调交易
   */
  private detectCoordinatedTrades(
    trade: TradeEvent,
    recentTrades: TradeEvent[]
  ): ManipulationAlert | null {
    // 找出同方向交易
    const sameDirectionTrades = recentTrades.filter(t =>
      t.traderId !== trade.traderId &&
      t.side === trade.side
    )

    const uniqueTraders = new Set(sameDirectionTrades.map(t => t.traderId))
    uniqueTraders.add(trade.traderId)

    if (uniqueTraders.size >= CONFIG.coordinated.minTraders) {
      const traders = Array.from(uniqueTraders)
      
      logger.warn(`🚨 Coordinated trades detected: ${traders.length} traders, same ${trade.side}`, {
        traders,
        symbol: trade.symbol,
      })

      return {
        type: 'COORDINATED_TRADES',
        severity: CONFIG.coordinated.severity,
        traders,
        evidence: {
          direction: trade.side,
          symbol: trade.symbol,
          traderCount: traders.length,
          windowMs: CONFIG.coordinated.windowMs,
        },
        timestamp: new Date(),
        autoAction: 'flag',
      }
    }

    return null
  }

  /**
   * 执行自动操作
   */
  private async executeAutoAction(alert: ManipulationAlert): Promise<void> {
    if (!alert.autoAction) return

    for (const traderId of alert.traders) {
      switch (alert.autoAction) {
        case 'flag':
          this.flaggedTraders.add(traderId)
          logger.info(`🚩 Flagged trader: ${traderId}`)
          break
        case 'suspend':
          this.suspendedTraders.add(traderId)
          logger.warn(`⏸️ Suspended trader: ${traderId}`)
          break
        case 'ban':
          this.bannedTraders.add(traderId)
          logger.error(`🚫 Banned trader: ${traderId}`)
          break
      }
    }

    // Persist alert to database
    await this.persistAlert(alert)
  }

  /**
   * Persist alert to database via admin API
   */
  private async persistAlert(alert: ManipulationAlert): Promise<void> {
    try {
      const response = await fetch('/api/admin/manipulation/alerts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.CRON_SECRET}`,
        },
        body: JSON.stringify({
          alert_type: alert.type,
          severity: alert.severity,
          traders: alert.traderIds,
          evidence: alert.evidence,
          auto_action: alert.autoAction,
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        logger.error('Failed to persist manipulation alert', { alert, error })
      } else {
        const data = await response.json()
        logger.info('Manipulation alert persisted', { alertId: data.alert?.id, type: alert.type })
      }
    } catch (error) {
      logger.error('Error persisting manipulation alert', { alert }, error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * 获取交易员状态
   */
  getTraderStatus(traderId: string): 'normal' | 'flagged' | 'suspended' | 'banned' {
    if (this.bannedTraders.has(traderId)) return 'banned'
    if (this.suspendedTraders.has(traderId)) return 'suspended'
    if (this.flaggedTraders.has(traderId)) return 'flagged'
    return 'normal'
  }

  /**
   * 获取最近告警
   */
  getRecentAlerts(limit = 100): ManipulationAlert[] {
    return this.alerts.slice(-limit)
  }

  /**
   * 获取统计
   */
  getStats() {
    return {
      flaggedCount: this.flaggedTraders.size,
      suspendedCount: this.suspendedTraders.size,
      bannedCount: this.bannedTraders.size,
      alertCount: this.alerts.length,
      alertsByType: this.alerts.reduce((acc, a) => {
        acc[a.type] = (acc[a.type] || 0) + 1
        return acc
      }, {} as Record<string, number>),
    }
  }

  /**
   * 手动解封
   */
  unban(traderId: string): void {
    this.bannedTraders.delete(traderId)
    this.suspendedTraders.delete(traderId)
    this.flaggedTraders.delete(traderId)
    logger.info(`✅ Unbanned trader: ${traderId}`)
  }
}

// 全局单例
export const antiManipulation = new AntiManipulationDetector()

export default AntiManipulationDetector
