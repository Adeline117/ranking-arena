import type {
  CanonicalPositionHistorySourceFact,
  PositionHistoryCandidateInspection,
  ReviewedPositionHistorySourceFactContract,
} from '../../position-history-source-facts'
import { OKX_POSITION_HISTORY_TERMINAL_VERIFIER_CONTRACT } from './history-terminal'

export const OKX_POSITION_HISTORY_SOURCE_FACT_CONTRACT =
  'arena.ingest.position-history-source-facts.okx.position_history@1' as const

function canonicalIdentity(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.length > 0 && value.trim() === value ? value : null
  }
  return Number.isSafeInteger(value) && Number(value) >= 0 ? String(value) : null
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

function positiveEpochEvidence(value: unknown): Readonly<{ iso: string; scalar: string }> | null {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && (value.length === 0 || value.trim() !== value))
  ) {
    return null
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null
  try {
    return {
      iso: new Date(parsed).toISOString(),
      scalar: typeof value === 'string' ? value : String(value),
    }
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

function inspectOkxPositionHistoryCandidate(input: {
  readonly rawCandidate: Readonly<Record<string, unknown>>
  readonly exchangeTraderId: string
}): PositionHistoryCandidateInspection {
  const raw = input.rawCandidate
  const subPositionId = canonicalIdentity(raw.subPosId)
  const symbol = canonicalText(raw.instId)
  const sideMarker = canonicalText(raw.posSide)
  const openedAt = positiveEpochEvidence(raw.openTime)
  const closedAt = positiveEpochEvidence(raw.closeTime)
  if (
    subPositionId === null ||
    symbol === null ||
    sideMarker === null ||
    openedAt === null ||
    closedAt === null ||
    Date.parse(closedAt.iso) < Date.parse(openedAt.iso)
  ) {
    return { state: 'unavailable', reason: 'okx_source_fact_identity_or_lifecycle_invalid' }
  }

  const sourceReturn = numericEvidence(raw.pnlRatio)
  const leverage = numericEvidence(raw.lever)
  const size = numericEvidence(raw.subPos)
  const entryPrice = numericEvidence(raw.openAvgPx)
  const exitPrice = numericEvidence(raw.closeAvgPx)
  const realizedPnl = numericEvidence(raw.pnl)
  const sourceFact: CanonicalPositionHistorySourceFact = {
    sourceFactId: JSON.stringify([input.exchangeTraderId, subPositionId]),
    sourceLifecycleMarker: closedAt.scalar,
    sourceReturn: sourceReturn.value,
    openedAt: openedAt.iso,
    closedAt: closedAt.iso,
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

const defaultPath = Object.freeze(['data'] as const)

export const okxPositionHistorySourceFactContract: ReviewedPositionHistorySourceFactContract =
  Object.freeze({
    contract: OKX_POSITION_HISTORY_SOURCE_FACT_CONTRACT,
    sourceSlug: 'okx_futures',
    terminalVerifierContract: OKX_POSITION_HISTORY_TERMINAL_VERIFIER_CONTRACT,
    candidatePathBySegment: Object.freeze({ default: defaultPath }),
    duplicatePolicy: 'forbid',
    requireIdenticalSegmentFactSets: false,
    inspectCandidate: inspectOkxPositionHistoryCandidate,
  })
