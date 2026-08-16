export const DAILY_HISTORY_PUBLICATION_CONTRACT = 'arena.daily-history-publication@1' as const

export interface DailyPublicationProof {
  seasonId: string
  generationId: string
  cohortId: string
  manifestHash: string
  expectedCount: number
  publishedCount: number
  finalizedAt: string
}

export interface DailySeriesPoint {
  date: string
  value: number
}

export interface PublishedEquity {
  contract: typeof DAILY_HISTORY_PUBLICATION_CONTRACT
  available: true
  publication: DailyPublicationProof
  equity: DailySeriesPoint[]
  pnl: DailySeriesPoint[]
  drawdown: DailySeriesPoint[]
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPublicationProof(value: unknown): value is DailyPublicationProof {
  if (!value || typeof value !== 'object') return false
  const proof = value as Record<string, unknown>
  return (
    isNonEmptyString(proof.seasonId) &&
    isNonEmptyString(proof.generationId) &&
    isNonEmptyString(proof.cohortId) &&
    typeof proof.manifestHash === 'string' &&
    /^[a-f0-9]{64}$/i.test(proof.manifestHash) &&
    Number.isInteger(proof.expectedCount) &&
    (proof.expectedCount as number) > 0 &&
    proof.publishedCount === proof.expectedCount &&
    isNonEmptyString(proof.finalizedAt) &&
    Number.isFinite(Date.parse(proof.finalizedAt as string))
  )
}

function isDailySeriesPoint(value: unknown): value is DailySeriesPoint {
  if (!value || typeof value !== 'object') return false
  const point = value as Record<string, unknown>
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(typeof point.date === 'string' ? point.date : '') &&
    typeof point.value === 'number' &&
    Number.isFinite(point.value)
  )
}

function isDailySeries(value: unknown): value is DailySeriesPoint[] {
  return Array.isArray(value) && value.every(isDailySeriesPoint)
}

/**
 * Fail closed on legacy/CDN payloads. A positive flag alone is insufficient:
 * every published series must identify its sealed cohort and complete manifest.
 */
export function acceptPublishedEquity(value: unknown): PublishedEquity | null {
  if (!value || typeof value !== 'object') return null
  const envelope = value as Record<string, unknown>
  if (
    envelope.contract !== DAILY_HISTORY_PUBLICATION_CONTRACT ||
    envelope.available !== true ||
    !isPublicationProof(envelope.publication) ||
    !isDailySeries(envelope.equity) ||
    !isDailySeries(envelope.pnl) ||
    !isDailySeries(envelope.drawdown)
  ) {
    return null
  }

  return envelope as unknown as PublishedEquity
}
