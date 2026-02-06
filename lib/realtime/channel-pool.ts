/**
 * Realtime Channel Pool Manager
 *
 * Prevents WebSocket connection leaks by reusing channels for the same table/filter combination.
 * Multiple components subscribing to the same data share a single underlying channel.
 *
 * Features:
 * - Reference counting for automatic cleanup
 * - Callback aggregation for multiple subscribers
 * - Connection state management
 * - Memory leak prevention
 */

import { supabase } from '@/lib/supabase/client'
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import { REALTIME_LISTEN_TYPES, REALTIME_POSTGRES_CHANGES_LISTEN_EVENT } from '@supabase/realtime-js'

// ============================================
// Types
// ============================================

type PostgresChangeEvent = 'INSERT' | 'UPDATE' | 'DELETE' | '*'

// Map our event types to Supabase's enum
const eventToSupabaseEvent = {
  '*': REALTIME_POSTGRES_CHANGES_LISTEN_EVENT.ALL,
  'INSERT': REALTIME_POSTGRES_CHANGES_LISTEN_EVENT.INSERT,
  'UPDATE': REALTIME_POSTGRES_CHANGES_LISTEN_EVENT.UPDATE,
  'DELETE': REALTIME_POSTGRES_CHANGES_LISTEN_EVENT.DELETE,
} as const

export interface ChannelSubscription {
  onInsert?: (payload: Record<string, unknown>) => void
  onUpdate?: (payload: { old: Record<string, unknown>; new: Record<string, unknown> }) => void
  onDelete?: (payload: Record<string, unknown>) => void
}

interface PooledChannel {
  channel: RealtimeChannel
  refCount: number
  subscriptions: Map<string, ChannelSubscription>
  status: 'connecting' | 'connected' | 'error' | 'closed'
  createdAt: Date
  lastActivity: Date
}

interface ChannelPoolStats {
  totalChannels: number
  totalSubscriptions: number
  channelDetails: Array<{
    key: string
    refCount: number
    status: string
    age: number
  }>
}

// ============================================
// Channel Pool Manager (Singleton)
// ============================================

class RealtimeChannelPool {
  private channels: Map<string, PooledChannel> = new Map()
  private cleanupInterval: NodeJS.Timeout | null = null
  private readonly CLEANUP_INTERVAL_MS = 60000 // 1 minute
  private readonly STALE_THRESHOLD_MS = 300000 // 5 minutes with no subscribers

  constructor() {
    // Start cleanup timer in browser environment
    if (typeof window !== 'undefined') {
      this.startCleanupTimer()
    }
  }

  /**
   * Generate a unique key for a channel based on table and filter
   */
  private getChannelKey(
    schema: string,
    table: string,
    event: PostgresChangeEvent,
    filter?: string
  ): string {
    return `${schema}:${table}:${event}:${filter || 'all'}`
  }

  /**
   * Subscribe to a table's changes
   * Returns an unsubscribe function
   */
  subscribe(
    config: {
      schema?: string
      table: string
      event?: PostgresChangeEvent
      filter?: string
    },
    callbacks: ChannelSubscription
  ): () => void {
    const { schema = 'public', table, event = '*', filter } = config
    const key = this.getChannelKey(schema, table, event, filter)
    const subscriptionId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    let pooledChannel = this.channels.get(key)

    if (!pooledChannel) {
      // Create new channel
      const channel = supabase.channel(`pool:${key}`)

      pooledChannel = {
        channel,
        refCount: 0,
        subscriptions: new Map(),
        status: 'connecting',
        createdAt: new Date(),
        lastActivity: new Date(),
      }

      // Configure the channel with Supabase realtime postgres_changes
      const supabaseEvent = eventToSupabaseEvent[event]
      // Cast to unknown first to bypass overly strict Supabase types
      const channelAny = channel as unknown as {
        on: (
          type: string,
          filter: Record<string, unknown>,
          callback: (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => void
        ) => { subscribe: (callback: (status: string) => void) => void }
      }
      channelAny
        .on(
          'postgres_changes',
          {
            event: supabaseEvent,
            schema,
            table,
            ...(filter ? { filter } : {}),
          },
          (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
            this.handleChange(key, payload)
          }
        )
        .subscribe((status: string) => {
          const pc = this.channels.get(key)
          if (!pc) return

          if (status === 'SUBSCRIBED') {
            pc.status = 'connected'
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            pc.status = 'error'
          } else if (status === 'CLOSED') {
            pc.status = 'closed'
          }
        })

      this.channels.set(key, pooledChannel)
    }

    // Add subscription
    pooledChannel.refCount++
    pooledChannel.subscriptions.set(subscriptionId, callbacks)
    pooledChannel.lastActivity = new Date()

    // Return unsubscribe function
    return () => {
      this.unsubscribe(key, subscriptionId)
    }
  }

  /**
   * Handle incoming changes and dispatch to all subscribers
   */
  private handleChange(
    key: string,
    payload: RealtimePostgresChangesPayload<Record<string, unknown>>
  ): void {
    const pooledChannel = this.channels.get(key)
    if (!pooledChannel) return

    pooledChannel.lastActivity = new Date()

    // Dispatch to all subscribers
    for (const [, callbacks] of pooledChannel.subscriptions) {
      try {
        switch (payload.eventType) {
          case 'INSERT':
            callbacks.onInsert?.(payload.new)
            break
          case 'UPDATE':
            callbacks.onUpdate?.({ old: payload.old, new: payload.new })
            break
          case 'DELETE':
            callbacks.onDelete?.(payload.old)
            break
        }
      } catch (error) {
        console.error('[ChannelPool] Error in subscription callback:', error)
      }
    }
  }

  /**
   * Unsubscribe a specific subscription
   */
  private unsubscribe(key: string, subscriptionId: string): void {
    const pooledChannel = this.channels.get(key)
    if (!pooledChannel) return

    pooledChannel.subscriptions.delete(subscriptionId)
    pooledChannel.refCount--

    // If no more subscribers, schedule cleanup
    if (pooledChannel.refCount <= 0) {
      this.scheduleChannelCleanup(key)
    }
  }

  /**
   * Schedule channel cleanup (delayed to allow for quick re-subscriptions)
   */
  private scheduleChannelCleanup(key: string): void {
    // Delay cleanup by 5 seconds to allow for component re-mounting
    setTimeout(() => {
      const pooledChannel = this.channels.get(key)
      if (pooledChannel && pooledChannel.refCount <= 0) {
        this.removeChannel(key)
      }
    }, 5000)
  }

  /**
   * Remove a channel from the pool
   */
  private removeChannel(key: string): void {
    const pooledChannel = this.channels.get(key)
    if (!pooledChannel) return

    try {
      supabase.removeChannel(pooledChannel.channel)
    } catch (error) {
      console.error('[ChannelPool] Error removing channel:', error)
    }

    this.channels.delete(key)
  }

  /**
   * Start periodic cleanup of stale channels
   */
  private startCleanupTimer(): void {
    if (this.cleanupInterval) return

    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleChannels()
    }, this.CLEANUP_INTERVAL_MS)
  }

  /**
   * Clean up channels that have been unused for too long
   */
  private cleanupStaleChannels(): void {
    const now = Date.now()

    for (const [key, pooledChannel] of this.channels) {
      // Remove channels with no subscribers that are stale
      if (
        pooledChannel.refCount <= 0 &&
        now - pooledChannel.lastActivity.getTime() > this.STALE_THRESHOLD_MS
      ) {
        this.removeChannel(key)
      }
    }
  }

  /**
   * Get pool statistics for monitoring
   */
  getStats(): ChannelPoolStats {
    const channelDetails: ChannelPoolStats['channelDetails'] = []
    let totalSubscriptions = 0

    for (const [key, pooledChannel] of this.channels) {
      totalSubscriptions += pooledChannel.refCount
      channelDetails.push({
        key,
        refCount: pooledChannel.refCount,
        status: pooledChannel.status,
        age: Date.now() - pooledChannel.createdAt.getTime(),
      })
    }

    return {
      totalChannels: this.channels.size,
      totalSubscriptions,
      channelDetails,
    }
  }

  /**
   * Force cleanup all channels (for testing or shutdown)
   */
  cleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }

    for (const key of this.channels.keys()) {
      this.removeChannel(key)
    }
  }

  /**
   * Check if a channel exists for a given configuration
   */
  hasChannel(
    schema: string,
    table: string,
    event: PostgresChangeEvent,
    filter?: string
  ): boolean {
    const key = this.getChannelKey(schema, table, event, filter)
    return this.channels.has(key)
  }

  /**
   * Get the number of subscribers for a channel
   */
  getSubscriberCount(
    schema: string,
    table: string,
    event: PostgresChangeEvent,
    filter?: string
  ): number {
    const key = this.getChannelKey(schema, table, event, filter)
    const pooledChannel = this.channels.get(key)
    return pooledChannel?.refCount || 0
  }
}

// Export singleton instance
export const channelPool = new RealtimeChannelPool()

// Export class for testing
export { RealtimeChannelPool }
