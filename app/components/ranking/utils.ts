import { SOURCE_TYPE_MAP, EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { tokens } from '@/lib/design-tokens'
import { t } from "@/lib/i18n"
import { sanitizeDisplayName } from '@/lib/utils/profanity'

// Re-export canonical formatters from lib/utils/format
export { formatROI, formatPnL } from '@/lib/utils/format'

/**
 * 获取 PnL 数据来源提示
 * 不同交易所的 PnL 含义不同：
 * - Binance: 交易员本人盈亏
 * - Bybit/Bitget/KuCoin/MEXC: 跟单者收益（非交易员本人）
 */
export function getPnLTooltip(source: string, _language: string): string {
  const traderPnlSources = ['binance', 'binance_futures', 'binance_spot', 'binance_web3']
  const followerPnlSources = ['bybit', 'bitget', 'bitget_futures', 'bitget_spot', 'kucoin', 'mexc', 'htx', 'htx_futures', 'weex']

  const sourceLower = source.toLowerCase()

  if (traderPnlSources.some(s => sourceLower.includes(s))) {
    return t('pnlTraderOwn')
  }

  if (followerPnlSources.some(s => sourceLower.includes(s))) {
    return t('pnlFollowers')
  }

  return t('pnlDefault')
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
  if (!name || name === 'null' || name === 'undefined') return 'Unknown'

  let formatted: string

  // Copin format: "protocol:0xAddr" or "protocol:addr" or "gmx_v2:0x..." → extract address part
  if (name.includes(':') && /^[a-z0-9_]+:/i.test(name)) {
    const colonIdx = name.indexOf(':')
    const addr = name.slice(colonIdx + 1)
    if (addr.startsWith('0x') && addr.length > 20) {
      formatted = `${addr.substring(0, 6)}...${addr.substring(addr.length - 4)}`
    } else if (addr.length > 20) {
      formatted = `${addr.substring(0, 8)}...${addr.substring(addr.length - 4)}`
    } else {
      formatted = addr
    }
  }
  // Wallet addresses (0x...)
  else if (name.startsWith('0x') && name.length > 20) {
    formatted = `${name.substring(0, 6)}...${name.substring(name.length - 4)}`
  }
  // Filter out known placeholder / test-data patterns
  else if (/^中台未注册/.test(name)) {
    const label = platform ? formatPlatformShort(platform) : ''
    formatted = label ? `${label} Trader` : 'Trader'
  }
  // Platform-generated placeholder names → show as "Platform #ID"
  else if (name.match(/^(?:XT|MEXC|CoinEx|KuCoin|BingX|Binance)\s+Trader\s+(\w+)$/i)) {
    const placeholderMatch = name.match(/^(?:XT|MEXC|CoinEx|KuCoin|BingX|Binance)\s+Trader\s+(\w+)$/i)!
    const label = platform ? formatPlatformShort(platform) : name.split(' ')[0]
    formatted = `${label} #${placeholderMatch[1].slice(-6)}`
  }
  // "Mexctrader-XXXXX" pattern
  else if (/^Mexctrader-/i.test(name)) {
    const label = platform ? formatPlatformShort(platform) : 'MEXC'
    formatted = `${label} #${name.slice(-6)}`
  }
  // Masked emails like "ma***6@gmail.com" or "*******277"
  else if (/^\*+\d+$/.test(name) || /\*{3,}.*@/.test(name)) {
    const label = platform ? formatPlatformShort(platform) : ''
    formatted = label ? `${label} Trader` : 'Trader'
  }
  // Pure numeric IDs
  else if (/^\d+$/.test(name)) {
    const platformLabel = platform ? formatPlatformShort(platform) : ''
    formatted = platformLabel ? `${platformLabel} #${name.slice(-6)}` : `#${name.slice(-6)}`
  }
  // Truncate long names
  else if (name.length > 60) {
    formatted = name.slice(0, 57) + '...'
  }
  else {
    formatted = name
  }
  
  // Apply profanity filter to all display names
  return sanitizeDisplayName(formatted)
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
