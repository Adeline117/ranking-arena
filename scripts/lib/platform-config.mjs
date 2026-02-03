/**
 * 平台配置 - 统一所有交易所的抓取配置
 *
 * 每个平台定义：
 * - source: 数据源标识
 * - name: 显示名称
 * - type: 抓取类型 (api | puppeteer | playwright)
 * - url: 排行榜页面 URL
 * - api: API 配置（如果使用 API 抓取）
 * - selectors: 页面选择器（如果使用浏览器抓取）
 * - extractors: 数据提取函数
 */

export const PLATFORM_CONFIGS = {
  // ============== CEX 合约 ==============
  binance_futures: {
    source: 'binance_futures',
    name: 'Binance Futures',
    type: 'api',
    marketType: 'futures',
    targetCount: 500,
    api: {
      base: 'https://www.binance.com',
      list: '/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list',
      detail: '/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Origin': 'https://www.binance.com',
        'Referer': 'https://www.binance.com/zh-CN/copy-trading',
      },
      periodMap: { '7D': '7D', '30D': '30D', '90D': '90D' },
    },
    extractors: {
      traderId: (item) => item.leadPortfolioId || item.encryptedUid,
      nickname: (item) => item.nickName || item.displayName,
      avatar: (item) => item.userPhotoUrl,
      roi: (item) => parseFloat(item.roi || 0),
      pnl: (item) => parseFloat(item.pnl || 0),
      winRate: (item) => parseFloat(item.winRate || 0),
      maxDrawdown: (item) => Math.abs(parseFloat(item.mdd || 0)),
      followers: (item) => parseInt(item.copierNum || 0),
    },
  },

  bybit: {
    source: 'bybit',
    name: 'Bybit',
    type: 'puppeteer',
    marketType: 'futures',
    targetCount: 500,
    url: 'https://www.bybit.com/copyTrade/',
    apiPatterns: ['leaderBoard', 'leader', 'rank'],
    extractors: {
      traderId: (item) => item.leaderId || item.traderUid || item.uid,
      nickname: (item) => item.nickName || item.leaderName,
      avatar: (item) => item.avatar || item.avatarUrl,
      roi: (item) => {
        const roi = parseFloat(item.roi || item.roiRate || 0)
        return roi > 10 ? roi : roi * 100
      },
      pnl: (item) => parseFloat(item.pnl || item.totalPnl || 0),
      winRate: (item) => parseFloat(item.winRate || 0),
      maxDrawdown: (item) => parseFloat(item.mdd || item.maxDrawdown || 0),
      followers: (item) => parseInt(item.followerCount || item.copierNum || 0),
    },
  },

  bitget_futures: {
    source: 'bitget_futures',
    name: 'Bitget Futures',
    type: 'api',
    marketType: 'futures',
    targetCount: 500,
    api: {
      base: 'https://www.bitget.com',
      list: '/v1/copy-trade/mix/trader/list',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      periodMap: { '7D': 'SEVEN_DAYS', '30D': 'ONE_MONTH', '90D': 'THREE_MONTHS' },
    },
    extractors: {
      traderId: (item) => item.traderId || item.traderUid,
      nickname: (item) => item.traderName || item.nickName,
      avatar: (item) => item.traderIcon || item.avatar,
      roi: (item) => parseFloat(item.yieldRate || item.roi || 0) * 100,
      pnl: (item) => parseFloat(item.totalProfit || item.pnl || 0),
      winRate: (item) => parseFloat(item.winRate || 0) * 100,
      maxDrawdown: (item) => Math.abs(parseFloat(item.maxDrawDown || 0)) * 100,
      followers: (item) => parseInt(item.followerCount || 0),
    },
  },

  okx_futures: {
    source: 'okx_futures',
    name: 'OKX Futures',
    type: 'api',
    marketType: 'futures',
    targetCount: 500,
    api: {
      base: 'https://www.okx.com',
      list: '/api/v5/copytrading/public-lead-traders',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      periodMap: { '7D': '7d', '30D': '30d', '90D': '90d' },
    },
    extractors: {
      traderId: (item) => item.visibleUid || item.uniqueCode,
      nickname: (item) => item.nickName || item.traderName,
      avatar: (item) => item.portrait,
      roi: (item) => parseFloat(item.pnlRatio || 0) * 100,
      pnl: (item) => parseFloat(item.pnl || 0),
      winRate: (item) => parseFloat(item.winRatio || 0) * 100,
      maxDrawdown: (item) => Math.abs(parseFloat(item.maxDrawdown || 0)) * 100,
      followers: (item) => parseInt(item.copyTraderNum || 0),
    },
  },

  mexc: {
    source: 'mexc',
    name: 'MEXC',
    type: 'api',
    marketType: 'futures',
    targetCount: 300,
    api: {
      base: 'https://www.mexc.com',
      list: '/api/platform/futures/copy/leader/list',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    },
    extractors: {
      traderId: (item) => item.leaderId || item.uid,
      nickname: (item) => item.nickName,
      avatar: (item) => item.avatar,
      roi: (item) => parseFloat(item.roi || 0),
      pnl: (item) => parseFloat(item.totalPnl || 0),
      winRate: (item) => parseFloat(item.winRate || 0),
      maxDrawdown: (item) => parseFloat(item.maxDrawdown || 0),
      followers: (item) => parseInt(item.followers || 0),
    },
  },

  kucoin: {
    source: 'kucoin',
    name: 'KuCoin',
    type: 'puppeteer',
    marketType: 'futures',
    targetCount: 300,
    url: 'https://www.kucoin.com/copy-trading',
    apiPatterns: ['copyTrade', 'trader', 'rank'],
  },

  // ============== CEX 现货 ==============
  binance_spot: {
    source: 'binance_spot',
    name: 'Binance Spot',
    type: 'api',
    marketType: 'spot',
    targetCount: 500,
    api: {
      base: 'https://www.binance.com',
      list: '/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    },
  },

  bitget_spot: {
    source: 'bitget_spot',
    name: 'Bitget Spot',
    type: 'api',
    marketType: 'spot',
    targetCount: 300,
    api: {
      base: 'https://www.bitget.com',
      list: '/v1/copy-trade/spot/trader/list',
    },
  },

  // ============== DEX / 链上 ==============
  gmx: {
    source: 'gmx',
    name: 'GMX',
    type: 'api',
    marketType: 'dex',
    targetCount: 200,
    api: {
      base: 'https://gmx.io',
      // GMX 使用 subgraph
    },
    extractors: {
      traderId: (item) => item.account || item.address,
      roi: (item) => parseFloat(item.pnlPercentage || 0),
      pnl: (item) => parseFloat(item.realizedPnl || 0) / 1e30,
    },
  },

  hyperliquid: {
    source: 'hyperliquid',
    name: 'Hyperliquid',
    type: 'api',
    marketType: 'dex',
    targetCount: 200,
    api: {
      base: 'https://api.hyperliquid.xyz',
      list: '/info',
    },
    extractors: {
      traderId: (item) => item.user || item.address,
      roi: (item) => parseFloat(item.allTimePnl || 0) / parseFloat(item.accountValue || 1) * 100,
      pnl: (item) => parseFloat(item.allTimePnl || 0),
    },
  },
}

/**
 * 获取平台配置
 */
export function getPlatformConfig(source) {
  return PLATFORM_CONFIGS[source] || null
}

/**
 * 获取所有平台
 */
export function getAllPlatforms() {
  return Object.keys(PLATFORM_CONFIGS)
}

/**
 * 按类型获取平台
 */
export function getPlatformsByType(type) {
  return Object.entries(PLATFORM_CONFIGS)
    .filter(([, config]) => config.type === type)
    .map(([key]) => key)
}

/**
 * 按市场类型获取平台
 */
export function getPlatformsByMarketType(marketType) {
  return Object.entries(PLATFORM_CONFIGS)
    .filter(([, config]) => config.marketType === marketType)
    .map(([key]) => key)
}
