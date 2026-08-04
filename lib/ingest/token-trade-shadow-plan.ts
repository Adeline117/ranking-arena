import { createHash } from 'node:crypto'

import { BINANCE_POSITION_HISTORY_SOURCE_FACT_CONTRACT } from './adapters/binance/position-history-source-facts'
import { BINANCE_POSITION_HISTORY_TERMINAL_VERIFIER_CONTRACT } from './adapters/binance/history-terminal'
import { OKX_POSITION_HISTORY_SOURCE_FACT_CONTRACT } from './adapters/okx/position-history-source-facts'
import { OKX_POSITION_HISTORY_TERMINAL_VERIFIER_CONTRACT } from './adapters/okx/history-terminal'
import {
  POSITION_HISTORY_ACQUISITION_ARTIFACT_V2_CONTRACT,
  revalidatePositionHistoryAcquisitionArtifactV2,
  type PositionHistoryAcquisitionArtifactV2,
} from './position-history-acquisition-v2'
import type { CanonicalPositionHistorySourceFact } from './position-history-source-facts'

export const TOKEN_TRADE_SHADOW_PLAN_CONTRACT = 'arena.ingest.token-trade-shadow-plan@1' as const
export const DA2_SHADOW_WRITER_CANARY_BLOCKER = 'da2_shadow_writer_canary' as const

const FX_EVIDENCE_UNAVAILABLE_BLOCKER = 'fx_evidence_unavailable'
const HISTORY_COVERAGE_UNAVAILABLE_BLOCKER = 'history_coverage_unavailable'
const PROJECTION_RUN_RECEIPT_REQUIRED_BLOCKER = 'projection_run_receipt_required'
const UNSUPPORTED_ASSET_MAPPING_BLOCKER = 'unsupported_asset_mapping'

const REVIEWED_CEX_ASSETS = Object.freeze([
  ['ADA', 'crypto:ada'],
  ['ATOM', 'crypto:atom'],
  ['AVAX', 'crypto:avax'],
  ['BNB', 'crypto:bnb'],
  ['BTC', 'crypto:btc'],
  ['DOGE', 'crypto:doge'],
  ['DOT', 'crypto:dot'],
  ['ETH', 'crypto:eth'],
  ['LINK', 'crypto:link'],
  ['LTC', 'crypto:ltc'],
  ['MATIC', 'crypto:matic'],
  ['NEAR', 'crypto:near'],
  ['SOL', 'crypto:sol'],
  ['UNI', 'crypto:uni'],
  ['XRP', 'crypto:xrp'],
] as const)

type ReviewedTicker = (typeof REVIEWED_CEX_ASSETS)[number][0]

interface ReviewedSourceContract {
  readonly sourceSlug: 'binance_futures' | 'okx_futures'
  readonly sourceFactContract: string
  readonly terminalVerifierContract: string
  readonly authorityContractId:
    | 'binance-futures-position-history@1'
    | 'okx-futures-position-history@1'
  readonly authorityMethodVersion:
    | 'arena.binance-futures-token-trade-fact@1'
    | 'arena.okx-futures-token-trade-fact@1'
  readonly sourceSymbol: (ticker: ReviewedTicker) => string
  readonly dedupeHash: (
    sourceFactId: string,
    fact: CanonicalPositionHistorySourceFact,
    exchangeTraderId: string
  ) => string | null
}

export type TokenTradeShadowPlanState = 'planned' | 'partial' | 'verified_empty' | 'unavailable'

export interface TokenTradeShadowUnsupportedFact {
  readonly sourceFactId: string
  readonly sourceSymbol: string
}

export interface TokenTradeShadowFactPlan {
  readonly sourceContractId: ReviewedSourceContract['authorityContractId']
  readonly sourceId: number
  readonly traderId: number
  /** The immutable outer @2 RAW digest, never the nested @1 acquisition digest. */
  readonly sourceRunId: string
  readonly sourceRawObjectId: number
  readonly sourceRowIdentity: string
  readonly canonicalFactSha256: string
  readonly closedAt: string
  readonly positionDedupeHash: string
  readonly sourceSymbol: string
  readonly sourceAssetLocator: string
  readonly assetId: string
  readonly assetNamespace: 'cex'
  readonly assetChainId: null
  readonly assetProtocolSlug: null
  readonly tokenAddress: null
  readonly normalizedToken: string
  readonly tokenNormalizationState: 'normalized'
  readonly tokenNormalizationMethodVersion: 'arena.derivative-token-normalization@1'
  readonly openedAt: string
  /** Exact source scalar suitable for a PostgreSQL numeric parameter. */
  readonly entryPrice: string | null
  /** Exact source scalar suitable for a PostgreSQL numeric parameter. */
  readonly exitPrice: string | null
  /** Exact source scalar suitable for a PostgreSQL numeric parameter; zero is retained. */
  readonly realizedPnlSource: string | null
  readonly reportedCurrency: 'USDT'
  readonly fxEvidenceId: null
  readonly fxRateToUsd: null
  readonly lifecycleState: 'closed'
  readonly sourceLifecycleMarker: string
  readonly pnlProvenance: 'source_reported'
  readonly pnlTrustState: 'source_owned' | 'unknown'
  readonly priceProvenance: 'source_reported'
  readonly priceTrustState: 'source_owned' | 'unknown'
  readonly costBasisProvenance: 'source_reported'
  readonly costBasisTrustState: 'source_owned' | 'unknown'
  readonly fxProvenance: 'arena_fx_snapshot'
  readonly fxTrustState: 'unknown'
  readonly authorityMethodVersion: ReviewedSourceContract['authorityMethodVersion']
  readonly declaredBlockerReasons: readonly string[]
  readonly rankEligible: false
}

export interface TokenTradeShadowPlanResult {
  readonly contract: typeof TOKEN_TRADE_SHADOW_PLAN_CONTRACT
  readonly state: TokenTradeShadowPlanState
  readonly persisted: false
  readonly rankEligible: false
  readonly reason: string | null
  readonly sourceRunId: string | null
  readonly acquisitionSourceRunId: string | null
  readonly sourceRawObjectId: number | null
  readonly candidateLedgerSha256: string | null
  readonly factSetSha256: string | null
  readonly observedCandidateCount: number | null
  readonly uniqueSourceFactCount: number | null
  readonly plannedFactCount: number
  readonly unsupportedFactCount: number
  readonly blockerReasons: readonly string[]
  readonly unsupportedFacts: readonly TokenTradeShadowUnsupportedFact[]
  readonly facts: readonly TokenTradeShadowFactPlan[]
}

/**
 * Exact evidence snapshot accepted by the inert shadow planner. This shape
 * does not itself claim a database lock or persistence authority: a future
 * caller must obtain these pointer coordinates from its current transaction.
 * The planner still revalidates the complete @2 artifact and every redundant
 * digest/coordinate before returning any candidate rows.
 */
export interface TokenTradeShadowEvidenceSnapshot {
  readonly contract: typeof POSITION_HISTORY_ACQUISITION_ARTIFACT_V2_CONTRACT
  readonly trustScope: 'acquisition_and_source_facts'
  readonly acquisitionSourceRunId: string
  readonly pointerSnapshot: Readonly<{
    rawObjectId: number
    sourceRunId: string
    storagePath: string
    fetchedAt: string
  }>
  readonly candidateLedgerSha256: string
  readonly artifact: PositionHistoryAcquisitionArtifactV2
}

interface TrustedPlanCoordinates {
  sourceRunId: string
  acquisitionSourceRunId: string
  sourceRawObjectId: number
  candidateLedgerSha256: string
  factSetSha256: string
  observedCandidateCount: number
  uniqueSourceFactCount: number
}

interface ReviewedAssetMapping {
  readonly sourceSymbol: string
  readonly assetId: string
  readonly normalizedToken: ReviewedTicker
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach((item) => deepFreeze(item))
    return Object.freeze(value)
  }
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach((item) => deepFreeze(item))
    return Object.freeze(value)
  }
  return value
}

function sha1Fields(fields: readonly string[]): string {
  return createHash('sha1').update(fields.join('|')).digest('hex')
}

function exactIdentityTuple(value: string, length: number): string[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== length ||
    parsed.some((part) => typeof part !== 'string' || part.length === 0 || part.trim() !== part) ||
    JSON.stringify(parsed) !== value
  ) {
    return null
  }
  return parsed as string[]
}

const BINANCE_CONTRACT: ReviewedSourceContract = Object.freeze({
  sourceSlug: 'binance_futures',
  sourceFactContract: BINANCE_POSITION_HISTORY_SOURCE_FACT_CONTRACT,
  terminalVerifierContract: BINANCE_POSITION_HISTORY_TERMINAL_VERIFIER_CONTRACT,
  authorityContractId: 'binance-futures-position-history@1',
  authorityMethodVersion: 'arena.binance-futures-token-trade-fact@1',
  sourceSymbol: (ticker: ReviewedTicker) => `${ticker}USDT`,
  dedupeHash: (
    sourceFactId: string,
    fact: CanonicalPositionHistorySourceFact,
    exchangeTraderId: string
  ) => {
    const tuple = exactIdentityTuple(sourceFactId, 4)
    if (tuple === null || tuple[0] !== exchangeTraderId || tuple[2] !== fact.symbol) {
      return null
    }
    return sha1Fields(['binance_ph', ...tuple])
  },
})

const OKX_CONTRACT: ReviewedSourceContract = Object.freeze({
  sourceSlug: 'okx_futures',
  sourceFactContract: OKX_POSITION_HISTORY_SOURCE_FACT_CONTRACT,
  terminalVerifierContract: OKX_POSITION_HISTORY_TERMINAL_VERIFIER_CONTRACT,
  authorityContractId: 'okx-futures-position-history@1',
  authorityMethodVersion: 'arena.okx-futures-token-trade-fact@1',
  sourceSymbol: (ticker: ReviewedTicker) => `${ticker}-USDT-SWAP`,
  dedupeHash: (
    sourceFactId: string,
    _fact: CanonicalPositionHistorySourceFact,
    exchangeTraderId: string
  ) => {
    const tuple = exactIdentityTuple(sourceFactId, 2)
    if (tuple === null || tuple[0] !== exchangeTraderId) return null
    return sha1Fields(['okx_ph', ...tuple])
  },
})

const REVIEWED_SOURCE_CONTRACTS: readonly ReviewedSourceContract[] = Object.freeze([
  BINANCE_CONTRACT,
  OKX_CONTRACT,
])

const REVIEWED_ASSET_MAPPINGS: ReadonlyMap<
  string,
  ReadonlyMap<string, ReviewedAssetMapping>
> = new Map(
  REVIEWED_SOURCE_CONTRACTS.map((contract) => [
    contract.sourceSlug,
    new Map(
      REVIEWED_CEX_ASSETS.map(([ticker, assetId]) => {
        const sourceSymbol = contract.sourceSymbol(ticker)
        return [
          sourceSymbol,
          Object.freeze({ sourceSymbol, assetId, normalizedToken: ticker }),
        ] as const
      })
    ),
  ])
)

function sortedBlockers(...values: Array<string | null>): readonly string[] {
  return Object.freeze(
    [...new Set(values.filter((value): value is string => value !== null))].sort()
  )
}

function unavailable(reason: string): TokenTradeShadowPlanResult {
  return deepFreeze({
    contract: TOKEN_TRADE_SHADOW_PLAN_CONTRACT,
    state: 'unavailable',
    persisted: false,
    rankEligible: false,
    reason,
    sourceRunId: null,
    acquisitionSourceRunId: null,
    sourceRawObjectId: null,
    candidateLedgerSha256: null,
    factSetSha256: null,
    observedCandidateCount: null,
    uniqueSourceFactCount: null,
    plannedFactCount: 0,
    unsupportedFactCount: 0,
    blockerReasons: sortedBlockers(DA2_SHADOW_WRITER_CANARY_BLOCKER, reason),
    unsupportedFacts: [],
    facts: [],
  })
}

function resultWithTrustedCoordinates(input: {
  state: Exclude<TokenTradeShadowPlanState, 'unavailable'>
  reason: string | null
  coordinates: TrustedPlanCoordinates
  blockerReasons: readonly string[]
  unsupportedFacts?: readonly TokenTradeShadowUnsupportedFact[]
  facts?: readonly TokenTradeShadowFactPlan[]
}): TokenTradeShadowPlanResult {
  const facts = input.facts ?? []
  const unsupportedFacts = input.unsupportedFacts ?? []
  return deepFreeze({
    contract: TOKEN_TRADE_SHADOW_PLAN_CONTRACT,
    state: input.state,
    persisted: false,
    rankEligible: false,
    reason: input.reason,
    ...input.coordinates,
    plannedFactCount: facts.length,
    unsupportedFactCount: unsupportedFacts.length,
    blockerReasons: [...input.blockerReasons],
    unsupportedFacts: [...unsupportedFacts],
    facts: [...facts],
  })
}

function selectReviewedContract(
  sourceSlug: string,
  sourceFactContract: string,
  terminalVerifierContract: string
): ReviewedSourceContract | null {
  return (
    REVIEWED_SOURCE_CONTRACTS.find(
      (contract) =>
        contract.sourceSlug === sourceSlug &&
        contract.sourceFactContract === sourceFactContract &&
        contract.terminalVerifierContract === terminalVerifierContract
    ) ?? null
  )
}

function exactPositiveScalar(value: number | null, scalar: string | null): string | null {
  return value !== null && value > 0 && scalar !== null ? scalar : null
}

function exactFiniteScalar(value: number | null, scalar: string | null): string | null {
  return value !== null && scalar !== null ? scalar : null
}

/**
 * Build an inert, deterministic DA-2 canary projection from an exact @2 RAW
 * evidence snapshot. This function neither acquires a lock nor performs I/O,
 * and it never accepts runtime-supplied contracts, mappings, trust flags, or
 * clocks. Every planned row remains explicitly unrankable until a later writer
 * binds independently verified history coverage and FX evidence.
 */
export function buildTokenTradeShadowPlan(
  evidence: TokenTradeShadowEvidenceSnapshot
): TokenTradeShadowPlanResult {
  if (
    evidence.contract !== POSITION_HISTORY_ACQUISITION_ARTIFACT_V2_CONTRACT ||
    evidence.trustScope !== 'acquisition_and_source_facts'
  ) {
    return unavailable('locked_evidence_contract_mismatch')
  }
  const pointer = evidence.pointerSnapshot
  if (!Number.isSafeInteger(pointer.rawObjectId) || pointer.rawObjectId <= 0) {
    return unavailable('locked_raw_object_id_invalid')
  }

  const verification = revalidatePositionHistoryAcquisitionArtifactV2({
    artifact: evidence.artifact,
    expectedSourceRunId: pointer.sourceRunId,
  })
  if (!verification.verified) return unavailable(`outer_source_run_invalid:${verification.reason}`)

  const artifact = verification.artifact
  const acquisition = artifact.acquisition
  const ledger = artifact.candidate_ledger
  const expectedFetchedAt = acquisition.pages.at(-1)?.fetched_at ?? acquisition.attempt_started_at
  const expectedStoragePath =
    `${acquisition.source.slug}/history_trust/position_history/${pointer.sourceRunId}/` +
    `event_history_${pointer.sourceRunId}.json.gz`
  if (
    evidence.acquisitionSourceRunId !== artifact.acquisition_source_run_id ||
    ledger.acquisition_source_run_id !== artifact.acquisition_source_run_id ||
    pointer.sourceRunId === artifact.acquisition_source_run_id
  ) {
    return unavailable('nested_source_run_mismatch')
  }
  if (
    evidence.candidateLedgerSha256 !== artifact.candidate_ledger_sha256 ||
    evidence.candidateLedgerSha256 !== verification.candidateLedgerSha256
  ) {
    return unavailable('candidate_ledger_digest_mismatch')
  }
  if (
    pointer.fetchedAt !== expectedFetchedAt ||
    pointer.storagePath !== expectedStoragePath ||
    acquisition.starting_cursor !== null ||
    acquisition.capture_config.caller_page_cap !== null ||
    acquisition.termination.evidence_state !== 'verified' ||
    acquisition.termination.scan_terminal_state !== 'exhausted'
  ) {
    return unavailable('tier_b_cursorless_exhausted_evidence_required')
  }

  const sourceContract = selectReviewedContract(
    acquisition.source.slug,
    ledger.source_fact_contract,
    acquisition.termination.verifier_contract ?? ''
  )
  if (sourceContract === null) return unavailable('source_contract_unavailable')
  const assetMappings = REVIEWED_ASSET_MAPPINGS.get(sourceContract.sourceSlug)
  if (!assetMappings) return unavailable('asset_mapping_registry_unavailable')

  const coordinates: TrustedPlanCoordinates = {
    sourceRunId: pointer.sourceRunId,
    acquisitionSourceRunId: artifact.acquisition_source_run_id,
    sourceRawObjectId: pointer.rawObjectId,
    candidateLedgerSha256: artifact.candidate_ledger_sha256,
    factSetSha256: ledger.fact_set_sha256,
    observedCandidateCount: ledger.observed_candidate_count,
    uniqueSourceFactCount: ledger.unique_source_fact_count,
  }
  const commonBlockers = sortedBlockers(
    DA2_SHADOW_WRITER_CANARY_BLOCKER,
    FX_EVIDENCE_UNAVAILABLE_BLOCKER,
    HISTORY_COVERAGE_UNAVAILABLE_BLOCKER
  )

  if (ledger.source_facts.length === 0) {
    return resultWithTrustedCoordinates({
      state: 'verified_empty',
      reason: 'true_empty_requires_projection_run_receipt',
      coordinates,
      blockerReasons: sortedBlockers(...commonBlockers, PROJECTION_RUN_RECEIPT_REQUIRED_BLOCKER),
    })
  }

  const observedAtMs = Date.parse(pointer.fetchedAt)
  const unsupportedFacts: TokenTradeShadowUnsupportedFact[] = []
  const facts: TokenTradeShadowFactPlan[] = []

  for (const entry of ledger.source_facts) {
    const fact = entry.fact
    if (
      fact.openedAt === null ||
      fact.closedAt === null ||
      fact.symbol === null ||
      fact.sourceLifecycleMarker === null
    ) {
      return unavailable('closed_source_fact_coordinates_missing')
    }
    const openedAtMs = Date.parse(fact.openedAt)
    const closedAtMs = Date.parse(fact.closedAt)
    if (!Number.isFinite(openedAtMs) || !Number.isFinite(closedAtMs) || openedAtMs > closedAtMs) {
      return unavailable('closed_source_fact_time_invalid')
    }
    if (!Number.isFinite(observedAtMs) || closedAtMs > observedAtMs) {
      return unavailable('future_closed_at')
    }

    const mapping = assetMappings.get(fact.symbol)
    if (!mapping) {
      unsupportedFacts.push({ sourceFactId: entry.source_fact_id, sourceSymbol: fact.symbol })
      continue
    }
    const positionDedupeHash = sourceContract.dedupeHash(
      entry.source_fact_id,
      fact,
      acquisition.trader.exchange_trader_id
    )
    if (positionDedupeHash === null) return unavailable('source_fact_identity_invalid')

    const entryPrice = exactPositiveScalar(fact.entryPrice, fact.sourceNumericScalars.entryPrice)
    const exitPrice = exactPositiveScalar(fact.exitPrice, fact.sourceNumericScalars.exitPrice)
    const realizedPnlSource = exactFiniteScalar(
      fact.realizedPnl,
      fact.sourceNumericScalars.realizedPnl
    )
    const declaredBlockerReasons = sortedBlockers(
      ...commonBlockers,
      realizedPnlSource === null ? 'source_realized_pnl_unknown' : null,
      entryPrice === null ? 'source_entry_price_unknown' : null,
      exitPrice === null ? 'source_exit_price_unknown' : null
    )
    facts.push({
      sourceContractId: sourceContract.authorityContractId,
      sourceId: acquisition.source.id,
      traderId: acquisition.trader.id,
      sourceRunId: pointer.sourceRunId,
      sourceRawObjectId: pointer.rawObjectId,
      sourceRowIdentity: entry.source_fact_id,
      canonicalFactSha256: entry.canonical_fact_sha256,
      closedAt: fact.closedAt,
      positionDedupeHash,
      sourceSymbol: fact.symbol,
      sourceAssetLocator: mapping.sourceSymbol,
      assetId: mapping.assetId,
      assetNamespace: 'cex',
      assetChainId: null,
      assetProtocolSlug: null,
      tokenAddress: null,
      normalizedToken: mapping.normalizedToken,
      tokenNormalizationState: 'normalized',
      tokenNormalizationMethodVersion: 'arena.derivative-token-normalization@1',
      openedAt: fact.openedAt,
      entryPrice,
      exitPrice,
      realizedPnlSource,
      reportedCurrency: 'USDT',
      fxEvidenceId: null,
      fxRateToUsd: null,
      lifecycleState: 'closed',
      sourceLifecycleMarker: fact.sourceLifecycleMarker,
      pnlProvenance: 'source_reported',
      pnlTrustState: realizedPnlSource === null ? 'unknown' : 'source_owned',
      priceProvenance: 'source_reported',
      priceTrustState: entryPrice !== null && exitPrice !== null ? 'source_owned' : 'unknown',
      costBasisProvenance: 'source_reported',
      costBasisTrustState: entryPrice === null ? 'unknown' : 'source_owned',
      fxProvenance: 'arena_fx_snapshot',
      fxTrustState: 'unknown',
      authorityMethodVersion: sourceContract.authorityMethodVersion,
      declaredBlockerReasons,
      rankEligible: false,
    })
  }

  if (unsupportedFacts.length > 0) {
    return resultWithTrustedCoordinates({
      state: 'partial',
      reason: UNSUPPORTED_ASSET_MAPPING_BLOCKER,
      coordinates,
      blockerReasons: sortedBlockers(
        ...commonBlockers,
        PROJECTION_RUN_RECEIPT_REQUIRED_BLOCKER,
        UNSUPPORTED_ASSET_MAPPING_BLOCKER
      ),
      unsupportedFacts: unsupportedFacts.sort((left, right) =>
        left.sourceFactId < right.sourceFactId ? -1 : left.sourceFactId > right.sourceFactId ? 1 : 0
      ),
      // Conservation is all-or-nothing: one unsupported candidate suppresses
      // every otherwise mapped row from this run.
      facts: [],
    })
  }

  return resultWithTrustedCoordinates({
    state: 'planned',
    reason: null,
    coordinates,
    blockerReasons: commonBlockers,
    facts,
  })
}
