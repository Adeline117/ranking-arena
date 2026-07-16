/**
 * Versioned contract for the production field-coverage artifact.
 *
 * Increment the version when serving-source selection, grouping, typed fields,
 * extras filtering, or fill-rate semantics change.
 */
export const FIELD_COVERAGE_DATA_CONTRACT = 'arena.trader_stats.field-coverage'
export const FIELD_COVERAGE_DATA_CONTRACT_VERSION = 1

export const FIELD_COVERAGE_TYPED_COLUMNS = [
  'roi',
  'pnl',
  'sharpe',
  'mdd',
  'win_rate',
  'win_positions',
  'total_positions',
  'copier_pnl',
  'copier_count',
  'aum',
  'volume',
  'profit_share_rate',
  'holding_duration_avg',
] as const

export interface FieldCoverageSourceRow {
  slug: string
  timeframe: number
  total: number
  typed: Record<string, number>
  extras: Record<string, number>
}

export interface FieldCoverageLedgerMetadata {
  generatedAt: string
  gitSha: string
}

function validateMetadata(metadata: FieldCoverageLedgerMetadata): void {
  const parsedGeneratedAt = new Date(metadata.generatedAt)
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(metadata.generatedAt) ||
    Number.isNaN(parsedGeneratedAt.valueOf()) ||
    parsedGeneratedAt.toISOString() !== metadata.generatedAt
  ) {
    throw new Error('generatedAt must be an ISO-8601 UTC timestamp with millisecond precision')
  }
  if (!/^[0-9a-f]{40}$/.test(metadata.gitSha)) {
    throw new Error('gitSha must be a full lowercase 40-character Git SHA')
  }
}

function pct(n: number, total: number): string {
  if (total === 0) return '—'
  return `${Math.round((n / total) * 1000) / 10}%`
}

export function renderFieldCoverageLedger(
  rows: FieldCoverageSourceRow[],
  metadata: FieldCoverageLedgerMetadata
): string {
  validateMetadata(metadata)

  const bySource = new Map<string, FieldCoverageSourceRow[]>()
  for (const row of rows) {
    if (!bySource.has(row.slug)) bySource.set(row.slug, [])
    bySource.get(row.slug)!.push(row)
  }

  const out: string[] = []
  out.push('# Exchange Field Coverage Ledger')
  out.push('')
  out.push(
    '> **Machine-generated** from production `arena.trader_stats` by ' +
      '`scripts/ingest-field-coverage-ledger.mts`. Do NOT hand-edit.'
  )
  out.push('')
  out.push('| metadata | value |')
  out.push('| --- | --- |')
  out.push(`| generated_at | \`${metadata.generatedAt}\` |`)
  out.push(`| git_sha | \`${metadata.gitSha}\` |`)
  out.push(`| data_contract | \`${FIELD_COVERAGE_DATA_CONTRACT}\` |`)
  out.push(`| data_contract_version | \`${FIELD_COVERAGE_DATA_CONTRACT_VERSION}\` |`)
  out.push('')
  out.push(
    'The Git SHA identifies the clean generator revision used before this artifact was written.'
  )
  out.push('')
  out.push(
    "Fill % = share of a source×timeframe's rows where the field is non-NULL. " +
      'A typed column or extras key at a low/zero rate is either not exposed by ' +
      'that exchange or a promotion gap. A key that regresses to 0 is a silent ' +
      'field loss — see `scripts/openclaw/field-coverage-canary.mjs`.'
  )
  out.push('')

  const sources = [...bySource.keys()].sort()
  out.push(`**${sources.length} serving sources.**`)
  out.push('')

  for (const slug of sources) {
    const tfRows = [...bySource.get(slug)!].sort((a, b) => a.timeframe - b.timeframe)
    out.push(`## ${slug}`)
    out.push('')
    const tfs = tfRows.map((row) => row.timeframe)
    out.push(`Timeframes: ${tfs.join(', ')} · rows: ${tfRows.map((row) => row.total).join(' / ')}`)
    out.push('')

    out.push('**Typed columns** (fill % per timeframe)')
    out.push('')
    out.push(`| column | ${tfRows.map((row) => `${row.timeframe}d`).join(' | ')} |`)
    out.push(`|---|${tfRows.map(() => '---').join('|')}|`)
    for (const column of FIELD_COVERAGE_TYPED_COLUMNS) {
      const cells = tfRows.map((row) => pct(row.typed[column] ?? 0, row.total))
      if (cells.every((cell) => cell === '0%' || cell === '—')) continue
      out.push(`| ${column} | ${cells.join(' | ')} |`)
    }
    out.push('')

    const allExtras = new Set<string>()
    for (const row of tfRows) {
      for (const key of Object.keys(row.extras)) allExtras.add(key)
    }
    if (allExtras.size > 0) {
      out.push('**Extras keys** (fill % per timeframe)')
      out.push('')
      out.push(`| extras key | ${tfRows.map((row) => `${row.timeframe}d`).join(' | ')} |`)
      out.push(`|---|${tfRows.map(() => '---').join('|')}|`)
      for (const key of [...allExtras].sort()) {
        const cells = tfRows.map((row) => pct(row.extras[key] ?? 0, row.total))
        out.push(`| ${key} | ${cells.join(' | ')} |`)
      }
      out.push('')
    }
  }

  return out.join('\n').trimEnd() + '\n'
}
