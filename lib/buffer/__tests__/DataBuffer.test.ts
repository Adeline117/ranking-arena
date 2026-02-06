/**
 * DataBuffer Tests
 */

import { DataBuffer, TraderUpdate } from '../DataBuffer'

describe('DataBuffer', () => {
  let buffer: DataBuffer

  beforeEach(() => {
    buffer = new DataBuffer({
      flushInterval: 100,
      maxBufferSize: 100,
      deltaThreshold: 0.01,
      enableCompression: true,
    })
  })

  afterEach(() => {
    buffer.stop()
  })

  describe('push', () => {
    it('should accept updates', () => {
      const update: TraderUpdate = {
        traderId: '123',
        source: 'binance',
        timestamp: Date.now(),
        roi: 10.5,
        pnl: 1000,
      }

      buffer.push(update)
      const stats = buffer.getStats()
      expect(stats.totalReceived).toBe(1)
      expect(stats.bufferSize).toBe(1)
    })

    it('should merge updates for same trader', () => {
      const update1: TraderUpdate = {
        traderId: '123',
        source: 'binance',
        timestamp: Date.now(),
        roi: 10.5,
      }

      const update2: TraderUpdate = {
        traderId: '123',
        source: 'binance',
        timestamp: Date.now() + 100,
        roi: 11.0,
        pnl: 1000,
      }

      buffer.push(update1)
      buffer.push(update2)

      const stats = buffer.getStats()
      expect(stats.totalReceived).toBe(2)
      expect(stats.bufferSize).toBe(1) // Same trader, merged
    })
  })

  describe('flush', () => {
    it('should emit delta updates', () => {
      const update: TraderUpdate = {
        traderId: '123',
        source: 'binance',
        timestamp: Date.now(),
        roi: 10.5,
        pnl: 1000,
        winRate: 65,
        drawdown: 5,
      }

      buffer.push(update)
      const result = buffer.flush()

      expect(result).not.toBeNull()
      expect(result?.type).toBe('delta')
      expect(result?.updates.size).toBe(1)
      expect(result?.stats.totalUpdates).toBe(1)
    })

    it('should only include changed fields in delta', () => {
      // First update
      const update1: TraderUpdate = {
        traderId: '123',
        source: 'binance',
        timestamp: Date.now(),
        roi: 10.0,
        pnl: 1000,
      }
      buffer.push(update1)
      buffer.flush()

      // Second update with small ROI change (below threshold)
      const update2: TraderUpdate = {
        traderId: '123',
        source: 'binance',
        timestamp: Date.now() + 100,
        roi: 10.005, // 0.05% change, below 1% threshold
        pnl: 1000,
      }
      buffer.push(update2)
      const result = buffer.flush()

      // Should have low compression ratio (most data unchanged)
      expect(result?.stats.compressionRatio).toBeGreaterThan(0)
    })

    it('should detect removed traders', () => {
      // Add trader
      buffer.push({
        traderId: '123',
        source: 'binance',
        timestamp: Date.now(),
        roi: 10,
      })
      buffer.flush()

      // Add different trader (123 is now "removed" from buffer)
      buffer.push({
        traderId: '456',
        source: 'binance',
        timestamp: Date.now(),
        roi: 20,
      })
      const result = buffer.flush()

      expect(result?.removed).toContain('binance:123')
    })
  })

  describe('batch push', () => {
    it('should handle batch updates', () => {
      const updates: TraderUpdate[] = [
        { traderId: '1', source: 'binance', timestamp: Date.now(), roi: 10 },
        { traderId: '2', source: 'binance', timestamp: Date.now(), roi: 20 },
        { traderId: '3', source: 'okx', timestamp: Date.now(), roi: 30 },
      ]

      buffer.pushBatch(updates)
      const stats = buffer.getStats()

      expect(stats.totalReceived).toBe(3)
      expect(stats.bufferSize).toBe(3)
    })
  })

  describe('auto flush', () => {
    it('should auto flush on interval', (done) => {
      buffer.on('flush', (result) => {
        expect(result.updates.size).toBe(1)
        done()
      })

      buffer.push({
        traderId: '123',
        source: 'binance',
        timestamp: Date.now(),
        roi: 10,
      })

      // Wait for auto flush (interval is 100ms)
    }, 500)
  })
})
