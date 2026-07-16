/**
 * Shared contract for wallet metrics reconstructed from public chain activity.
 * This module is deliberately dependency-free so ingest, scoring boundaries,
 * and client UI all enforce the same canonical-data gate.
 */

export const ONCHAIN_METHODOLOGY = 'wallet-balance-delta-average-cost' as const
export const ONCHAIN_METHODOLOGY_VERSION = '1.0.0' as const
export const ONCHAIN_QUALITY_SCHEMA_VERSION = 1 as const
export const MIN_ONCHAIN_SCORE_HISTORY_DAYS = 90

export type OnchainQualityReason =
  | 'opening_inventory_unknown'
  | 'history_scan_not_proven_complete'
  | 'historical_native_quote_not_execution_priced'
  | 'generic_balance_delta_decoder'
  | 'internal_transfer_coverage_unknown'

export interface OnchainQuality {
  schemaVersion: typeof ONCHAIN_QUALITY_SCHEMA_VERSION
  methodology: typeof ONCHAIN_METHODOLOGY
  methodologyVersion: typeof ONCHAIN_METHODOLOGY_VERSION
  completeness: 'partial' | 'complete'
  priceQuality: 'non_historical_approx' | 'historical_execution'
  scoreEligible: boolean
  reasons: OnchainQualityReason[]
  history: {
    requestedDays: number
    scanComplete: boolean | null
    truncated: boolean | null
    recordsFetched: number
    txsFetched: number | null
    swapsDecoded: number
  }
  pricing: { pricedTokens: number; unpricedTokens: number }
}

export interface StoredOnchainQuality {
  legacy: boolean
  canonical: boolean
  completeness: 'partial' | 'complete' | 'unknown'
  priceQuality: 'non_historical_approx' | 'historical_execution' | 'unknown'
  scoreEligible: boolean
  reasons: string[]
  requestedDays: number | null
  scanComplete: boolean | null
  truncated: boolean | null
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Legacy/malformed enrichment must be recomputed even when it has a fresh timestamp. */
export function hasCurrentStoredOnchainQualitySchema(extras: Record<string, unknown>): boolean {
  const raw = objectOrNull(extras.onchain_quality)
  return (
    raw?.schema_version === ONCHAIN_QUALITY_SCHEMA_VERSION &&
    raw.methodology === ONCHAIN_METHODOLOGY &&
    raw.methodology_version === ONCHAIN_METHODOLOGY_VERSION
  )
}

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/** A boolean flag alone can never promote an incomplete methodology. */
export function isOnchainQualityCanonical(q: OnchainQuality): boolean {
  return (
    q.scoreEligible &&
    q.completeness === 'complete' &&
    q.priceQuality === 'historical_execution' &&
    q.history.requestedDays >= MIN_ONCHAIN_SCORE_HISTORY_DAYS &&
    q.history.scanComplete === true &&
    q.history.truncated === false &&
    q.reasons.length === 0
  )
}

/** Parse the snake_case JSONB contract conservatively; malformed = ineligible. */
export function readStoredOnchainQuality(
  extras: Record<string, unknown>
): StoredOnchainQuality | null {
  const raw = objectOrNull(extras.onchain_quality)
  if (raw) {
    const history = objectOrNull(raw.history)
    const parsedReasons =
      Array.isArray(raw.reasons) && raw.reasons.every((reason) => typeof reason === 'string')
        ? (raw.reasons as string[])
        : null
    const contractMetadataValid =
      raw.schema_version === ONCHAIN_QUALITY_SCHEMA_VERSION &&
      raw.methodology === ONCHAIN_METHODOLOGY &&
      raw.methodology_version === ONCHAIN_METHODOLOGY_VERSION
    const topLevelMethodologyValid =
      !Object.prototype.hasOwnProperty.call(extras, 'onchain_methodology') ||
      extras.onchain_methodology === `${ONCHAIN_METHODOLOGY}@${ONCHAIN_METHODOLOGY_VERSION}`
    const limitationsValid =
      !Object.prototype.hasOwnProperty.call(extras, 'onchain_limitations') ||
      (Array.isArray(extras.onchain_limitations) && extras.onchain_limitations.length === 0)
    const completeness =
      raw.completeness === 'partial' || raw.completeness === 'complete'
        ? raw.completeness
        : 'unknown'
    const priceQuality =
      raw.price_quality === 'non_historical_approx' || raw.price_quality === 'historical_execution'
        ? raw.price_quality
        : 'unknown'
    const parsed: StoredOnchainQuality = {
      legacy: false,
      canonical: false,
      completeness,
      priceQuality,
      scoreEligible: raw.score_eligible === true,
      reasons: parsedReasons ? [...parsedReasons] : ['quality_reasons_invalid'],
      requestedDays: finiteOrNull(history?.requested_days),
      scanComplete: typeof history?.scan_complete === 'boolean' ? history.scan_complete : null,
      truncated: typeof history?.truncated === 'boolean' ? history.truncated : null,
    }
    parsed.canonical =
      contractMetadataValid &&
      topLevelMethodologyValid &&
      limitationsValid &&
      parsed.scoreEligible &&
      (!Object.prototype.hasOwnProperty.call(extras, 'onchain_score_eligible') ||
        extras.onchain_score_eligible === true) &&
      parsed.completeness === 'complete' &&
      parsed.priceQuality === 'historical_execution' &&
      parsed.requestedDays !== null &&
      parsed.requestedDays >= MIN_ONCHAIN_SCORE_HISTORY_DAYS &&
      parsed.scanComplete === true &&
      parsed.truncated === false &&
      raw.realized_partial === false &&
      extras.onchain_realized_partial !== true &&
      parsed.reasons.length === 0
    return parsed
  }

  const hasLegacyOnchainData =
    extras.onchain_derivation === 'onchain-computed' ||
    Object.keys(extras).some((key) => key.startsWith('onchain_'))
  if (!hasLegacyOnchainData) return null

  return {
    legacy: true,
    canonical: false,
    completeness: 'unknown',
    priceQuality: 'unknown',
    scoreEligible: false,
    reasons: ['legacy_quality_unknown'],
    requestedDays: null,
    scanComplete: null,
    truncated: null,
  }
}

/** Stored JSONB must satisfy every canonical gate before alias promotion. */
export function isStoredOnchainMetricEligible(extras: Record<string, unknown>): boolean {
  const q = readStoredOnchainQuality(extras)
  return Boolean(q?.canonical)
}
