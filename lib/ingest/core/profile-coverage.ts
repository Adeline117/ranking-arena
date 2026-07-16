import type { ParsedProfile } from './types'

export interface IncompleteProfileWindow {
  timeframe: number
  reason: string
}

/** Return the first whole-window metric block that must not enter serving. */
export function findIncompleteProfileWindow(
  profile: Pick<ParsedProfile, 'stats'>
): IncompleteProfileWindow | null {
  const stat = profile.stats.find(
    (candidate) => candidate.extras.profile_window_metrics_complete === false
  )
  if (!stat) return null

  const genericReason = stat.extras.profile_window_metrics_incomplete_reason
  const legacyGtradeReason = stat.extras.gtrade_trades_incomplete_reason
  return {
    timeframe: stat.timeframe,
    reason:
      typeof genericReason === 'string'
        ? genericReason
        : typeof legacyGtradeReason === 'string'
          ? legacyGtradeReason
          : 'unproven_window',
  }
}

export class IncompleteProfileWindowError extends Error {
  readonly timeframe: number
  readonly reason: string

  constructor(timeframe: number, reason: string) {
    super(`incomplete profile window ${timeframe}d: ${reason}`)
    this.name = 'IncompleteProfileWindowError'
    this.timeframe = timeframe
    this.reason = reason
  }
}
