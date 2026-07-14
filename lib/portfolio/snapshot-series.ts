/**
 * Portfolio snapshot series helpers.
 *
 * A manual sync and the daily rollup can both write a snapshot for the same
 * portfolio on the same UTC day. The read model must use the newest one for
 * that account/day, then aggregate accounts — summing every write turns a
 * second sync into a fictitious second portfolio.
 */

export interface PortfolioSnapshotRow {
  portfolio_id: string
  total_equity: number | string | null
  total_pnl: number | string | null
  snapshot_at: string
}

export interface DailyPortfolioSnapshot {
  total_equity: number
  total_pnl: number
  total_pnl_pct: number
  snapshot_at: string
}

export function aggregateLatestDailyPortfolioSnapshots(
  rows: PortfolioSnapshotRow[]
): DailyPortfolioSnapshot[] {
  const latestByPortfolioDay = new Map<string, PortfolioSnapshotRow>()

  for (const row of rows) {
    const day = row.snapshot_at.slice(0, 10)
    const key = `${row.portfolio_id}|${day}`
    const existing = latestByPortfolioDay.get(key)
    if (!existing || row.snapshot_at > existing.snapshot_at) latestByPortfolioDay.set(key, row)
  }

  const byDay = new Map<string, { total_equity: number; total_pnl: number; snapshot_at: string }>()
  for (const row of latestByPortfolioDay.values()) {
    const day = row.snapshot_at.slice(0, 10)
    const existing = byDay.get(day)
    const equity = Number(row.total_equity) || 0
    const pnl = Number(row.total_pnl) || 0
    if (existing) {
      existing.total_equity += equity
      existing.total_pnl += pnl
      if (row.snapshot_at > existing.snapshot_at) existing.snapshot_at = row.snapshot_at
    } else {
      byDay.set(day, { total_equity: equity, total_pnl: pnl, snapshot_at: row.snapshot_at })
    }
  }

  return Array.from(byDay.values())
    .sort((a, b) => a.snapshot_at.localeCompare(b.snapshot_at))
    .map((snapshot) => ({
      ...snapshot,
      total_pnl_pct:
        snapshot.total_equity > 0 ? (snapshot.total_pnl / snapshot.total_equity) * 100 : 0,
    }))
}
