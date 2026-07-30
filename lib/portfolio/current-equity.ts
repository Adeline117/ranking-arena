export interface PortfolioCurrentEquityRow {
  is_active: boolean
  current_equity: number | string | null
  current_pnl: number | string | null
  current_equity_generation: number | string
}

export interface PortfolioCurrentEquitySummary {
  totalEquity: number
  totalPnl: number
  totalPnlPct: number
}

function finiteNumber(value: number | string | null): number | null {
  if (value === null || (typeof value === 'string' && value.trim() === '')) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Aggregate only current, lifecycle-owned exchange projections. Position size
 * multiplied by mark price is leveraged exposure and must never be presented
 * as account equity.
 */
export function summarizePortfolioCurrentEquity(
  portfolios: PortfolioCurrentEquityRow[]
): PortfolioCurrentEquitySummary {
  let totalEquity = 0
  let totalPnl = 0

  for (const portfolio of portfolios) {
    const generation = finiteNumber(portfolio.current_equity_generation)
    const equity = finiteNumber(portfolio.current_equity)
    const pnl = finiteNumber(portfolio.current_pnl)
    if (
      portfolio.is_active !== true ||
      generation === null ||
      !Number.isSafeInteger(generation) ||
      generation <= 0 ||
      equity === null ||
      equity < 0 ||
      pnl === null
    ) {
      continue
    }
    totalEquity += equity
    totalPnl += pnl
  }

  return {
    totalEquity,
    totalPnl,
    totalPnlPct: totalEquity > 0 ? (totalPnl / totalEquity) * 100 : 0,
  }
}
