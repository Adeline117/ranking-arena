/**
 * Portfolio Suggestions Service
 * Phase 3 — enhanced logic with risk profiles and diversification
 *
 * Risk presets (from spec):
 *   Conservative: MDD < 10%, WR > 60%, Score > 70
 *   Balanced:     MDD < 25%, WR > 50%, Score > 50
 *   Aggressive:   Highest ROI, no MDD limit
 *
 * Diversification goals:
 *   - Different exchanges
 *   - Different types: futures / spot / DeFi (web3)
 */

import {
  generatePortfolioSuggestion,
  generateAllPortfolioSuggestions,
  type RiskPreference,
  type TraderForPortfolio,
  type PortfolioSuggestion,
} from '@/lib/utils/portfolio-builder'

// ── Types ──────────────────────────────────────────────────

export interface PortfolioInput {
  traders: TraderForPortfolio[]
  preference?: RiskPreference
}

export interface PortfolioResult {
  suggestions: PortfolioSuggestion[]
  traderPoolSize: number
  generatedAt: string
}

// ── Service ────────────────────────────────────────────────

/**
 * Generate portfolio suggestions.
 * Delegates to the core builder but adds input validation + metadata.
 */
export function generateSuggestions(input: PortfolioInput): PortfolioResult {
  const { traders, preference } = input

  if (!traders || traders.length < 3) {
    return {
      suggestions: [],
      traderPoolSize: traders?.length ?? 0,
      generatedAt: new Date().toISOString(),
    }
  }

  let suggestions: PortfolioSuggestion[]
  if (preference) {
    const s = generatePortfolioSuggestion(traders, preference)
    suggestions = s ? [s] : []
  } else {
    suggestions = generateAllPortfolioSuggestions(traders)
  }

  return {
    suggestions,
    traderPoolSize: traders.length,
    generatedAt: new Date().toISOString(),
  }
}

/**
 * Classify a trader's source into a broader type.
 * Used for diversification scoring.
 */
export function classifySourceType(source: string): 'futures' | 'spot' | 'web3' {
  if (source.includes('spot')) return 'spot'
  if (source.includes('web3') || source.includes('gmx') || source.includes('dydx')) return 'web3'
  return 'futures'
}

/**
 * Extract exchange name from a source string.
 */
export function extractExchange(source: string): string {
  const map: Record<string, string> = {
    binance_futures: 'Binance',
    binance_spot: 'Binance',
    binance_web3: 'Binance',
    bybit: 'Bybit',
    bitget_futures: 'Bitget',
    bitget_spot: 'Bitget',
    mexc: 'MEXC',
    coinex: 'CoinEx',
    okx_web3: 'OKX',
    kucoin: 'KuCoin',
    gmx: 'GMX',
    dydx: 'dYdX',
    hyperliquid: 'Hyperliquid',
  }
  return map[source] ?? source
}

/**
 * Build the TraderForPortfolio struct from raw DB rows.
 * Centralised so both the API route and any future callers share logic.
 */
export function buildTraderForPortfolio(raw: {
  source_trader_id: string
  source: string
  handle?: string | null
  roi: number | null
  max_drawdown: number | null
  win_rate: number | null
  followers: number | null
  arena_score?: number | null
}): TraderForPortfolio {
  const roi = raw.roi ?? 0
  const drawdown = Math.abs(raw.max_drawdown ?? 0)
  const winRate = raw.win_rate ?? 50

  // Simplified Arena Score if not provided
  const arenaScore = raw.arena_score ?? Math.round(
    Math.min(roi / 2, 85) +
    Math.max(0, 8 - drawdown / 5) +
    Math.max(0, (winRate - 45) / 3.5)
  )

  return {
    trader_id: raw.source_trader_id,
    source: raw.source,
    handle: raw.handle || raw.source_trader_id,
    roi,
    max_drawdown: raw.max_drawdown,
    win_rate: raw.win_rate,
    arena_score: arenaScore,
    followers: raw.followers ?? 0,
    source_type: classifySourceType(raw.source),
  }
}
