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

// ── PDF via print ─────────────────────────────────────────────
// Opens a print dialog with a formatted HTML table. Users can "Save as PDF" from the dialog.

export function exportToPDF(data: Record<string, unknown>[], filename: string): void {
  if (!data.length) return

  const keys = Object.keys(data[0])
  const headerCells = keys.map(k => `<th style="padding:6px 12px;border-bottom:2px solid #8b6fa8;text-align:left;font-size:13px;white-space:nowrap">${escapeHtml(k)}</th>`).join('')
  const bodyRows = data.map(row =>
    `<tr>${keys.map(k => `<td style="padding:5px 12px;border-bottom:1px solid #ddd;font-size:12px">${escapeHtml(String(row[k] ?? ''))}</td>`).join('')}</tr>`
  ).join('')

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(filename)}</title>
<style>
  @media print { body { margin: 0; } @page { size: landscape; margin: 10mm; } }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #222; }
  table { border-collapse: collapse; width: 100%; }
  h1 { font-size: 16px; color: #8b6fa8; margin-bottom: 8px; }
  p.meta { font-size: 11px; color: #888; margin-bottom: 12px; }
</style></head><body>
<h1>Arena - ${escapeHtml(filename)}</h1>
<p class="meta">Exported on ${new Date().toLocaleDateString()} from arenafi.org</p>
<table><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table>
<script>window.onafterprint=function(){window.close()};window.print();<\/script>
</body></html>`

  const printWindow = window.open('', '_blank')
  if (printWindow) {
    printWindow.document.write(html)
    printWindow.document.close()
  }
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
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
