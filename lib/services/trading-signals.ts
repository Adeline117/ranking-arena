/**
 * Trading Signals — Position change detection for Pro alerts
 *
 * Compares current vs previous positions and emits typed change events.
 * Used by the enrichment runner after fetching trader positions.
 */

import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('trading-signals')

// ── Types ────────────────────────────────────────────────────

export type AlertType = 'position_opened' | 'position_closed' | 'size_changed'

export interface Position {
  /** Unique identifier for this position (e.g. symbol or contract address) */
  symbol: string
  /** 'long' or 'short' */
  side: 'long' | 'short'
  /** Size in base currency (e.g. 1.5 BTC) */
  size: number
  /** Entry price if available */
  entryPrice?: number
  /** Unrealized PnL if available */
  unrealizedPnl?: number
  /** Leverage if available */
  leverage?: number
}

export interface PositionChange {
  type: AlertType
  symbol: string
  side: 'long' | 'short'
  /** Previous size (0 for newly opened) */
  previousSize: number
  /** Current size (0 for closed) */
  currentSize: number
  /** Entry price of current position */
  entryPrice?: number
  /** Leverage of current position */
  leverage?: number
}

export interface TraderAlert {
  platform: string
  trader_key: string
  alert_type: AlertType
  details: {
    symbol: string
    side: string
    previous_size: number
    current_size: number
    entry_price?: number
    leverage?: number
  }
}

// ── Core detection ───────────────────────────────────────────

/**
 * Compare current vs previous positions and detect changes.
 *
 * @returns Array of position changes (may be empty)
 */
export function detectPositionChanges(
  platform: string,
  traderId: string,
  currentPositions: Position[],
  previousPositions: Position[],
): PositionChange[] {
  const changes: PositionChange[] = []

  // Build lookup of previous positions by symbol+side
  const prevMap = new Map<string, Position>()
  for (const p of previousPositions) {
    prevMap.set(`${p.symbol}:${p.side}`, p)
  }

  // Build lookup of current positions
  const currMap = new Map<string, Position>()
  for (const p of currentPositions) {
    currMap.set(`${p.symbol}:${p.side}`, p)
  }

  // Check for newly opened or size changed positions
  for (const curr of currentPositions) {
    const key = `${curr.symbol}:${curr.side}`
    const prev = prevMap.get(key)

    if (!prev) {
      // Position opened
      changes.push({
        type: 'position_opened',
        symbol: curr.symbol,
        side: curr.side,
        previousSize: 0,
        currentSize: curr.size,
        entryPrice: curr.entryPrice,
        leverage: curr.leverage,
      })
    } else if (Math.abs(curr.size - prev.size) / Math.max(prev.size, 1) > 0.01) {
      // Size changed by more than 1%
      changes.push({
        type: 'size_changed',
        symbol: curr.symbol,
        side: curr.side,
        previousSize: prev.size,
        currentSize: curr.size,
        entryPrice: curr.entryPrice,
        leverage: curr.leverage,
      })
    }
  }

  // Check for closed positions
  for (const prev of previousPositions) {
    const key = `${prev.symbol}:${prev.side}`
    if (!currMap.has(key)) {
      changes.push({
        type: 'position_closed',
        symbol: prev.symbol,
        side: prev.side,
        previousSize: prev.size,
        currentSize: 0,
        entryPrice: prev.entryPrice,
        leverage: prev.leverage,
      })
    }
  }

  if (changes.length > 0) {
    logger.info(`[trading-signals] ${platform}/${traderId}: ${changes.length} position changes detected`)
  }

  return changes
}

// ── Alert persistence ────────────────────────────────────────

/**
 * Create an alert in the trader_alerts / notifications system
 * for all Pro users watching this trader.
 */
export async function createAlert(
  userId: string,
  alert: TraderAlert,
): Promise<void> {
  try {
    const supabase = getSupabaseAdmin()

    // Insert notification for the watching user
    await supabase.from('notifications').insert({
      user_id: userId,
      type: 'position_change',
      title: formatAlertTitle(alert),
      message: formatAlertMessage(alert),
      link: `/trader/${encodeURIComponent(alert.trader_key)}?platform=${alert.platform}`,
      data: alert.details,
    })
  } catch (err) {
    logger.error(`[trading-signals] Failed to create alert for user ${userId}:`, err)
  }
}

/**
 * Process position changes and notify all watching Pro users.
 */
export async function processPositionChanges(
  platform: string,
  traderId: string,
  changes: PositionChange[],
): Promise<number> {
  if (changes.length === 0) return 0

  const supabase = getSupabaseAdmin()
  let alertsSent = 0

  try {
    // Find Pro users watching this trader with alert_new_position enabled
    const { data: watchingAlerts } = await supabase
      .from('trader_alerts')
      .select('user_id')
      .eq('trader_id', traderId)
      .eq('alert_new_position', true)
      .eq('enabled', true)

    if (!watchingAlerts || watchingAlerts.length === 0) return 0

    const userIds = [...new Set(watchingAlerts.map(a => a.user_id))]

    // Verify these users are Pro
    const { data: proUsers } = await supabase
      .from('subscriptions')
      .select('user_id')
      .in('user_id', userIds)
      .in('status', ['active', 'trialing'])
      .eq('tier', 'pro')

    const proUserIds = new Set(proUsers?.map(u => u.user_id) || [])

    // Create notifications for each change for each Pro user
    const notifications = []
    for (const change of changes) {
      const alert: TraderAlert = {
        platform,
        trader_key: traderId,
        alert_type: change.type,
        details: {
          symbol: change.symbol,
          side: change.side,
          previous_size: change.previousSize,
          current_size: change.currentSize,
          entry_price: change.entryPrice,
          leverage: change.leverage,
        },
      }

      for (const userId of proUserIds) {
        notifications.push({
          user_id: userId,
          type: 'position_change',
          title: formatAlertTitle(alert),
          message: formatAlertMessage(alert),
          link: `/trader/${encodeURIComponent(traderId)}?platform=${platform}`,
          data: alert.details,
        })
      }
    }

    if (notifications.length > 0) {
      const { error } = await supabase.from('notifications').insert(notifications)
      if (error) {
        logger.error('[trading-signals] Failed to insert notifications:', error)
      } else {
        alertsSent = notifications.length
      }
    }
  } catch (err) {
    logger.error('[trading-signals] processPositionChanges error:', err)
  }

  return alertsSent
}

// ── Helpers ──────────────────────────────────────────────────

function formatAlertTitle(alert: TraderAlert): string {
  switch (alert.alert_type) {
    case 'position_opened':
      return `New ${alert.details.side.toUpperCase()} position opened`
    case 'position_closed':
      return `Position closed: ${alert.details.symbol}`
    case 'size_changed':
      return `Position size changed: ${alert.details.symbol}`
    default:
      return 'Position change detected'
  }
}

function formatAlertMessage(alert: TraderAlert): string {
  const d = alert.details
  const platformLabel = alert.platform.replace(/_/g, ' ').toUpperCase()

  switch (alert.alert_type) {
    case 'position_opened':
      return `${platformLabel} trader opened a ${d.side} ${d.symbol} position (size: ${d.current_size}${d.leverage ? `, ${d.leverage}x` : ''})`
    case 'position_closed':
      return `${platformLabel} trader closed their ${d.side} ${d.symbol} position (was: ${d.previous_size})`
    case 'size_changed': {
      const direction = d.current_size > d.previous_size ? 'increased' : 'decreased'
      return `${platformLabel} trader ${direction} ${d.side} ${d.symbol} position (${d.previous_size} -> ${d.current_size})`
    }
    default:
      return `Position change on ${d.symbol}`
  }
}
