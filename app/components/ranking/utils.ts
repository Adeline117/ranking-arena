import { tokens } from '@/lib/design-tokens'

/**
 * 格式化 PnL 显示
 */
export function formatPnL(pnl: number): string {
  const absPnL = Math.abs(pnl)
  if (absPnL >= 1000000) {
    return `$${(pnl / 1000000).toFixed(2)}M`
  } else if (absPnL >= 1000) {
    return `$${(pnl / 1000).toFixed(2)}K`
  } else {
    return `$${pnl.toFixed(2)}`
  }
}

/**
 * 格式化 ROI 显示（处理极端值）
 */
export function formatROI(roi: number): string {
  const absRoi = Math.abs(roi)
  if (absRoi >= 10000) {
    return `${roi >= 0 ? '+' : ''}${(roi / 1000).toFixed(0)}K%`
  } else if (absRoi >= 1000) {
    return `${roi >= 0 ? '+' : ''}${roi.toFixed(0)}%`
  } else {
    return `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`
  }
}

/**
 * 获取 PnL 数据来源提示
 * 不同交易所的 PnL 含义不同：
 * - Binance: 交易员本人盈亏
 * - Bybit/Bitget/KuCoin/MEXC: 跟单者收益（非交易员本人）
 */
export function getPnLTooltip(source: string, language: string): string {
  const traderPnlSources = ['binance', 'binance_futures', 'binance_spot', 'binance_web3']
  const followerPnlSources = ['bybit', 'bitget', 'bitget_futures', 'bitget_spot', 'kucoin', 'mexc', 'htx', 'htx_futures', 'weex']

  const sourceLower = source.toLowerCase()

  if (traderPnlSources.some(s => sourceLower.includes(s))) {
    return language === 'zh'
      ? 'PnL = 交易员本人盈亏'
      : 'PnL = Trader\'s own profit/loss'
  }

  if (followerPnlSources.some(s => sourceLower.includes(s))) {
    return language === 'zh'
      ? 'PnL = 跟单者收益（非交易员本人）'
      : 'PnL = Followers\' profit (not trader\'s own)'
  }

  return language === 'zh' ? 'PnL = 盈亏金额' : 'PnL = Profit/Loss'
}

export type SourceInfo = { exchange: string; type: string; typeColor: string }

/**
 * 解析 source 为交易所名称和类型
 */
export function parseSourceInfo(src: string, t: (key: string) => string): SourceInfo {
  // 交易所名称映射
  const exchangeMap: Record<string, string> = {
    'binance': 'Binance',
    'bybit': 'Bybit',
    'bitget': 'Bitget',
    'mexc': 'MEXC',
    'htx': 'HTX',
    'weex': 'Weex',
    'coinex': 'CoinEx',
    'okx': 'OKX',
    'kucoin': 'KuCoin',
    'gmx': 'GMX',
  }

  // 类型映射 - 统一颜色，不做颜色区分
  const typeMap: Record<string, { label: string; color: string }> = {
    'futures': { label: t('categoryFutures'), color: tokens.colors.text.secondary },
    'spot': { label: t('categorySpot'), color: tokens.colors.text.secondary },
    'web3': { label: t('categoryWeb3'), color: tokens.colors.text.secondary },
  }

  // 解析 source 字符串
  const parts = src.toLowerCase().split('_')
  const exchange = parts[0]
  let type = parts[1] || 'futures' // 默认合约

  // 特殊处理
  if (src === 'bybit') type = 'futures'
  if (src === 'gmx') type = 'web3'
  if (src === 'mexc' || src === 'coinex' || src === 'kucoin' || src === 'htx' || src === 'weex') type = 'futures'

  const exchangeName = exchangeMap[exchange] || exchange.charAt(0).toUpperCase() + exchange.slice(1)
  const typeInfo = typeMap[type] || { label: type, color: tokens.colors.text.tertiary }

  return {
    exchange: exchangeName,
    type: typeInfo.label,
    typeColor: typeInfo.color,
  }
}

/**
 * Format display name - truncate wallet addresses
 */
export function formatDisplayName(name: string): string {
  if (name.startsWith('0x') && name.length > 20) {
    return `${name.substring(0, 6)}...${name.substring(name.length - 4)}`
  }
  return name
}

/**
 * Get medal glow CSS class based on rank
 */
export function getMedalGlowClass(rank: number): string {
  if (rank === 1) return 'medal-glow-gold'
  if (rank === 2) return 'medal-glow-silver'
  if (rank === 3) return 'medal-glow-bronze'
  return ''
}
