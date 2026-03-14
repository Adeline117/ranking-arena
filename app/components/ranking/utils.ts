import { SOURCE_TYPE_MAP, EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { tokens } from '@/lib/design-tokens'
import { getLanguage, t } from '@/lib/i18n'

/**
 * 格式化 PnL 显示
 */
export function formatPnL(pnl: number): string {
  if (!isFinite(pnl) || isNaN(pnl)) return '$0'
  const absPnL = Math.abs(pnl)
  const sign = pnl >= 0 ? '+' : '-'
  const lang = getLanguage()
  
  if (absPnL >= 1000000) {
    const suffix = lang === 'zh' ? t('numberFormatMillion') : t('numberFormatMillion')
    return `${sign}$${(absPnL / 1000000).toFixed(2)}${suffix}`
  } else if (absPnL >= 1000) {
    const suffix = lang === 'zh' ? t('numberFormatThousand') : t('numberFormatThousand')
    return `${sign}$${(absPnL / 1000).toFixed(1)}${suffix}`
  } else {
    return `${sign}$${absPnL.toFixed(2)}`
  }
}

/**
 * 格式化 ROI 显示（处理极端值）
 */
export function formatROI(roi: number): string {
  if (!isFinite(roi) || isNaN(roi)) return '+0.00%'
  const absRoi = Math.abs(roi)
  const lang = getLanguage()
  
  if (absRoi >= 10000) {
    const suffix = lang === 'zh' ? t('numberFormatThousand') : t('numberFormatThousand')
    return `${roi >= 0 ? '+' : ''}${(roi / 1000).toFixed(1)}${suffix}%`
  } else if (absRoi >= 1000) {
    return `${roi >= 0 ? '+' : ''}${roi.toFixed(0)}%`
  } else if (absRoi >= 100) {
    return `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`
  } else {
    return `${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`
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
  // Use central SOURCE_TYPE_MAP as single source of truth
  const sourceTagColor = tokens.colors.text.tertiary
  const typeMap: Record<string, { label: string; color: string }> = {
    'futures': { label: t('categoryFutures'), color: sourceTagColor },
    'spot': { label: t('categorySpot'), color: sourceTagColor },
    'web3': { label: t('categoryWeb3'), color: sourceTagColor },
  }

  const sourceLower = src.toLowerCase()
  const type = SOURCE_TYPE_MAP[sourceLower] || 'futures'
  const exchangeName = EXCHANGE_NAMES[sourceLower] || src.split('_')[0].replace(/^\w/, c => c.toUpperCase())
  const typeInfo = typeMap[type] || { label: type, color: sourceTagColor }

  return {
    exchange: exchangeName,
    type: typeInfo.label,
    typeColor: typeInfo.color,
  }
}

/**
 * Format display name - truncate wallet addresses
 */
export function formatDisplayName(name: string, platform?: string): string {
  if (!name) return 'Unknown'
  
  // Wallet addresses (0x...)
  if (name.startsWith('0x') && name.length > 20) {
    return `${name.substring(0, 6)}...${name.substring(name.length - 4)}`
  }
  
  // Filter out known placeholder / test-data patterns
  if (/^中台未注册/.test(name)) {
    const label = platform ? formatPlatformShort(platform) : ''
    return label ? `${label} Trader` : 'Trader'
  }
  
  // Platform-generated placeholder names → show as "Platform #ID"
  const placeholderMatch = name.match(/^(?:XT|MEXC|CoinEx|KuCoin|BingX|Binance)\s+Trader\s+(\w+)$/i)
  if (placeholderMatch) {
    const label = platform ? formatPlatformShort(platform) : name.split(' ')[0]
    return `${label} #${placeholderMatch[1].slice(-6)}`
  }
  
  // "Mexctrader-XXXXX" pattern
  if (/^Mexctrader-/i.test(name)) {
    const label = platform ? formatPlatformShort(platform) : 'MEXC'
    return `${label} #${name.slice(-6)}`
  }
  
  // Masked emails like "ma***6@gmail.com" or "*******277"
  if (/^\*+\d+$/.test(name) || /\*{3,}.*@/.test(name)) {
    const label = platform ? formatPlatformShort(platform) : ''
    return label ? `${label} Trader` : 'Trader'
  }
  
  // Pure numeric IDs
  if (/^\d+$/.test(name)) {
    const platformLabel = platform ? formatPlatformShort(platform) : ''
    return platformLabel ? `${platformLabel} #${name.slice(-6)}` : `#${name.slice(-6)}`
  }
  
  // Truncate long names
  if (name.length > 60) return name.slice(0, 57) + '...'
  
  return name
}

/** Short platform label for display */
function formatPlatformShort(platform: string): string {
  // Derive from central EXCHANGE_NAMES, strip " Spot"/" Web3"/" Perps" suffixes for short label
  const name = EXCHANGE_NAMES[platform]
  if (!name) return platform
  return name.replace(/ (?:Spot|Web3|Perps|Network|Protocol)$/i, '')
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
