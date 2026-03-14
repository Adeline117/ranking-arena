/**
 * Data export utilities — CSV, JSON, PDF
 */

// ── CSV ────────────────────────────────────────────────────

function escapeCsvValue(value: unknown): string {
  if (value == null) return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

export function exportToCSV(data: Record<string, unknown>[], filename: string): void {
  if (!data.length) return
  const keys = Object.keys(data[0])
  const header = keys.map(escapeCsvValue).join(',')
  const rows = data.map(row => keys.map(k => escapeCsvValue(row[k])).join(','))
  const csv = [header, ...rows].join('\n')
  downloadBlob(csv, `${filename}.csv`, 'text/csv;charset=utf-8;')
}

// ── JSON ───────────────────────────────────────────────────

export function exportToJSON(data: unknown, filename: string): void {
  const json = JSON.stringify(data, null, 2)
  downloadBlob(json, `${filename}.json`, 'application/json;charset=utf-8;')
}

// ── Screenshot export (canvas capture) ───────────────────────
// html2canvas removed — use native browser screenshot or a lighter alternative if needed

export async function exportToPDF(_element: HTMLElement, _filename: string): Promise<void> {
  throw new Error('PDF export is not available. html2canvas has been removed.')
}

// ── Blob download helper ───────────────────────────────────

function downloadBlob(content: string, filename: string, mimeType: string): void {
  const blob = new Blob(['\uFEFF' + content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

// ── Data formatters ────────────────────────────────────────

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface TraderExportRow {
  rank: number
  handle: string
  source: string
  roi: string
  pnl: string
  win_rate: string
  max_drawdown: string
  arena_score: string
  trades_count: number
}

export function formatTraderData(traders: Array<Record<string, unknown>>): TraderExportRow[] {
  return traders.map((t, i) => ({
    rank: (t.rank as number) || i + 1,
    handle: String(t.handle || t.nickname || ''),
    source: String(t.source || ''),
    roi: fmtPct(t.roi),
    pnl: fmtNum(t.pnl),
    win_rate: fmtPct(t.win_rate),
    max_drawdown: fmtPct(t.max_drawdown),
    arena_score: fmtNum(t.arena_score),
    trades_count: Number(t.trades_count || 0),
  }))
}

export interface PortfolioExportRow {
  handle: string
  source: string
  allocation_pct: string
  risk_level: string
  expected_roi: string
  expected_drawdown: string
}

export function formatPortfolioData(portfolio: Array<Record<string, unknown>>): PortfolioExportRow[] {
  return portfolio.map(p => ({
    handle: String(p.handle || ''),
    source: String(p.source || ''),
    allocation_pct: fmtPct(p.allocation_pct),
    risk_level: String(p.risk_level || ''),
    expected_roi: fmtPct((p.expected_contribution as Record<string, unknown>)?.roi),
    expected_drawdown: fmtPct((p.expected_contribution as Record<string, unknown>)?.drawdown),
  }))
}

function fmtPct(v: unknown): string {
  if (v == null) return ''
  return `${Number(v).toFixed(2)}%`
}

function fmtNum(v: unknown): string {
  if (v == null) return ''
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })
}
