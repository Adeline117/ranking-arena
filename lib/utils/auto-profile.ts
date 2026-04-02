/**
 * Auto-generate bio and tags for traders based on available performance data.
 *
 * Generated bios are flagged with bio_source='auto' so they never overwrite
 * manually written bios (bio_source='manual' or bio_source='exchange').
 */

import { EXCHANGE_CONFIG, SOURCE_TYPE_MAP } from '@/lib/constants/exchanges'
import type { SnapshotMetrics } from '@/lib/types/trading-platform'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutoProfileInput {
  platform: string
  trader_key: string
  display_name: string | null
  /** Best available snapshot (prefer 90D > 30D > 7D) */
  snapshot: SnapshotMetrics | null
  /** Which window the snapshot is from */
  snapshot_window: '7D' | '30D' | '90D' | null
  /** Total number of traders on this platform for the same window (for percentile) */
  total_traders_on_platform?: number | null
  /** Whether this trader is a bot */
  is_bot?: boolean
}

export interface AutoProfileResult {
  bio: string
  bio_zh: string
  tags: string[]
}

// ---------------------------------------------------------------------------
// Platform display helpers
// ---------------------------------------------------------------------------

function getPlatformDisplayName(platform: string): string {
  const config = EXCHANGE_CONFIG[platform as keyof typeof EXCHANGE_CONFIG]
  return config?.name ?? platform.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function getPlatformType(platform: string): 'CEX' | 'DEX' | 'Web3' {
  const st = SOURCE_TYPE_MAP[platform]
  if (st === 'web3') return 'DEX'
  if (st === 'spot') return 'CEX'
  return 'CEX'
}

function getMarketLabel(platform: string): string {
  const st = SOURCE_TYPE_MAP[platform]
  if (st === 'spot') return 'spot'
  if (st === 'web3') return 'perpetual'
  return 'futures'
}

function getMarketLabelZh(platform: string): string {
  const st = SOURCE_TYPE_MAP[platform]
  if (st === 'spot') return '现货'
  if (st === 'web3') return '永续合约'
  return '合约'
}

// ---------------------------------------------------------------------------
// Number formatting helpers
// ---------------------------------------------------------------------------

function formatRoi(roi: number): string {
  const sign = roi >= 0 ? '+' : ''
  if (Math.abs(roi) >= 1000) {
    return `${sign}${(roi / 1000).toFixed(1)}K%`
  }
  return `${sign}${roi.toFixed(roi >= 100 || roi <= -100 ? 0 : 1)}%`
}

function formatPnl(pnl: number): string {
  const abs = Math.abs(pnl)
  const sign = pnl >= 0 ? '+' : '-'
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`
  return `${sign}$${abs.toFixed(0)}`
}

function formatPnlZh(pnl: number): string {
  const abs = Math.abs(pnl)
  const sign = pnl >= 0 ? '+' : '-'
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`
  
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`
  return `${sign}$${abs.toFixed(0)}`
}

// ---------------------------------------------------------------------------
// Percentile calculation
// ---------------------------------------------------------------------------

function getPercentile(rank: number | null, total: number | null | undefined): number | null {
  if (rank == null || !total || total <= 0) return null
  return (rank / total) * 100
}

function getPercentileLabel(pct: number): string | null {
  if (pct <= 1) return 'top-1%'
  if (pct <= 5) return 'top-5%'
  if (pct <= 10) return 'top-10%'
  if (pct <= 25) return 'top-25%'
  return null
}

// ---------------------------------------------------------------------------
// Trading style inference
// ---------------------------------------------------------------------------

function inferTradingStyleFromHoldingHours(hours: number | null | undefined): string | null {
  if (hours == null) return null
  if (hours < 4) return 'scalper'
  if (hours < 48) return 'swing'
  if (hours < 336) return 'trend'   // 2 weeks
  return 'position'
}

const STYLE_LABELS: Record<string, string> = {
  scalper: 'scalping',
  hft: 'scalping',
  scalping: 'scalping',
  swing: 'swing trading',
  day_trader: 'day trading',
  trend: 'trend following',
  position: 'position trading',
}

const STYLE_LABELS_ZH: Record<string, string> = {
  scalper: '高频交易',
  hft: '高频交易',
  scalping: '高频交易',
  swing: '波段交易',
  day_trader: '日内交易',
  trend: '趋势跟踪',
  position: '长线持仓',
}

// ---------------------------------------------------------------------------
// Risk classification
// ---------------------------------------------------------------------------

function getRiskTag(maxDrawdown: number | null | undefined): string | null {
  if (maxDrawdown == null) return null
  const mdd = Math.abs(maxDrawdown)
  if (mdd <= 10) return 'low-risk'
  if (mdd <= 30) return 'moderate-risk'
  return 'high-risk'
}

// ---------------------------------------------------------------------------
// generateAutoBio
// ---------------------------------------------------------------------------

export function generateAutoBio(input: AutoProfileInput): { en: string; zh: string } {
  const { platform, snapshot, snapshot_window, total_traders_on_platform, is_bot } = input
  const platName = getPlatformDisplayName(platform)
  const market = getMarketLabel(platform)
  const marketZh = getMarketLabelZh(platform)

  if (!snapshot || snapshot_window == null) {
    // Minimal bio when no snapshot data available
    const _type = getPlatformType(platform)
    if (is_bot) {
      return {
        en: `Automated trading bot on ${platName}.`,
        zh: `${platName} 自动交易机器人。`,
      }
    }
    return {
      en: `${platName} ${market} trader.`,
      zh: `${platName} ${marketZh}交易员。`,
    }
  }

  const parts_en: string[] = []
  const parts_zh: string[] = []

  // Part 1: Rank / percentile intro
  const pct = getPercentile(snapshot.rank, total_traders_on_platform)
  if (pct != null && pct <= 25) {
    const pctLabel = pct <= 1 ? '1' : pct <= 5 ? '5' : pct <= 10 ? '10' : '25'
    if (is_bot) {
      parts_en.push(`Top ${pctLabel}% automated bot on ${platName}.`)
      parts_zh.push(`${platName} 前 ${pctLabel}% 自动交易机器人。`)
    } else {
      parts_en.push(`Top ${pctLabel}% ${platName} ${market} trader.`)
      parts_zh.push(`${platName} 前 ${pctLabel}% ${marketZh}交易员。`)
    }
  } else {
    if (is_bot) {
      parts_en.push(`Automated trading bot on ${platName}.`)
      parts_zh.push(`${platName} 自动交易机器人。`)
    } else {
      parts_en.push(`${platName} ${market} trader.`)
      parts_zh.push(`${platName} ${marketZh}交易员。`)
    }
  }

  // Part 2: Performance summary
  const perfParts_en: string[] = []
  const perfParts_zh: string[] = []

  // ROI
  perfParts_en.push(`${snapshot_window} ROI ${formatRoi(snapshot.roi ?? 0)}`)
  perfParts_zh.push(`${snapshot_window} ROI ${formatRoi(snapshot.roi ?? 0)}`)

  // PnL
  if (snapshot.pnl != null && Math.abs(snapshot.pnl) >= 10) {
    perfParts_en.push(`${formatPnl(snapshot.pnl)} PnL`)
    perfParts_zh.push(`盈亏 ${formatPnlZh(snapshot.pnl)}`)
  }

  // Win rate
  if (snapshot.win_rate != null) {
    perfParts_en.push(`${snapshot.win_rate.toFixed(0)}% win rate`)
    perfParts_zh.push(`胜率 ${snapshot.win_rate.toFixed(0)}%`)
  }

  if (perfParts_en.length > 0) {
    parts_en.push(perfParts_en.join(', ') + '.')
    parts_zh.push(perfParts_zh.join('，') + '。')
  }

  // Part 3: Trading style (optional, appended if available)
  const style = snapshot.trading_style
  const holdingHours = snapshot.avg_holding_hours
  const resolvedStyle = style || inferTradingStyleFromHoldingHours(holdingHours)
  if (resolvedStyle && STYLE_LABELS[resolvedStyle]) {
    parts_en.push(`Specializes in ${STYLE_LABELS[resolvedStyle]}.`)
    parts_zh.push(`擅长${STYLE_LABELS_ZH[resolvedStyle] || STYLE_LABELS[resolvedStyle]}。`)
  }

  return {
    en: parts_en.join(' '),
    zh: parts_zh.join(''),
  }
}

// ---------------------------------------------------------------------------
// generateAutoTags
// ---------------------------------------------------------------------------

export function generateAutoTags(input: AutoProfileInput): string[] {
  const { platform, snapshot, total_traders_on_platform, is_bot } = input
  const tags: string[] = []

  // Platform type tag
  const platType = getPlatformType(platform)
  if (platType === 'DEX') {
    tags.push('defi')
  }

  // Bot tag
  if (is_bot) {
    tags.push('bot')
  }

  if (!snapshot) return tags

  // Performance percentile tags
  const pct = getPercentile(snapshot.rank, total_traders_on_platform)
  if (pct != null) {
    const label = getPercentileLabel(pct)
    if (label) tags.push(label)
  }

  // Trading style tag
  const style = snapshot.trading_style || inferTradingStyleFromHoldingHours(snapshot.avg_holding_hours)
  if (style && style !== 'unknown') {
    // Normalize to canonical names
    const canonMap: Record<string, string> = {
      scalper: 'scalper', hft: 'scalper', scalping: 'scalper',
      day_trader: 'swing', swing: 'swing', trend: 'trend', position: 'position',
    }
    const canonical = canonMap[style] || style
    tags.push(canonical)
  }

  // Risk tags from max_drawdown
  const riskTag = getRiskTag(snapshot.max_drawdown)
  if (riskTag) tags.push(riskTag)

  // Volume / activity tags
  if (snapshot.pnl != null && Math.abs(snapshot.pnl) >= 100_000) {
    tags.push('whale')
  }
  if (snapshot.trades_count != null && snapshot.trades_count >= 1000) {
    tags.push('active')
  }

  // High win rate
  if (snapshot.win_rate != null && snapshot.win_rate >= 70) {
    tags.push('high-winrate')
  }

  // Profitable
  if ((snapshot.roi ?? 0) > 100) {
    tags.push('high-roi')
  }

  // Arena score elite
  if (snapshot.arena_score != null && snapshot.arena_score >= 80) {
    tags.push('elite')
  }

  return [...new Set(tags)] // deduplicate
}

// ---------------------------------------------------------------------------
// Combined helper
// ---------------------------------------------------------------------------

export function generateAutoProfile(input: AutoProfileInput, _lang: 'en' | 'zh' = 'en'): AutoProfileResult {
  const bio = generateAutoBio(input)
  const tags = generateAutoTags(input)

  return {
    bio: bio.en,
    bio_zh: bio.zh,
    tags,
  }
}
