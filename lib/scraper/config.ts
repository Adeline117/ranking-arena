/**
 * 统一抓取系统配置
 * 集中管理所有平台的抓取参数、重试策略、超时设置
 */

export interface PlatformConfig {
  /** 平台标识 */
  id: string
  /** 显示名称 */
  name: string
  /** 平台类型 */
  type: 'cex' | 'dex'
  /** 是否启用 */
  enabled: boolean
  /** 支持的时间窗口 */
  timeWindows: string[]
  /** 抓取优先级 (1-10, 1 最高) */
  priority: number
  /** 抓取配置 */
  scrape: {
    /** 抓取方法: api (直接 API), browser (浏览器), hybrid (混合) */
    method: 'api' | 'browser' | 'hybrid'
    /** 请求超时 (ms) */
    timeout: number
    /** 请求间隔 (ms) */
    requestDelay: number
    /** 最大并发数 */
    concurrency: number
    /** 是否需要代理 */
    requiresProxy: boolean
    /** 代理区域偏好 */
    proxyRegions?: string[]
  }
  /** 重试配置 */
  retry: {
    /** 最大重试次数 */
    maxRetries: number
    /** 初始延迟 (ms) */
    initialDelay: number
    /** 最大延迟 (ms) */
    maxDelay: number
    /** 退避倍数 */
    backoffMultiplier: number
  }
  /** 熔断器配置 */
  circuitBreaker: {
    /** 触发熔断的失败次数 */
    failureThreshold: number
    /** 恢复所需成功次数 */
    successThreshold: number
    /** 熔断持续时间 (ms) */
    timeout: number
  }
  /** 数据验证配置 */
  validation: {
    /** 最少交易员数量 */
    minTraderCount: number
    /** TOP1 最小 ROI */
    minTop1Roi: number
    /** 最大重复率 */
    maxDuplicateRate: number
  }
  /** 刷新频率配置 */
  refreshSchedule: {
    /** 热门交易员 (Top 100) 刷新间隔 (分钟) */
    hotInterval: number
    /** 活跃交易员刷新间隔 (分钟) */
    activeInterval: number
    /** 普通交易员刷新间隔 (分钟) */
    normalInterval: number
    /** 不活跃交易员刷新间隔 (分钟) */
    dormantInterval: number
  }
}

// ============================================
// 默认配置
// ============================================

const DEFAULT_CEX_CONFIG: Omit<PlatformConfig, 'id' | 'name' | 'type' | 'enabled' | 'timeWindows' | 'priority'> = {
  scrape: {
    method: 'api',
    timeout: 30000,
    requestDelay: 1000,
    concurrency: 5,
    requiresProxy: false,
  },
  retry: {
    maxRetries: 3,
    initialDelay: 1000,
    maxDelay: 10000,
    backoffMultiplier: 2,
  },
  circuitBreaker: {
    failureThreshold: 3,
    successThreshold: 1,
    timeout: 300000, // 5 分钟
  },
  validation: {
    minTraderCount: 50,
    minTop1Roi: 10,
    maxDuplicateRate: 0.1,
  },
  refreshSchedule: {
    hotInterval: 15,
    activeInterval: 60,
    normalInterval: 240,
    dormantInterval: 1440,
  },
}

const DEFAULT_DEX_CONFIG: Omit<PlatformConfig, 'id' | 'name' | 'type' | 'enabled' | 'timeWindows' | 'priority'> = {
  ...DEFAULT_CEX_CONFIG,
  scrape: {
    ...DEFAULT_CEX_CONFIG.scrape,
    method: 'api',
    timeout: 60000,
    requestDelay: 2000,
    concurrency: 3,
  },
  validation: {
    ...DEFAULT_CEX_CONFIG.validation,
    minTraderCount: 30,
  },
}

// ============================================
// 平台配置
// ============================================

export const PLATFORM_CONFIGS: Record<string, PlatformConfig> = {
  // CEX 平台
  binance_futures: {
    id: 'binance_futures',
    name: 'Binance Futures',
    type: 'cex',
    enabled: true,
    timeWindows: ['7D', '30D', '90D'],
    priority: 1,
    ...DEFAULT_CEX_CONFIG,
    scrape: {
      ...DEFAULT_CEX_CONFIG.scrape,
      requiresProxy: true,
      proxyRegions: ['SG', 'JP', 'HK'],
    },
    validation: {
      minTraderCount: 100,
      minTop1Roi: 50,
      maxDuplicateRate: 0.05,
    },
  },
  binance_spot: {
    id: 'binance_spot',
    name: 'Binance Spot',
    type: 'cex',
    enabled: true,
    timeWindows: ['7D', '30D', '90D'],
    priority: 2,
    ...DEFAULT_CEX_CONFIG,
    scrape: {
      ...DEFAULT_CEX_CONFIG.scrape,
      requiresProxy: true,
      proxyRegions: ['SG', 'JP', 'HK'],
    },
  },
  binance_web3: {
    id: 'binance_web3',
    name: 'Binance Web3',
    type: 'cex',
    enabled: true,
    timeWindows: ['7D', '30D', '90D'],
    priority: 3,
    ...DEFAULT_CEX_CONFIG,
  },
  bybit: {
    id: 'bybit',
    name: 'Bybit',
    type: 'cex',
    enabled: true,
    timeWindows: ['7D', '30D', '90D'],
    priority: 1,
    ...DEFAULT_CEX_CONFIG,
  },
  bybit_spot: {
    id: 'bybit_spot',
    name: 'Bybit Spot',
    type: 'cex',
    enabled: true,
    timeWindows: ['7D', '30D', '90D'],
    priority: 2,
    ...DEFAULT_CEX_CONFIG,
  },
  bitget_futures: {
    id: 'bitget_futures',
    name: 'Bitget Futures',
    type: 'cex',
    enabled: true,
    timeWindows: ['7D', '30D', '90D'],
    priority: 2,
    ...DEFAULT_CEX_CONFIG,
  },
  bitget_spot: {
    id: 'bitget_spot',
    name: 'Bitget Spot',
    type: 'cex',
    enabled: true,
    timeWindows: ['7D', '30D', '90D'],
    priority: 3,
    ...DEFAULT_CEX_CONFIG,
  },
  okx_futures: {
    id: 'okx_futures',
    name: 'OKX Futures',
    type: 'cex',
    enabled: true,
    timeWindows: ['7D', '30D', '90D'],
    priority: 2,
    ...DEFAULT_CEX_CONFIG,
    scrape: {
      ...DEFAULT_CEX_CONFIG.scrape,
      method: 'browser',
      timeout: 60000,
    },
  },
  okx_web3: {
    id: 'okx_web3',
    name: 'OKX Web3',
    type: 'cex',
    enabled: true,
    timeWindows: ['7D', '30D', '90D'],
    priority: 3,
    ...DEFAULT_CEX_CONFIG,
  },
  mexc: {
    id: 'mexc',
    name: 'MEXC',
    type: 'cex',
    enabled: true,
    timeWindows: ['7D', '30D', '90D'],
    priority: 3,
    ...DEFAULT_CEX_CONFIG,
  },
  kucoin: {
    id: 'kucoin',
    name: 'KuCoin',
    type: 'cex',
    enabled: true,
    timeWindows: ['7D', '30D', '90D'],
    priority: 3,
    ...DEFAULT_CEX_CONFIG,
  },
  coinex: {
    id: 'coinex',
    name: 'CoinEx',
    type: 'cex',
    enabled: true,
    timeWindows: ['7D', '30D', '90D'],
    priority: 4,
    ...DEFAULT_CEX_CONFIG,
    validation: {
      ...DEFAULT_CEX_CONFIG.validation,
      minTraderCount: 30,
    },
  },
  htx: {
    id: 'htx',
    name: 'HTX',
    type: 'cex',
    enabled: true,
    timeWindows: ['7D', '30D', '90D'],
    priority: 3,
    ...DEFAULT_CEX_CONFIG,
  },
  gateio: {
    id: 'gateio',
    name: 'Gate.io',
    type: 'cex',
    enabled: true,
    timeWindows: ['7D', '30D', '90D'],
    priority: 3,
    ...DEFAULT_CEX_CONFIG,
  },
  phemex: {
    id: 'phemex',
    name: 'Phemex',
    type: 'cex',
    enabled: true,
    timeWindows: ['7D', '30D', '90D'],
    priority: 4,
    ...DEFAULT_CEX_CONFIG,
  },
  bingx: {
    id: 'bingx',
    name: 'BingX',
    type: 'cex',
    enabled: true,
    timeWindows: ['7D', '30D', '90D'],
    priority: 4,
    ...DEFAULT_CEX_CONFIG,
  },
  xt: {
    id: 'xt',
    name: 'XT.com',
    type: 'cex',
    enabled: true,
    timeWindows: ['7D', '30D', '90D'],
    priority: 5,
    ...DEFAULT_CEX_CONFIG,
  },
  pionex: {
    id: 'pionex',
    name: 'Pionex',
    type: 'cex',
    enabled: true,
    timeWindows: ['7D', '30D', '90D'],
    priority: 5,
    ...DEFAULT_CEX_CONFIG,
  },
  weex: {
    id: 'weex',
    name: 'Weex',
    type: 'cex',
    enabled: true,
    timeWindows: ['7D', '30D', '90D'],
    priority: 5,
    ...DEFAULT_CEX_CONFIG,
  },
  lbank: {
    id: 'lbank',
    name: 'LBank',
    type: 'cex',
    enabled: true,
    timeWindows: ['7D', '30D', '90D'],
    priority: 5,
    ...DEFAULT_CEX_CONFIG,
  },
  blofin: {
    id: 'blofin',
    name: 'BloFin',
    type: 'cex',
    enabled: true,
    timeWindows: ['7D', '30D', '90D'],
    priority: 5,
    ...DEFAULT_CEX_CONFIG,
  },

  // DEX 平台
  gmx: {
    id: 'gmx',
    name: 'GMX',
    type: 'dex',
    enabled: true,
    timeWindows: ['7D', '30D'],
    priority: 2,
    ...DEFAULT_DEX_CONFIG,
  },
  kwenta: {
    id: 'kwenta',
    name: 'Kwenta',
    type: 'dex',
    enabled: true,
    timeWindows: ['7D', '30D', '90D'],
    priority: 3,
    ...DEFAULT_DEX_CONFIG,
  },
  gains: {
    id: 'gains',
    name: 'Gains Network',
    type: 'dex',
    enabled: true,
    timeWindows: ['7D', '30D', '90D'],
    priority: 3,
    ...DEFAULT_DEX_CONFIG,
  },
  mux: {
    id: 'mux',
    name: 'MUX Protocol',
    type: 'dex',
    enabled: true,
    timeWindows: ['7D', '30D', '90D'],
    priority: 4,
    ...DEFAULT_DEX_CONFIG,
  },
}

// ============================================
// 工具函数
// ============================================

/**
 * 获取平台配置
 */
export function getPlatformConfig(platformId: string): PlatformConfig | undefined {
  return PLATFORM_CONFIGS[platformId]
}

/**
 * 获取所有启用的平台
 */
export function getEnabledPlatforms(): PlatformConfig[] {
  return Object.values(PLATFORM_CONFIGS).filter(p => p.enabled)
}

/**
 * 按优先级排序的平台列表
 */
export function getPlatformsByPriority(): PlatformConfig[] {
  return getEnabledPlatforms().sort((a, b) => a.priority - b.priority)
}

/**
 * 获取 CEX 平台
 */
export function getCexPlatforms(): PlatformConfig[] {
  return getEnabledPlatforms().filter(p => p.type === 'cex')
}

/**
 * 获取 DEX 平台
 */
export function getDexPlatforms(): PlatformConfig[] {
  return getEnabledPlatforms().filter(p => p.type === 'dex')
}

/**
 * 获取需要代理的平台
 */
export function getProxyRequiredPlatforms(): PlatformConfig[] {
  return getEnabledPlatforms().filter(p => p.scrape.requiresProxy)
}

/**
 * 计算交易员刷新间隔
 */
export function getRefreshInterval(
  platformId: string,
  tier: 'hot' | 'active' | 'normal' | 'dormant'
): number {
  const config = getPlatformConfig(platformId)
  if (!config) return 240 // 默认 4 小时

  const intervals = config.refreshSchedule
  switch (tier) {
    case 'hot':
      return intervals.hotInterval
    case 'active':
      return intervals.activeInterval
    case 'normal':
      return intervals.normalInterval
    case 'dormant':
      return intervals.dormantInterval
    default:
      return intervals.normalInterval
  }
}
