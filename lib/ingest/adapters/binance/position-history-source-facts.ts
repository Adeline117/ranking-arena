import type {
  CanonicalPositionHistorySourceFact,
  PositionHistoryCandidateInspection,
  ReviewedPositionHistorySourceFactContract,
} from '../../position-history-source-facts'
import { BINANCE_POSITION_HISTORY_TERMINAL_VERIFIER_CONTRACT } from './history-terminal'

export const BINANCE_POSITION_HISTORY_SOURCE_FACT_CONTRACT =
  'arena.ingest.position-history-source-facts.binance.position_history@1' as const

function canonicalIdentity(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.length > 0 && value.trim() === value ? value : null
  }
  return Number.isSafeInteger(value) ? String(value) : null
}

function canonicalText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return null
  return value
}

function numericEvidence(
  value: unknown
): Readonly<{ value: number | null; scalar: string | null }> {
  if (value === null || value === undefined) return { value: null, scalar: null }
  if (typeof value !== 'number' && typeof value !== 'string') {
    return { value: null, scalar: null }
  }
  if (typeof value === 'string' && (value.length === 0 || value.trim() !== value)) {
    return { value: null, scalar: null }
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return { value: null, scalar: null }
  return {
    value: Object.is(parsed, -0) ? 0 : parsed,
    scalar: typeof value === 'string' ? value : Object.is(value, -0) ? '0' : String(value),
  }
}

function positiveEpoch(value: unknown): string | null {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && (value.length === 0 || value.trim() !== value))
  ) {
    return null
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null
  try {
    return new Date(parsed).toISOString()
  } catch {
    return null
  }
}

function canonicalSide(value: string): string {
  const normalized = value.toLowerCase()
  if (normalized === 'long' || normalized === 'buy') return 'long'
  if (normalized === 'short' || normalized === 'sell') return 'short'
  return normalized
}

function inspectBinancePositionHistoryCandidate(input: {
  readonly rawCandidate: Readonly<Record<string, unknown>>
  readonly exchangeTraderId: string
}): PositionHistoryCandidateInspection {
  const raw = input.rawCandidate
  const rowId = canonicalIdentity(raw.id)
  const symbol = canonicalText(raw.symbol)
  const sideMarker = canonicalText(raw.side)
  const lifecycle = canonicalText(raw.status)
  const openedAt = positiveEpoch(raw.opened)
  const closedAt = positiveEpoch(raw.closed)
  if (
    rowId === null ||
    symbol === null ||
    sideMarker === null ||
    lifecycle !== 'All Closed' ||
    openedAt === null ||
    closedAt === null ||
    Date.parse(closedAt) < Date.parse(openedAt)
  ) {
    return { state: 'unavailable', reason: 'binance_source_fact_identity_or_lifecycle_invalid' }
  }

  const sourceReturn = numericEvidence(raw.roi)
  const leverage = numericEvidence(raw.leverage)
  const size = numericEvidence(raw.closedVolume)
  const entryPrice = numericEvidence(raw.avgCost)
  const exitPrice = numericEvidence(raw.avgClosePrice)
  const realizedPnl = numericEvidence(raw.closingPnl)
  const sourceFact: CanonicalPositionHistorySourceFact = {
    sourceFactId: JSON.stringify([input.exchangeTraderId, rowId, symbol, sideMarker]),
    sourceLifecycleMarker: lifecycle,
    sourceReturn: sourceReturn.value,
    openedAt,
    closedAt,
    symbol,
    side: canonicalSide(sideMarker),
    leverage: leverage.value,
    size: size.value,
    entryPrice: entryPrice.value,
    exitPrice: exitPrice.value,
    realizedPnl: realizedPnl.value,
    sourceNumericScalars: {
      sourceReturn: sourceReturn.scalar,
      leverage: leverage.scalar,
      size: size.scalar,
      entryPrice: entryPrice.scalar,
      exitPrice: exitPrice.scalar,
      realizedPnl: realizedPnl.scalar,
    },
  }
  return { state: 'source_fact', sourceFact }
}

const closingPath = Object.freeze(['response', 'data', 'list'] as const)
const openingPath = Object.freeze(['response', 'data', 'list'] as const)

export const binancePositionHistorySourceFactContract: ReviewedPositionHistorySourceFactContract =
  Object.freeze({
    contract: BINANCE_POSITION_HISTORY_SOURCE_FACT_CONTRACT,
    sourceSlug: 'binance_futures',
    terminalVerifierContract: BINANCE_POSITION_HISTORY_TERMINAL_VERIFIER_CONTRACT,
    candidatePathBySegment: Object.freeze({ closing: closingPath, opening: openingPath }),
    duplicatePolicy: 'exact_cross_segment',
    requireIdenticalSegmentFactSets: true,
    inspectCandidate: inspectBinancePositionHistoryCandidate,
  })
