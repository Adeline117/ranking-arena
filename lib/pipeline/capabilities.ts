/**
 * Arena Data Pipeline - Platform Capabilities
 *
 * 每个平台的能力声明，用于标准化层判断如何处理数据
 */

import { PlatformCapabilities } from './types'

// =============================================================================
// CEX Futures Platforms
// =============================================================================

const BINANCE_FUTURES: PlatformCapabilities = {
  supported_windows: ['7d', '30d', '90d', 'all_time'],
  fields: {
    roi: true,
    pnl: true,
    win_rate: true,
    max_drawdown: true,
    followers: true,
    copiers: true,
    aum: true,
    trades_count: true,
    equity_curve: true,
    position_history: true,
  },
  api: {
    rate_limit_rpm: 20,
    timeout_ms: 15000,
    requires_auth: false,
    geo_restricted: true,
    proxy_required: true,
  },
  format: {
    roi_format: 'percentage',
    pnl_unit: 'usd',
  },
}

const OKX_FUTURES: PlatformCapabilities = {
  supported_windows: ['7d', '30d', '90d'],
  fields: {
    roi: true,
    pnl: true,
    win_rate: true,
    max_drawdown: true,
    followers: true,
    copiers: true,
    aum: true,
    trades_count: true,
    equity_curve: true,
    position_history: true,
  },
  api: {
    rate_limit_rpm: 20,
    timeout_ms: 15000,
    requires_auth: false,
    geo_restricted: true,
    proxy_required: true,
  },
  format: {
    roi_format: 'percentage',
    pnl_unit: 'usd',
  },
}

const BYBIT: PlatformCapabilities = {
  supported_windows: ['7d', '30d', '90d'],
  fields: {
    roi: true,
    pnl: true,
    win_rate: true,
    max_drawdown: true,
    followers: true,
    copiers: true,
    aum: true,
    trades_count: true,
    equity_curve: true,
    position_history: true,
  },
  api: {
    rate_limit_rpm: 15,
    timeout_ms: 20000,
    requires_auth: false,
    geo_restricted: true,
    proxy_required: true, // Uses VPS scraper
  },
  format: {
    roi_format: 'percentage',
    pnl_unit: 'usd',
  },
}

const BITGET: PlatformCapabilities = {
  supported_windows: ['7d', '30d', '90d'],
  fields: {
    roi: true,
    pnl: true,
    win_rate: true,
    max_drawdown: true,
    followers: true,
    copiers: true,
    aum: false,
    trades_count: true,
    equity_curve: true,
    position_history: true,
  },
  api: {
    rate_limit_rpm: 20,
    timeout_ms: 15000,
    requires_auth: false,
    geo_restricted: false,
    proxy_required: false,
  },
  format: {
    roi_format: 'percentage',
    pnl_unit: 'usd',
  },
}

const MEXC: PlatformCapabilities = {
  supported_windows: ['7d', '30d', '90d'],
  fields: {
    roi: true,
    pnl: true,
    win_rate: true,
    max_drawdown: false,
    followers: true,
    copiers: true,
    aum: false,
    trades_count: true,
    equity_curve: false,
    position_history: false,
  },
  api: {
    rate_limit_rpm: 30,
    timeout_ms: 15000,
    requires_auth: false,
    geo_restricted: false,
    proxy_required: false,
  },
  format: {
    roi_format: 'percentage',
    pnl_unit: 'usd',
  },
}

const HTX_FUTURES: PlatformCapabilities = {
  supported_windows: ['7d', '30d', '90d'],
  fields: {
    roi: true,
    pnl: true,
    win_rate: true,
    max_drawdown: false,
    followers: true,
    copiers: true,
    aum: false,
    trades_count: true,
    equity_curve: false,
    position_history: false,
  },
  api: {
    rate_limit_rpm: 20,
    timeout_ms: 15000,
    requires_auth: false,
    geo_restricted: false,
    proxy_required: false,
  },
  format: {
    roi_format: 'percentage',
    pnl_unit: 'usd',
  },
}

const COINEX: PlatformCapabilities = {
  supported_windows: ['7d', '30d', '90d'],
  fields: {
    roi: true,
    pnl: true,
    win_rate: true,
    max_drawdown: false,
    followers: true,
    copiers: true,
    aum: false,
    trades_count: true,
    equity_curve: false,
    position_history: false,
  },
  api: {
    rate_limit_rpm: 30,
    timeout_ms: 15000,
    requires_auth: false,
    geo_restricted: false,
    proxy_required: false,
  },
  format: {
    roi_format: 'percentage',
    pnl_unit: 'usd',
  },
}

const GATEIO: PlatformCapabilities = {
  supported_windows: ['7d', '30d', '90d'],
  fields: {
    roi: true,
    pnl: true,
    win_rate: true,
    max_drawdown: false,
    followers: true,
    copiers: true,
    aum: false,
    trades_count: true,
    equity_curve: false,
    position_history: false,
  },
  api: {
    rate_limit_rpm: 30,
    timeout_ms: 15000,
    requires_auth: false,
    geo_restricted: false,
    proxy_required: false,
  },
  format: {
    roi_format: 'percentage',
    pnl_unit: 'usd',
  },
}

const BITUNIX: PlatformCapabilities = {
  supported_windows: ['7d', '30d', '90d'],
  fields: {
    roi: true,
    pnl: true,
    win_rate: true,
    max_drawdown: true,
    followers: true,
    copiers: true,
    aum: true,
    trades_count: true,
    equity_curve: true,
    position_history: true,
  },
  api: {
    rate_limit_rpm: 60, // batch-cached, no per-trader calls
    timeout_ms: 15000,
    requires_auth: false,
    geo_restricted: false,
    proxy_required: false,
  },
  format: {
    roi_format: 'percentage',
    pnl_unit: 'usd',
  },
}

// =============================================================================
// DEX / Perp Platforms
// =============================================================================

const HYPERLIQUID: PlatformCapabilities = {
  supported_windows: ['7d', '30d', 'all_time'], // no native 90d
  fields: {
    roi: true,
    pnl: true,
    win_rate: true,
    max_drawdown: true,
    followers: false,
    copiers: false,
    aum: false,
    trades_count: true,
    equity_curve: true,
    position_history: true,
  },
  api: {
    rate_limit_rpm: 60,
    timeout_ms: 15000,
    requires_auth: false,
    geo_restricted: false,
    proxy_required: false,
  },
  format: {
    roi_format: 'needs_detection', // 有时小数，有时百分比
    pnl_unit: 'usd',
  },
}

const GMX: PlatformCapabilities = {
  supported_windows: ['all_time'], // only all_time from subgraph
  fields: {
    roi: false, // needs computation from pnl/capital
    pnl: true,
    win_rate: true,
    max_drawdown: false,
    followers: false,
    copiers: false,
    aum: false,
    trades_count: true,
    equity_curve: false,
    position_history: true,
  },
  api: {
    rate_limit_rpm: 30,
    timeout_ms: 30000,
    requires_auth: false,
    geo_restricted: false,
    proxy_required: false,
  },
  format: {
    roi_format: 'percentage', // computed
    pnl_unit: 'wei',
    pnl_decimals: 30, // GMX v2 uses 30 decimals
  },
}

const DYDX: PlatformCapabilities = {
  supported_windows: ['7d', '30d', 'all_time'],
  fields: {
    roi: true,
    pnl: true,
    win_rate: true,
    max_drawdown: false,
    followers: false,
    copiers: false,
    aum: false,
    trades_count: true,
    equity_curve: true,
    position_history: true,
  },
  api: {
    rate_limit_rpm: 30,
    timeout_ms: 20000,
    requires_auth: false,
    geo_restricted: false,
    proxy_required: false,
  },
  format: {
    roi_format: 'percentage',
    pnl_unit: 'usd',
  },
}

const DRIFT: PlatformCapabilities = {
  supported_windows: ['7d', '30d', 'all_time'],
  fields: {
    roi: true,
    pnl: true,
    win_rate: true,
    max_drawdown: false,
    followers: false,
    copiers: false,
    aum: false,
    trades_count: true,
    equity_curve: true,
    position_history: true,
  },
  api: {
    rate_limit_rpm: 30,
    timeout_ms: 20000,
    requires_auth: false,
    geo_restricted: false,
    proxy_required: false,
  },
  format: {
    roi_format: 'decimal', // returns 0.25 for 25%
    pnl_unit: 'usd',
  },
}

const AEVO: PlatformCapabilities = {
  supported_windows: ['7d', '30d', 'all_time'],
  fields: {
    roi: true,
    pnl: true,
    win_rate: true,
    max_drawdown: false,
    followers: false,
    copiers: false,
    aum: false,
    trades_count: true,
    equity_curve: true,
    position_history: false,
  },
  api: {
    rate_limit_rpm: 30,
    timeout_ms: 15000,
    requires_auth: false,
    geo_restricted: false,
    proxy_required: false,
  },
  format: {
    roi_format: 'percentage',
    pnl_unit: 'usd',
  },
}

const GAINS: PlatformCapabilities = {
  supported_windows: ['all_time'],
  fields: {
    roi: false,
    pnl: true,
    win_rate: true,
    max_drawdown: false,
    followers: false,
    copiers: false,
    aum: false,
    trades_count: true,
    equity_curve: false,
    position_history: true,
  },
  api: {
    rate_limit_rpm: 30,
    timeout_ms: 30000,
    requires_auth: false,
    geo_restricted: false,
    proxy_required: false,
  },
  format: {
    roi_format: 'percentage',
    pnl_unit: 'wei',
    pnl_decimals: 18,
  },
}

const JUPITER_PERPS: PlatformCapabilities = {
  supported_windows: ['7d', '30d', 'all_time'],
  fields: {
    roi: true,
    pnl: true,
    win_rate: true,
    max_drawdown: false,
    followers: false,
    copiers: false,
    aum: false,
    trades_count: true,
    equity_curve: false,
    position_history: true,
  },
  api: {
    rate_limit_rpm: 30,
    timeout_ms: 20000,
    requires_auth: false,
    geo_restricted: false,
    proxy_required: false,
  },
  format: {
    roi_format: 'percentage',
    pnl_unit: 'usd',
  },
}

const KWENTA: PlatformCapabilities = {
  supported_windows: ['all_time'],
  fields: {
    roi: false,
    pnl: true,
    win_rate: true,
    max_drawdown: false,
    followers: false,
    copiers: false,
    aum: false,
    trades_count: true,
    equity_curve: false,
    position_history: true,
  },
  api: {
    rate_limit_rpm: 30,
    timeout_ms: 30000,
    requires_auth: false,
    geo_restricted: false,
    proxy_required: false,
  },
  format: {
    roi_format: 'percentage',
    pnl_unit: 'wei',
    pnl_decimals: 18,
  },
}

// =============================================================================
// CEX Spot Platforms
// =============================================================================

const BINANCE_SPOT: PlatformCapabilities = {
  supported_windows: ['7d', '30d', '90d'],
  fields: {
    roi: true,
    pnl: true,
    win_rate: true,
    max_drawdown: false,
    followers: true,
    copiers: true,
    aum: true,
    trades_count: true,
    equity_curve: true,
    position_history: false,
  },
  api: {
    rate_limit_rpm: 20,
    timeout_ms: 15000,
    requires_auth: false,
    geo_restricted: true,
    proxy_required: true,
  },
  format: {
    roi_format: 'percentage',
    pnl_unit: 'usd',
  },
}

const OKX_SPOT: PlatformCapabilities = {
  supported_windows: ['7d', '30d', '90d'],
  fields: {
    roi: true,
    pnl: true,
    win_rate: true,
    max_drawdown: false,
    followers: true,
    copiers: true,
    aum: true,
    trades_count: true,
    equity_curve: true,
    position_history: false,
  },
  api: {
    rate_limit_rpm: 20,
    timeout_ms: 15000,
    requires_auth: false,
    geo_restricted: true,
    proxy_required: true,
  },
  format: {
    roi_format: 'percentage',
    pnl_unit: 'usd',
  },
}

// =============================================================================
// Other Platforms
// =============================================================================

const ETORO: PlatformCapabilities = {
  supported_windows: ['7d', '30d', '90d'],
  fields: {
    roi: true,
    pnl: false,
    win_rate: true,
    max_drawdown: true,
    followers: true,
    copiers: true,
    aum: true,
    trades_count: true,
    equity_curve: true,
    position_history: false,
  },
  api: {
    rate_limit_rpm: 10,
    timeout_ms: 20000,
    requires_auth: false,
    geo_restricted: false,
    proxy_required: false,
  },
  format: {
    roi_format: 'percentage',
    pnl_unit: 'usd',
  },
}

const POLYMARKET: PlatformCapabilities = {
  supported_windows: ['7d', '30d', 'all_time'],
  fields: {
    roi: true,
    pnl: true,
    win_rate: true,
    max_drawdown: false,
    followers: false,
    copiers: false,
    aum: false,
    trades_count: true,
    equity_curve: false,
    position_history: true,
  },
  api: {
    rate_limit_rpm: 30,
    timeout_ms: 15000,
    requires_auth: false,
    geo_restricted: false,
    proxy_required: false,
  },
  format: {
    roi_format: 'percentage',
    pnl_unit: 'usd',
  },
}

// =============================================================================
// Capabilities Registry
// =============================================================================

export const PLATFORM_CAPABILITIES: Record<string, PlatformCapabilities> = {
  // CEX Futures
  binance_futures: BINANCE_FUTURES,
  okx_futures: OKX_FUTURES,
  bybit: BYBIT,
  bitget: BITGET,
  mexc: MEXC,
  htx_futures: HTX_FUTURES,
  coinex: COINEX,
  gateio: GATEIO,
  bitunix: BITUNIX,

  // DEX / Perp
  hyperliquid: HYPERLIQUID,
  gmx: GMX,
  dydx: DYDX,
  drift: DRIFT,
  aevo: AEVO,
  gains: GAINS,
  jupiter_perps: JUPITER_PERPS,
  kwenta: KWENTA,

  // CEX Spot
  binance_spot: BINANCE_SPOT,
  okx_spot: OKX_SPOT,

  // Other
  etoro: ETORO,
  polymarket: POLYMARKET,
}

/**
 * 获取平台能力，如果不存在返回默认值
 */
export function getPlatformCapabilities(platform: string): PlatformCapabilities {
  const caps = PLATFORM_CAPABILITIES[platform]
  if (caps) return caps

  // 返回保守的默认配置
  return {
    supported_windows: ['7d', '30d', '90d'],
    fields: {
      roi: true,
      pnl: true,
      win_rate: false,
      max_drawdown: false,
      followers: false,
      copiers: false,
      aum: false,
      trades_count: false,
      equity_curve: false,
      position_history: false,
    },
    api: {
      rate_limit_rpm: 20,
      timeout_ms: 30000,
      requires_auth: false,
      geo_restricted: false,
      proxy_required: false,
    },
    format: {
      roi_format: 'percentage',
      pnl_unit: 'usd',
    },
  }
}

/**
 * 判断平台是否为 DEX
 */
export function isDexPlatform(platform: string): boolean {
  const dexPlatforms = [
    'hyperliquid',
    'gmx',
    'dydx',
    'drift',
    'aevo',
    'gains',
    'jupiter_perps',
    'kwenta',
  ]
  return dexPlatforms.includes(platform)
}

/**
 * 判断平台是否需要代理
 */
export function requiresProxy(platform: string): boolean {
  const caps = getPlatformCapabilities(platform)
  return caps.api.proxy_required
}

/**
 * 获取平台支持的时间窗口
 */
export function getSupportedWindows(
  platform: string
): ('7d' | '30d' | '90d' | 'all_time')[] {
  const caps = getPlatformCapabilities(platform)
  return caps.supported_windows
}
