/**
 * Haptic Feedback Utilities
 *
 * 提供移动端触觉反馈
 * 当用户关注的大神开仓时，手机会有特定节奏的微震
 */

// Vibration patterns (in milliseconds)
// [vibrate, pause, vibrate, pause, ...]
export const HAPTIC_PATTERNS = {
  // 轻触 - 按钮点击
  light: [10],

  // 中等 - 选择确认
  medium: [20],

  // 重击 - 重要操作
  heavy: [30],

  // 成功 - 交易盈利
  success: [10, 50, 10],

  // 警告 - 风险提示
  warning: [20, 100, 20, 100, 20],

  // 错误 - 交易亏损
  error: [50, 100, 50],

  // [ALERT] 开仓通知 - 关注的大神开仓
  // 特定节奏：短-短-长 (像心跳)
  tradeOpen: [15, 80, 15, 80, 40],

  // [ALERT] 平仓通知
  tradeClose: [20, 60, 20],

  // [TROPHY] 达到新高
  newHigh: [10, 40, 10, 40, 10, 40, 30],

  // [PROFIT] 大额盈利 (>1000 USD)
  bigWin: [15, 50, 15, 50, 15, 50, 50, 100, 50],

  // [WARN] 止损触发
  stopLoss: [40, 100, 40, 100, 40, 100, 40],
} as const

export type HapticPattern = keyof typeof HAPTIC_PATTERNS

// 用户偏好(2026-07-11):此前设置页"触觉反馈"开关是死代码 —— 不持久化、
// haptic() 也不读它。现用 localStorage(设备本地语义,契合触觉本就设备相关)。
// 惰性读取:首次调用时从 localStorage 同步(无需 boot hook),默认 true 防误静音。
const HAPTIC_PREF_KEY = 'haptic-enabled'
let hapticsEnabled: boolean | null = null

function hapticsAllowed(): boolean {
  if (hapticsEnabled === null) {
    if (typeof window === 'undefined') return true // SSR: assume on, client re-reads
    try {
      hapticsEnabled = window.localStorage.getItem(HAPTIC_PREF_KEY) !== 'false'
    } catch {
      hapticsEnabled = true
    }
  }
  return hapticsEnabled
}

/** Persist + apply the user's haptic preference (called by the settings toggle). */
export function setHapticsEnabled(enabled: boolean): void {
  hapticsEnabled = enabled
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(HAPTIC_PREF_KEY, enabled ? 'true' : 'false')
  } catch {
    /* localStorage unavailable — in-memory flag still applies this session */
  }
}

/** Current preference (for the settings toggle's initial checked state). */
export function isHapticsEnabled(): boolean {
  return hapticsAllowed()
}

/**
 * Check if vibration is supported
 */
export function isHapticSupported(): boolean {
  return typeof navigator !== 'undefined' && 'vibrate' in navigator
}

/**
 * Trigger haptic feedback with a predefined pattern
 */
export function haptic(pattern: HapticPattern = 'light'): boolean {
  if (!hapticsAllowed() || !isHapticSupported()) {
    return false
  }

  try {
    const vibrationPattern = HAPTIC_PATTERNS[pattern]
    return navigator.vibrate(vibrationPattern)
  } catch (_err) {
    /* non-critical: vibration API not supported */
    return false
  }
}

/**
 * Trigger custom vibration pattern
 */
export function hapticCustom(pattern: number[]): boolean {
  if (!hapticsAllowed() || !isHapticSupported()) {
    return false
  }

  try {
    return navigator.vibrate(pattern)
  } catch (_err) {
    /* non-critical: vibration API not supported */
    return false
  }
}

/**
 * Stop any ongoing vibration
 */
export function hapticStop(): boolean {
  if (!isHapticSupported()) {
    return false
  }

  try {
    return navigator.vibrate(0)
  } catch (_err) {
    /* non-critical: vibration API not supported */
    return false
  }
}

/**
 * React hook for haptic feedback
 */
export function useHaptic() {
  return {
    isSupported: isHapticSupported(),
    trigger: haptic,
    triggerCustom: hapticCustom,
    stop: hapticStop,
    patterns: HAPTIC_PATTERNS,
  }
}

/**
 * Trade notification with appropriate haptic
 *
 * @param type - Type of trade event
 * @param pnl - Profit/loss amount (for intensity adjustment)
 */
export function hapticTradeNotification(
  type: 'open' | 'close' | 'stopLoss' | 'takeProfit',
  pnl?: number
): boolean {
  if (!isHapticSupported()) {
    return false
  }

  switch (type) {
    case 'open':
      return haptic('tradeOpen')

    case 'close':
      // Big win gets special pattern
      if (pnl && pnl > 1000) {
        return haptic('bigWin')
      }
      return haptic('tradeClose')

    case 'stopLoss':
      return haptic('stopLoss')

    case 'takeProfit':
      return haptic('success')

    default:
      return haptic('light')
  }
}

/**
 * Haptic feedback for button interactions
 */
export function hapticButton(type: 'primary' | 'secondary' | 'danger' = 'primary'): boolean {
  switch (type) {
    case 'primary':
      return haptic('medium')
    case 'secondary':
      return haptic('light')
    case 'danger':
      return haptic('warning')
    default:
      return haptic('light')
  }
}
