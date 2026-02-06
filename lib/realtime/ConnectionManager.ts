/**
 * Connection Manager - 连接管理与容错
 * 
 * 实现心跳双向检测，API 失效时灰度标记
 * 防止显示 0 收益造成用户恐慌
 */

import { EventEmitter } from 'events'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('ConnectionManager')

export type ConnectionStatus = 
  | 'connected'      // 正常连接
  | 'reconnecting'   // 重连中
  | 'degraded'       // 降级模式（数据可能过期）
  | 'maintenance'    // 维护中
  | 'disconnected'   // 断开连接

export interface ConnectionConfig {
  /** 心跳间隔 (ms) */
  heartbeatInterval: number
  /** 心跳超时 (ms) */
  heartbeatTimeout: number
  /** 最大重连次数 */
  maxReconnectAttempts: number
  /** 重连间隔基数 (ms) */
  reconnectBaseDelay: number
  /** 重连间隔最大值 (ms) */
  reconnectMaxDelay: number
  /** 数据过期阈值 (ms) */
  staleDataThreshold: number
}

export interface ExchangeConnection {
  exchange: string
  status: ConnectionStatus
  lastHeartbeat: number
  lastData: number
  reconnectAttempts: number
  errorCount: number
  lastError?: string
  metadata?: Record<string, unknown>
}

const DEFAULT_CONFIG: ConnectionConfig = {
  heartbeatInterval: 30000,       // 30秒心跳
  heartbeatTimeout: 10000,        // 10秒超时
  maxReconnectAttempts: 5,
  reconnectBaseDelay: 1000,       // 1秒
  reconnectMaxDelay: 60000,       // 最长60秒
  staleDataThreshold: 300000,     // 5分钟数据过期
}

export class ConnectionManager extends EventEmitter {
  private config: ConnectionConfig
  private connections: Map<string, ExchangeConnection> = new Map()
  private heartbeatTimers: Map<string, NodeJS.Timeout> = new Map()
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map()

  constructor(config: Partial<ConnectionConfig> = {}) {
    super()
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 注册交易所连接
   */
  register(exchange: string, metadata?: Record<string, unknown>): void {
    const connection: ExchangeConnection = {
      exchange,
      status: 'disconnected',
      lastHeartbeat: 0,
      lastData: 0,
      reconnectAttempts: 0,
      errorCount: 0,
      metadata,
    }
    
    this.connections.set(exchange, connection)
    logger.info(`Registered connection for ${exchange}`)
  }

  /**
   * 标记连接成功
   */
  markConnected(exchange: string): void {
    const conn = this.connections.get(exchange)
    if (!conn) return

    const prevStatus = conn.status
    conn.status = 'connected'
    conn.lastHeartbeat = Date.now()
    conn.reconnectAttempts = 0
    conn.errorCount = 0
    conn.lastError = undefined

    this.startHeartbeat(exchange)
    
    if (prevStatus !== 'connected') {
      this.emit('statusChange', { exchange, status: 'connected', prevStatus })
      logger.info(`${exchange} connected`)
    }
  }

  /**
   * 记录收到数据
   */
  markDataReceived(exchange: string): void {
    const conn = this.connections.get(exchange)
    if (!conn) return

    conn.lastData = Date.now()
    conn.lastHeartbeat = Date.now()

    // 如果之前是降级模式，恢复正常
    if (conn.status === 'degraded') {
      conn.status = 'connected'
      this.emit('statusChange', { exchange, status: 'connected', prevStatus: 'degraded' })
    }
  }

  /**
   * 标记连接错误
   */
  markError(exchange: string, error: string): void {
    const conn = this.connections.get(exchange)
    if (!conn) return

    conn.errorCount++
    conn.lastError = error
    
    logger.warn(`${exchange} error (${conn.errorCount}): ${error}`)

    // 连续错误过多，进入降级模式
    if (conn.errorCount >= 3 && conn.status === 'connected') {
      this.markDegraded(exchange, '连续错误过多')
    }
  }

  /**
   * 标记为降级模式（灰度标记）
   */
  markDegraded(exchange: string, reason: string): void {
    const conn = this.connections.get(exchange)
    if (!conn) return

    const prevStatus = conn.status
    if (prevStatus === 'disconnected') return // 已断开不用降级

    conn.status = 'degraded'
    this.emit('statusChange', { 
      exchange, 
      status: 'degraded', 
      prevStatus,
      reason,
    })
    
    logger.warn(`${exchange} degraded: ${reason}`)

    // 开始重连
    this.scheduleReconnect(exchange)
  }

  /**
   * 标记为维护中
   */
  markMaintenance(exchange: string): void {
    const conn = this.connections.get(exchange)
    if (!conn) return

    const prevStatus = conn.status
    conn.status = 'maintenance'
    
    this.emit('statusChange', { exchange, status: 'maintenance', prevStatus })
    logger.info(`${exchange} in maintenance`)
  }

  /**
   * 断开连接
   */
  disconnect(exchange: string): void {
    const conn = this.connections.get(exchange)
    if (!conn) return

    const prevStatus = conn.status
    conn.status = 'disconnected'
    
    this.stopHeartbeat(exchange)
    this.cancelReconnect(exchange)
    
    this.emit('statusChange', { exchange, status: 'disconnected', prevStatus })
    logger.info(`${exchange} disconnected`)
  }

  /**
   * 获取连接状态
   */
  getStatus(exchange: string): ExchangeConnection | null {
    return this.connections.get(exchange) || null
  }

  /**
   * 获取所有连接状态
   */
  getAllStatus(): ExchangeConnection[] {
    return Array.from(this.connections.values())
  }

  /**
   * 获取用户友好的状态消息
   */
  getStatusMessage(exchange: string): {
    status: ConnectionStatus
    message: string
    isStale: boolean
    lastUpdate: number | null
  } {
    const conn = this.connections.get(exchange)
    
    if (!conn) {
      return {
        status: 'disconnected',
        message: '未连接',
        isStale: true,
        lastUpdate: null,
      }
    }

    const now = Date.now()
    const isStale = conn.lastData > 0 && 
      (now - conn.lastData) > this.config.staleDataThreshold

    const messages: Record<ConnectionStatus, string> = {
      connected: '数据实时更新',
      reconnecting: '正在重新连接...',
      degraded: '数据维护中，显示最近数据',
      maintenance: '交易所维护中',
      disconnected: '连接已断开',
    }

    return {
      status: conn.status,
      message: messages[conn.status],
      isStale,
      lastUpdate: conn.lastData || null,
    }
  }

  /**
   * 检查数据是否可信
   */
  isDataTrustworthy(exchange: string): boolean {
    const conn = this.connections.get(exchange)
    if (!conn) return false
    
    if (conn.status === 'disconnected') return false
    if (conn.status === 'maintenance') return false
    
    const now = Date.now()
    const isStale = conn.lastData > 0 && 
      (now - conn.lastData) > this.config.staleDataThreshold
    
    return !isStale
  }

  // ── 私有方法 ──

  private startHeartbeat(exchange: string): void {
    this.stopHeartbeat(exchange)

    const timer = setInterval(() => {
      this.checkHeartbeat(exchange)
    }, this.config.heartbeatInterval)

    this.heartbeatTimers.set(exchange, timer)
  }

  private stopHeartbeat(exchange: string): void {
    const timer = this.heartbeatTimers.get(exchange)
    if (timer) {
      clearInterval(timer)
      this.heartbeatTimers.delete(exchange)
    }
  }

  private checkHeartbeat(exchange: string): void {
    const conn = this.connections.get(exchange)
    if (!conn) return

    const now = Date.now()
    const timeSinceHeartbeat = now - conn.lastHeartbeat

    if (timeSinceHeartbeat > this.config.heartbeatTimeout) {
      // 心跳超时
      if (conn.status === 'connected') {
        this.markDegraded(exchange, '心跳超时')
      }
    }

    // 发送心跳请求
    this.emit('heartbeat', { exchange, timestamp: now })
  }

  private scheduleReconnect(exchange: string): void {
    const conn = this.connections.get(exchange)
    if (!conn) return

    if (conn.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.disconnect(exchange)
      this.emit('reconnectFailed', { exchange, attempts: conn.reconnectAttempts })
      return
    }

    conn.status = 'reconnecting'
    conn.reconnectAttempts++

    // 指数退避
    const delay = Math.min(
      this.config.reconnectBaseDelay * Math.pow(2, conn.reconnectAttempts - 1),
      this.config.reconnectMaxDelay
    )

    logger.info(`${exchange} reconnecting in ${delay}ms (attempt ${conn.reconnectAttempts})`)

    const timer = setTimeout(() => {
      this.emit('reconnect', { exchange, attempt: conn.reconnectAttempts })
    }, delay)

    this.reconnectTimers.set(exchange, timer)
  }

  private cancelReconnect(exchange: string): void {
    const timer = this.reconnectTimers.get(exchange)
    if (timer) {
      clearTimeout(timer)
      this.reconnectTimers.delete(exchange)
    }
  }

  /**
   * 清理所有连接
   */
  cleanup(): void {
    for (const exchange of Array.from(this.connections.keys())) {
      this.stopHeartbeat(exchange)
      this.cancelReconnect(exchange)
    }
    this.connections.clear()
  }
}

// 单例
let connectionManager: ConnectionManager | null = null

export function getConnectionManager(): ConnectionManager {
  if (!connectionManager) {
    connectionManager = new ConnectionManager()
  }
  return connectionManager
}

export default ConnectionManager
