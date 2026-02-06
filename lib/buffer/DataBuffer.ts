/**
 * Data Buffer - 数据平滑处理
 * 
 * 问题: 交易所 WebSocket 推送高频，直接更新前端会导致页面闪烁、CPU 占用过高
 * 解决: 实现缓冲区，每 200-500ms 聚合一次，只推送变化的部分 (Delta)
 */

import { EventEmitter } from 'events'

export interface BufferConfig {
  flushInterval: number      // 刷新间隔 (ms), 默认 300ms
  maxBufferSize: number      // 最大缓冲条数, 默认 1000
  deltaThreshold: number     // 变化阈值 (%), 低于此值不推送
  enableCompression: boolean // 是否启用 Delta 压缩
}

export interface TraderUpdate {
  traderId: string
  source: string
  timestamp: number
  roi?: number
  pnl?: number
  winRate?: number
  drawdown?: number
  rank?: number
}

export interface DeltaUpdate {
  type: 'delta' | 'full'
  timestamp: number
  updates: Map<string, Partial<TraderUpdate>>
  removed: string[]
  stats: {
    totalUpdates: number
    deltaCount: number
    compressionRatio: number
  }
}

const DEFAULT_CONFIG: BufferConfig = {
  flushInterval: 300,
  maxBufferSize: 1000,
  deltaThreshold: 0.01, // 0.01% 变化阈值
  enableCompression: true,
}

export class DataBuffer extends EventEmitter {
  private config: BufferConfig
  private buffer: Map<string, TraderUpdate> = new Map()
  private lastState: Map<string, TraderUpdate> = new Map()
  private flushTimer: NodeJS.Timeout | null = null
  private stats = {
    totalReceived: 0,
    totalFlushed: 0,
    droppedUpdates: 0,
  }

  constructor(config: Partial<BufferConfig> = {}) {
    super()
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.startFlushTimer()
  }

  /**
   * 接收单条更新
   */
  push(update: TraderUpdate): void {
    this.stats.totalReceived++
    
    // 检查缓冲区大小
    if (this.buffer.size >= this.config.maxBufferSize) {
      this.stats.droppedUpdates++
      // 强制刷新
      this.flush()
    }

    const key = `${update.source}:${update.traderId}`
    const existing = this.buffer.get(key)
    
    // 合并更新 (保留最新值)
    if (existing) {
      this.buffer.set(key, {
        ...existing,
        ...update,
        timestamp: Math.max(existing.timestamp, update.timestamp),
      })
    } else {
      this.buffer.set(key, update)
    }
  }

  /**
   * 批量接收更新
   */
  pushBatch(updates: TraderUpdate[]): void {
    for (const update of updates) {
      this.push(update)
    }
  }

  /**
   * 刷新缓冲区，计算 Delta 并发送
   */
  flush(): DeltaUpdate | null {
    if (this.buffer.size === 0) return null

    const updates = new Map<string, Partial<TraderUpdate>>()
    const removed: string[] = []
    let deltaCount = 0

    // 计算 Delta
    for (const [key, current] of Array.from(this.buffer)) {
      const previous = this.lastState.get(key)
      
      if (!previous) {
        // 新增
        updates.set(key, current)
        deltaCount++
      } else if (this.config.enableCompression) {
        // 计算差异
        const delta = this.computeDelta(previous, current)
        if (delta && Object.keys(delta).length > 0) {
          updates.set(key, delta)
          deltaCount++
        }
      } else {
        updates.set(key, current)
        deltaCount++
      }
      
      // 更新状态
      this.lastState.set(key, current)
    }

    // 检测移除的交易员
    for (const key of Array.from(this.lastState.keys())) {
      if (!this.buffer.has(key)) {
        removed.push(key)
        this.lastState.delete(key)
      }
    }

    const result: DeltaUpdate = {
      type: this.config.enableCompression ? 'delta' : 'full',
      timestamp: Date.now(),
      updates,
      removed,
      stats: {
        totalUpdates: this.buffer.size,
        deltaCount,
        compressionRatio: this.buffer.size > 0 
          ? 1 - (deltaCount / this.buffer.size) 
          : 0,
      },
    }

    this.stats.totalFlushed += deltaCount
    this.buffer.clear()
    
    this.emit('flush', result)
    return result
  }

  /**
   * 计算两个状态之间的差异
   */
  private computeDelta(
    previous: TraderUpdate, 
    current: TraderUpdate
  ): Partial<TraderUpdate> | null {
    const delta: Partial<TraderUpdate> = {}
    let hasChange = false

    const checkField = (field: keyof TraderUpdate, threshold = this.config.deltaThreshold) => {
      const prev = previous[field] as number | undefined
      const curr = current[field] as number | undefined
      
      if (curr === undefined) return
      if (prev === undefined) {
        (delta as Record<string, unknown>)[field] = curr
        hasChange = true
        return
      }
      
      // 检查变化是否超过阈值
      const change = Math.abs((curr - prev) / (prev || 1))
      if (change > threshold) {
        (delta as Record<string, unknown>)[field] = curr
        hasChange = true
      }
    }

    checkField('roi')
    checkField('pnl')
    checkField('winRate')
    checkField('drawdown')
    checkField('rank', 0) // rank 变化始终推送

    if (hasChange) {
      delta.traderId = current.traderId
      delta.source = current.source
      delta.timestamp = current.timestamp
    }

    return hasChange ? delta : null
  }

  /**
   * 启动定时刷新
   */
  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush()
    }, this.config.flushInterval)
  }

  /**
   * 停止缓冲区
   */
  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    this.flush() // 最后一次刷新
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.stats,
      bufferSize: this.buffer.size,
      stateSize: this.lastState.size,
      config: this.config,
    }
  }

  /**
   * 重置状态
   */
  reset(): void {
    this.buffer.clear()
    this.lastState.clear()
    this.stats = {
      totalReceived: 0,
      totalFlushed: 0,
      droppedUpdates: 0,
    }
  }
}

// 单例导出
let defaultBuffer: DataBuffer | null = null

export function getDataBuffer(config?: Partial<BufferConfig>): DataBuffer {
  if (!defaultBuffer) {
    defaultBuffer = new DataBuffer(config)
  }
  return defaultBuffer
}

export default DataBuffer
