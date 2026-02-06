'use client'

/**
 * useTradeAlertHaptics - 交易提醒触觉反馈
 * 
 * 当用户关注的大神开仓/平仓时，触发手机震动
 * 提供物理层面的反馈，大幅提高留存
 */

import { useEffect, useCallback, useRef } from 'react'
import { hapticTradeNotification, isHapticSupported } from '@/lib/utils/haptics'

interface TradeAlert {
  traderKey: string
  type: 'open' | 'close' | 'stopLoss' | 'takeProfit'
  symbol?: string
  side?: 'long' | 'short'
  size?: number
  pnl?: number
  timestamp: Date
}

interface UseTradeAlertHapticsOptions {
  /** 是否启用 */
  enabled?: boolean
  /** 关注的交易员列表 */
  followedTraders?: string[]
  /** 自定义过滤器 */
  filter?: (alert: TradeAlert) => boolean
  /** 回调 */
  onAlert?: (alert: TradeAlert) => void
}

export function useTradeAlertHaptics({
  enabled = true,
  followedTraders = [],
  filter,
  onAlert,
}: UseTradeAlertHapticsOptions = {}) {
  const isSupported = isHapticSupported()
  const followedSet = useRef(new Set(followedTraders))
  
  // Update followed traders set
  useEffect(() => {
    followedSet.current = new Set(followedTraders)
  }, [followedTraders])
  
  /**
   * Process incoming trade alert
   */
  const processAlert = useCallback((alert: TradeAlert) => {
    if (!enabled || !isSupported) {
      return
    }
    
    // Check if trader is followed
    if (followedTraders.length > 0 && !followedSet.current.has(alert.traderKey)) {
      return
    }
    
    // Apply custom filter
    if (filter && !filter(alert)) {
      return
    }
    
    // Trigger haptic feedback
    hapticTradeNotification(alert.type, alert.pnl)
    
    // Call callback
    onAlert?.(alert)
  }, [enabled, isSupported, followedTraders.length, filter, onAlert])
  
  return {
    isSupported,
    processAlert,
  }
}

/**
 * Hook for integrating with realtime subscriptions
 */
export function useRealtimeTradeHaptics(options: UseTradeAlertHapticsOptions = {}) {
  const { processAlert, isSupported } = useTradeAlertHaptics(options)
  
  /**
   * Handle realtime payload from Supabase
   */
  const handleRealtimePayload = useCallback((payload: {
    eventType: 'INSERT' | 'UPDATE' | 'DELETE'
    new?: {
      trader_key?: string
      event_type?: string
      symbol?: string
      side?: string
      size?: number
      pnl?: number
      created_at?: string
    }
  }) => {
    if (payload.eventType !== 'INSERT' || !payload.new) {
      return
    }
    
    const data = payload.new
    
    // Map event type to our alert type
    let alertType: TradeAlert['type']
    switch (data.event_type) {
      case 'position_open':
      case 'trade_open':
        alertType = 'open'
        break
      case 'position_close':
      case 'trade_close':
        alertType = 'close'
        break
      case 'stop_loss':
        alertType = 'stopLoss'
        break
      case 'take_profit':
        alertType = 'takeProfit'
        break
      default:
        return
    }
    
    processAlert({
      traderKey: data.trader_key || '',
      type: alertType,
      symbol: data.symbol,
      side: data.side as 'long' | 'short' | undefined,
      size: data.size,
      pnl: data.pnl,
      timestamp: new Date(data.created_at || Date.now()),
    })
  }, [processAlert])
  
  return {
    isSupported,
    handleRealtimePayload,
    processAlert,
  }
}

export default useTradeAlertHaptics
