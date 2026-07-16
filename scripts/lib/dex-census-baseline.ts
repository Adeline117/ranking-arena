/**
 * Read-only DEX public-population baseline.
 *
 * This command discovers public addresses and writes a shadow-only evidence
 * report. It never writes Arena/Supabase serving tables and every emitted
 * canonical identity remains rank_eligible=false via the shared census
 * contract.
 *
 * Usage:
 *   npm run census:dex
 *   npm run census:dex -- --output /tmp/dex-census.json
 *   npm run census:dex -- --stdout
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  DEX_CENSUS_SOURCES,
  assertDexCensusSources,
  buildDexCensusSnapshot,
  canonicalDexIdentity,
  canonicalSha256,
  type DexCensusObservationInput,
  type DexCensusSnapshot,
  type DexCensusSource,
  type DexCensusTimeframe,
  type DexCoverageDenominator,
  type DexWindow,
} from './dex-census'

type JsonRecord = Record<string, unknown>

export interface CensusFetchResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type CensusFetch = (input: string, init?: RequestInit) => Promise<CensusFetchResponse>

export interface DexCensusScanEvidence {
  scan: 1 | 2
  raw_rows: number
  unique_addresses: number
  duplicate_rows: number
  identity_set_sha256: string
}

export interface DexCensusWindowEvidence {
  window: DexWindow
  query_bounds: {
    from_epoch_seconds: number
    to_epoch_seconds: number
    semantics: 'completed_utc_days'
  } | null
  unique_addresses: number
  metric_ready_addresses: number
  truncation_detected: boolean
  repeatable: boolean | null
  scans: DexCensusScanEvidence[]
}

export interface DexCensusSourceEvidence {
  protocol: DexCensusSource['protocol']
  chain_id: number
  network: string
  scope: DexCensusSource['scope']
  completeness_status: DexCensusSource['completeness_status']
  coverage_denominator: DexCoverageDenominator
  observed_unique_addresses: number
  score_window_unique_addresses: number
  metric_ready_unique_addresses: number
  identity_set_sha256: string
  windows: DexCensusWindowEvidence[]
}

export interface DexCoverageDenominatorSummary {
  policy: 'universe_complete_and_eligible_sources_only'
  discovered: number
  metric_ready: number
  included_sources: string[]
  provisional_discovered: number
  excluded_discovered: number
}

export interface DexCensusBaselineReport {
  schema_version: 1
  generated_at: string
  mode: 'shadow_only'
  snapshot_sha256: string
  coverage_denominator: DexCoverageDenominatorSummary
  source_evidence: DexCensusSourceEvidence[]
  snapshot: DexCensusSnapshot
}

interface CollectedSource {
  observations: DexCensusObservationInput[]
  observedAddresses: Set<string>
  metricReadyAddresses: Set<string>
  evidence: DexCensusSourceEvidence
}

export interface DexCensusBaselineOptions {
  generatedAt?: string
  fetch?: CensusFetch
  sources?: readonly DexCensusSource[]
  requestTimeoutMs?: number
  gmxPageSize?: number
  gmxMaxPages?: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_GMX_PAGE_SIZE = 1_000
const DEFAULT_GMX_MAX_PAGES = 100
const SOURCE_CONCURRENCY = 3
const SCORE_WINDOWS = [7, 30, 90] as const
const GMX_METRIC_FIELDS = [
  'realizedPnl',
  'realizedFees',
  'realizedSwapFees',
  'realizedPriceImpact',
  'realizedSwapImpact',
] as const

function sourceKey(source: Pick<DexCensusSource, 'protocol' | 'chain_id'>): string {
  return `${source.protocol}:${source.chain_id}`
}

function compareSources(
  left: Pick<DexCensusSource, 'protocol' | 'chain_id'>,
  right: Pick<DexCensusSource, 'protocol' | 'chain_id'>
): number {
  return sourceKey(left).localeCompare(sourceKey(right))
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'string') return false
  const normalized = value.trim()
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) return false
  return Number.isFinite(Number(normalized))
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return value
}

function normalizedAddress(source: DexCensusSource, value: unknown, context: string): string {
  if (typeof value !== 'string') {
    throw new Error(`[${sourceKey(source)}] ${context} row is missing an address`)
  }
  try {
    return canonicalDexIdentity(source.protocol, source.chain_id, value).address
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`[${sourceKey(source)}] ${context}: ${message}`)
  }
}

function identitySetSha256(addresses: Iterable<string>): string {
  return canonicalSha256([...addresses].sort())
}

function addObservation(
  observations: DexCensusObservationInput[],
  source: DexCensusSource,
  address: string,
  timeframe: DexCensusTimeframe,
  metricReady: boolean
): void {
  observations.push({
    protocol: source.protocol,
    chainId: source.chain_id,
    address,
    timeframe,
    metricReady,
  })
}

async function requestJson(
  fetchImpl: CensusFetch,
  url: string,
  timeoutMs: number,
  init?: RequestInit
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

function hyperliquidPerformance(row: JsonRecord, key: string): JsonRecord | null {
  const performances = row.windowPerformances
  if (Array.isArray(performances)) {
    const match = performances.find(
      (candidate) => Array.isArray(candidate) && candidate[0] === key && isRecord(candidate[1])
    )
    return match ? (match[1] as JsonRecord) : null
  }
  if (isRecord(performances) && isRecord(performances[key])) {
    return performances[key] as JsonRecord
  }
  return null
}

function hyperliquidMetricReady(row: JsonRecord, key: string): boolean {
  const performance = hyperliquidPerformance(row, key)
  return performance !== null && finiteNumber(performance.pnl) && finiteNumber(performance.roi)
}

export async function collectHyperliquidCensus(
  source: DexCensusSource,
  fetchImpl: CensusFetch,
  requestTimeoutMs: number
): Promise<CollectedSource> {
  if (source.protocol !== 'hyperliquid' || source.scope !== 'full_public_file') {
    throw new Error('collectHyperliquidCensus requires the full-file Hyperliquid source')
  }
  const payload = await requestJson(fetchImpl, source.endpoint, requestTimeoutMs, {
    headers: { accept: 'application/json' },
  })
  if (!isRecord(payload) || !Array.isArray(payload.leaderboardRows)) {
    throw new Error(`[${sourceKey(source)}] unexpected full-file leaderboard shape`)
  }
  if (payload.leaderboardRows.length === 0) {
    throw new Error(`[${sourceKey(source)}] full-file leaderboard is unexpectedly empty`)
  }

  const observations: DexCensusObservationInput[] = []
  const observedAddresses = new Set<string>()
  const metricReadyAddresses = new Set<string>()
  const readyByWindow = new Map<DexWindow, Set<string>>([
    ['7D', new Set()],
    ['30D', new Set()],
    ['all_time', new Set()],
  ])
  let duplicateRows = 0

  for (const [index, candidate] of payload.leaderboardRows.entries()) {
    if (!isRecord(candidate)) {
      throw new Error(`[${sourceKey(source)}] full-file row ${index} is not an object`)
    }
    const address = normalizedAddress(
      source,
      candidate.ethAddress ?? candidate.user,
      `row ${index}`
    )
    if (observedAddresses.has(address)) duplicateRows += 1
    observedAddresses.add(address)

    const weekReady = hyperliquidMetricReady(candidate, 'week')
    const monthReady = hyperliquidMetricReady(candidate, 'month')
    const allTimeReady = hyperliquidMetricReady(candidate, 'allTime')
    if (weekReady) readyByWindow.get('7D')!.add(address)
    if (monthReady) readyByWindow.get('30D')!.add(address)
    if (allTimeReady) readyByWindow.get('all_time')!.add(address)
    // allTime is source-completeness evidence, not an Arena score window.
    if (weekReady || monthReady) metricReadyAddresses.add(address)

    addObservation(observations, source, address, 7, weekReady)
    addObservation(observations, source, address, 30, monthReady)
  }

  const scan: DexCensusScanEvidence = {
    scan: 1,
    raw_rows: payload.leaderboardRows.length,
    unique_addresses: observedAddresses.size,
    duplicate_rows: duplicateRows,
    identity_set_sha256: identitySetSha256(observedAddresses),
  }
  const windows: DexCensusWindowEvidence[] = [
    ['7D', readyByWindow.get('7D')!.size],
    ['30D', readyByWindow.get('30D')!.size],
    ['all_time', readyByWindow.get('all_time')!.size],
  ].map(([window, ready]) => ({
    window: window as DexWindow,
    query_bounds: null,
    unique_addresses: observedAddresses.size,
    metric_ready_addresses: Number(ready),
    truncation_detected: false,
    repeatable: null,
    scans: [scan],
  }))

  return {
    observations,
    observedAddresses,
    metricReadyAddresses,
    evidence: {
      protocol: source.protocol,
      chain_id: source.chain_id,
      network: source.network,
      scope: source.scope,
      completeness_status: source.completeness_status,
      coverage_denominator: source.coverage_denominator,
      observed_unique_addresses: observedAddresses.size,
      score_window_unique_addresses: observedAddresses.size,
      metric_ready_unique_addresses: metricReadyAddresses.size,
      identity_set_sha256: identitySetSha256(observedAddresses),
      windows,
    },
  }
}

interface GmxScanResult {
  observations: Map<string, boolean>
  evidence: DexCensusScanEvidence
}

function gmxWindowBounds(timeframe: (typeof SCORE_WINDOWS)[number], generatedAt: string) {
  const to = Math.floor(Date.parse(generatedAt) / 86_400_000) * 86_400
  return { from: to - timeframe * 86_400, to }
}

function gmxCensusQuery(input: {
  limit: number
  offset: number
  from: number
  to: number
}): string {
  const { limit, offset, from, to } = input
  return `
  query DexCensus {
    periodAccountStats(
      limit: ${limit}
      offset: ${offset}
      where: { from: ${from}, to: ${to}, maxCapital_gte: "0" }
    ) {
      id
      realizedPnl
      realizedFees
      realizedSwapFees
      realizedPriceImpact
      realizedSwapImpact
    }
  }
`
}

async function scanGmxWindow(input: {
  source: DexCensusSource
  timeframe: (typeof SCORE_WINDOWS)[number]
  generatedAt: string
  scan: 1 | 2
  fetchImpl: CensusFetch
  requestTimeoutMs: number
  pageSize: number
  maxPages: number
}): Promise<GmxScanResult> {
  const { source, timeframe, generatedAt, scan, fetchImpl, requestTimeoutMs, pageSize, maxPages } =
    input
  const observations = new Map<string, boolean>()
  let rawRows = 0
  let duplicateRows = 0
  const { from, to } = gmxWindowBounds(timeframe, generatedAt)

  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * pageSize
    const payload = await requestJson(fetchImpl, source.endpoint, requestTimeoutMs, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        // Mirror the verified production adapter's inline scalar form. The
        // Squids schema's scalar type names are not part of this contract.
        query: gmxCensusQuery({ limit: pageSize, offset, from, to }),
      }),
    })
    if (!isRecord(payload)) {
      throw new Error(`[${sourceKey(source)}] GMX ${timeframe}D scan ${scan} returned no object`)
    }
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      const first = payload.errors[0]
      const message =
        isRecord(first) && typeof first.message === 'string' ? first.message : 'unknown'
      throw new Error(`[${sourceKey(source)}] GMX GraphQL error: ${message}`)
    }
    if (!isRecord(payload.data) || !Array.isArray(payload.data.periodAccountStats)) {
      throw new Error(`[${sourceKey(source)}] GMX ${timeframe}D scan ${scan} has invalid data`)
    }
    const rows = payload.data.periodAccountStats
    if (rows.length > pageSize) {
      throw new Error(`[${sourceKey(source)}] GMX page exceeded requested limit`)
    }
    rawRows += rows.length
    for (const [rowIndex, candidate] of rows.entries()) {
      if (!isRecord(candidate)) {
        throw new Error(
          `[${sourceKey(source)}] GMX ${timeframe}D page ${page} row ${rowIndex} is invalid`
        )
      }
      const address = normalizedAddress(
        source,
        candidate.id,
        `${timeframe}D scan ${scan} page ${page} row ${rowIndex}`
      )
      const metricReady = GMX_METRIC_FIELDS.every((field) => finiteNumber(candidate[field]))
      if (observations.has(address)) duplicateRows += 1
      observations.set(address, (observations.get(address) ?? false) || metricReady)
    }
    if (rows.length < pageSize) {
      if (duplicateRows > 0) {
        throw new Error(
          `[${sourceKey(source)}] GMX ${timeframe}D scan ${scan} pagination drift ` +
            `(duplicate_rows=${duplicateRows})`
        )
      }
      return {
        observations,
        evidence: {
          scan,
          raw_rows: rawRows,
          unique_addresses: observations.size,
          duplicate_rows: duplicateRows,
          identity_set_sha256: identitySetSha256(observations.keys()),
        },
      }
    }
  }

  throw new Error(
    `[${sourceKey(source)}] GMX ${timeframe}D scan ${scan} hit the ${maxPages}-page guard limit`
  )
}

function assertRepeatableGmxScan(
  source: DexCensusSource,
  timeframe: number,
  first: GmxScanResult,
  second: GmxScanResult
): void {
  const metricReadyChanges = [...first.observations].filter(
    ([address, ready]) => second.observations.get(address) !== ready
  ).length
  if (
    first.evidence.identity_set_sha256 !== second.evidence.identity_set_sha256 ||
    metricReadyChanges > 0
  ) {
    const onlyFirst = [...first.observations.keys()].filter(
      (address) => !second.observations.has(address)
    ).length
    const onlySecond = [...second.observations.keys()].filter(
      (address) => !first.observations.has(address)
    ).length
    throw new Error(
      `[${sourceKey(source)}] GMX ${timeframe}D double-scan drift ` +
        `(only_first=${onlyFirst}, only_second=${onlySecond}, ` +
        `metric_ready_changes=${metricReadyChanges})`
    )
  }
}

export async function collectGmxCensus(
  source: DexCensusSource,
  fetchImpl: CensusFetch,
  generatedAt: string,
  requestTimeoutMs: number,
  pageSize: number,
  maxPages: number
): Promise<CollectedSource> {
  if (source.protocol !== 'gmx' || source.scope !== 'active_period_stats_offset_scan') {
    throw new Error('collectGmxCensus requires a GMX offset-scan source')
  }
  const observations: DexCensusObservationInput[] = []
  const observedAddresses = new Set<string>()
  const metricReadyAddresses = new Set<string>()
  const windows: DexCensusWindowEvidence[] = []

  for (const timeframe of SCORE_WINDOWS) {
    const first = await scanGmxWindow({
      source,
      timeframe,
      generatedAt,
      scan: 1,
      fetchImpl,
      requestTimeoutMs,
      pageSize,
      maxPages,
    })
    const second = await scanGmxWindow({
      source,
      timeframe,
      generatedAt,
      scan: 2,
      fetchImpl,
      requestTimeoutMs,
      pageSize,
      maxPages,
    })
    assertRepeatableGmxScan(source, timeframe, first, second)

    let metricReady = 0
    for (const [address, ready] of first.observations) {
      observedAddresses.add(address)
      if (ready) {
        metricReady += 1
        metricReadyAddresses.add(address)
      }
      addObservation(observations, source, address, timeframe, ready)
    }
    const bounds = gmxWindowBounds(timeframe, generatedAt)
    windows.push({
      window: `${timeframe}D` as DexWindow,
      query_bounds: {
        from_epoch_seconds: bounds.from,
        to_epoch_seconds: bounds.to,
        semantics: 'completed_utc_days',
      },
      unique_addresses: first.observations.size,
      metric_ready_addresses: metricReady,
      // The entity id is unique for a period. Seeing it at two offsets means
      // the unordered result moved underneath pagination, even if de-duping
      // and the second scan happen to recover the same final set.
      truncation_detected: first.evidence.duplicate_rows > 0 || second.evidence.duplicate_rows > 0,
      repeatable: true,
      scans: [first.evidence, second.evidence],
    })
  }

  return {
    observations,
    observedAddresses,
    metricReadyAddresses,
    evidence: {
      protocol: source.protocol,
      chain_id: source.chain_id,
      network: source.network,
      scope: source.scope,
      completeness_status: source.completeness_status,
      coverage_denominator: source.coverage_denominator,
      observed_unique_addresses: observedAddresses.size,
      score_window_unique_addresses: observedAddresses.size,
      metric_ready_unique_addresses: metricReadyAddresses.size,
      identity_set_sha256: identitySetSha256(observedAddresses),
      windows,
    },
  }
}

function gtradeMetricReady(row: JsonRecord): boolean {
  return finiteNumber(row.total_pnl_usd ?? row.total_pnl) && finiteNumber(row.count)
}

export async function collectGtradeCensus(
  source: DexCensusSource,
  fetchImpl: CensusFetch,
  requestTimeoutMs: number
): Promise<CollectedSource> {
  if (source.protocol !== 'gtrade' || source.scope !== 'public_top25_board') {
    throw new Error('collectGtradeCensus requires a bounded gTrade board source')
  }
  const payload = await requestJson(fetchImpl, source.endpoint, requestTimeoutMs, {
    headers: { accept: 'application/json' },
  })
  if (!isRecord(payload)) {
    throw new Error(`[${sourceKey(source)}] unexpected gTrade leaderboard shape`)
  }

  const observations: DexCensusObservationInput[] = []
  const observedAddresses = new Set<string>()
  const scoreWindowAddresses = new Set<string>()
  const metricReadyAddresses = new Set<string>()
  const windows: DexCensusWindowEvidence[] = []
  const windowMappings = [
    ['1D', '1', 1],
    ['7D', '7', 7],
    ['30D', '30', 30],
    ['90D', '90', 90],
  ] as const

  for (const [window, upstreamKey, timeframe] of windowMappings) {
    const candidates = payload[upstreamKey]
    if (!Array.isArray(candidates)) {
      throw new Error(`[${sourceKey(source)}] gTrade ${window} board is missing`)
    }
    if (candidates.length > 25) {
      throw new Error(`[${sourceKey(source)}] gTrade ${window} board exceeded the Top-25 contract`)
    }
    const addresses = new Map<string, boolean>()
    let duplicateRows = 0
    for (const [index, candidate] of candidates.entries()) {
      if (!isRecord(candidate)) {
        throw new Error(`[${sourceKey(source)}] gTrade ${window} row ${index} is invalid`)
      }
      const address = normalizedAddress(source, candidate.address, `${window} row ${index}`)
      const ready = gtradeMetricReady(candidate)
      if (addresses.has(address)) duplicateRows += 1
      addresses.set(address, (addresses.get(address) ?? false) || ready)
      observedAddresses.add(address)
      if (timeframe !== 1) {
        scoreWindowAddresses.add(address)
        if (ready) metricReadyAddresses.add(address)
      }
      // Preserve 1D-only discoveries in the canonical population snapshot,
      // but never count a non-score window as metric-ready for Arena ranking.
      addObservation(observations, source, address, timeframe, timeframe === 1 ? false : ready)
    }
    const readyCount = [...addresses.values()].filter(Boolean).length
    windows.push({
      window,
      query_bounds: null,
      unique_addresses: addresses.size,
      metric_ready_addresses: readyCount,
      truncation_detected: candidates.length === 25,
      repeatable: null,
      scans: [
        {
          scan: 1,
          raw_rows: candidates.length,
          unique_addresses: addresses.size,
          duplicate_rows: duplicateRows,
          identity_set_sha256: identitySetSha256(addresses.keys()),
        },
      ],
    })
  }

  return {
    observations,
    observedAddresses,
    metricReadyAddresses,
    evidence: {
      protocol: source.protocol,
      chain_id: source.chain_id,
      network: source.network,
      scope: source.scope,
      completeness_status: source.completeness_status,
      coverage_denominator: source.coverage_denominator,
      observed_unique_addresses: observedAddresses.size,
      score_window_unique_addresses: scoreWindowAddresses.size,
      metric_ready_unique_addresses: metricReadyAddresses.size,
      identity_set_sha256: identitySetSha256(observedAddresses),
      windows,
    },
  }
}

function summarizeCoverageDenominator(collected: readonly CollectedSource[]) {
  const summary: DexCoverageDenominatorSummary = {
    policy: 'universe_complete_and_eligible_sources_only',
    discovered: 0,
    metric_ready: 0,
    included_sources: [],
    provisional_discovered: 0,
    excluded_discovered: 0,
  }
  for (const result of collected) {
    const evidence = result.evidence
    if (evidence.coverage_denominator === 'eligible') {
      summary.discovered += result.observedAddresses.size
      summary.metric_ready += result.metricReadyAddresses.size
      summary.included_sources.push(sourceKey(evidence))
    } else if (evidence.coverage_denominator === 'provisional') {
      summary.provisional_discovered += result.observedAddresses.size
    } else {
      summary.excluded_discovered += result.observedAddresses.size
    }
  }
  summary.included_sources.sort()
  return summary
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  collect: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  let stopped = false
  const worker = async () => {
    while (!stopped && nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        results[index] = await collect(values[index])
      } catch (error) {
        stopped = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()))
  return results
}

export async function runDexCensusBaseline(
  options: DexCensusBaselineOptions = {}
): Promise<DexCensusBaselineReport> {
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  const generatedAtMs = Date.parse(generatedAt)
  if (!Number.isFinite(generatedAtMs) || new Date(generatedAtMs).toISOString() !== generatedAt) {
    throw new Error(`generatedAt must be a canonical ISO timestamp: ${generatedAt}`)
  }
  const requestTimeoutMs = requirePositiveInteger(
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    'requestTimeoutMs'
  )
  const gmxPageSize = requirePositiveInteger(
    options.gmxPageSize ?? DEFAULT_GMX_PAGE_SIZE,
    'gmxPageSize'
  )
  const gmxMaxPages = requirePositiveInteger(
    options.gmxMaxPages ?? DEFAULT_GMX_MAX_PAGES,
    'gmxMaxPages'
  )
  const sources = [...(options.sources ?? DEX_CENSUS_SOURCES)].sort(compareSources)
  // Validate the complete allowlist/completeness contract before the first
  // network request. Test-only source subsets still use the same gate.
  assertDexCensusSources(sources)
  if (!options.fetch && typeof globalThis.fetch !== 'function') {
    throw new Error('global fetch is unavailable')
  }
  const fetchImpl: CensusFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))

  // Every collector is internally sequential. A source-level bound of three
  // avoids a five-request burst to gTrade's shared host while still allowing
  // independent GMX networks and the Hyperliquid file to overlap.
  const collected = await mapWithConcurrency(sources, SOURCE_CONCURRENCY, (source) => {
    if (source.protocol === 'hyperliquid') {
      return collectHyperliquidCensus(source, fetchImpl, requestTimeoutMs)
    }
    if (source.protocol === 'gmx') {
      return collectGmxCensus(
        source,
        fetchImpl,
        generatedAt,
        requestTimeoutMs,
        gmxPageSize,
        gmxMaxPages
      )
    }
    return collectGtradeCensus(source, fetchImpl, requestTimeoutMs)
  })
  collected.sort((left, right) => compareSources(left.evidence, right.evidence))

  const { snapshot, sha256 } = buildDexCensusSnapshot({
    generatedAt,
    observations: collected.flatMap((result) => result.observations),
    sources,
  })
  return {
    schema_version: 1,
    generated_at: generatedAt,
    mode: 'shadow_only',
    snapshot_sha256: sha256,
    coverage_denominator: summarizeCoverageDenominator(collected),
    source_evidence: collected.map((result) => result.evidence),
    snapshot,
  }
}

interface CliOptions extends DexCensusBaselineOptions {
  output: string | null
}

function parseCliOptions(args: string[]): CliOptions {
  const options: CliOptions = { output: 'scripts/output/dex-census-baseline.json' }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const next = () => {
      const value = args[index + 1]
      if (!value) throw new Error(`${arg} requires a value`)
      index += 1
      return value
    }
    if (arg === '--stdout') options.output = null
    else if (arg === '--output') options.output = next()
    else if (arg === '--generated-at') options.generatedAt = next()
    else if (arg === '--timeout-ms') options.requestTimeoutMs = Number(next())
    else if (arg === '--gmx-page-size') options.gmxPageSize = Number(next())
    else if (arg === '--gmx-max-pages') options.gmxMaxPages = Number(next())
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function writeReportAtomically(output: string, report: DexCensusBaselineReport): string {
  const absolute = resolve(output)
  mkdirSync(dirname(absolute), { recursive: true })
  const temporary = `${absolute}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  renameSync(temporary, absolute)
  return absolute
}

export async function runDexCensusBaselineCli(args: string[] = process.argv.slice(2)) {
  const options = parseCliOptions(args)
  const report = await runDexCensusBaseline(options)
  if (options.output === null) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }
  const output = writeReportAtomically(options.output, report)
  process.stdout.write(
    `DEX census baseline: ${output}\n` +
      `snapshot_sha256=${report.snapshot_sha256}\n` +
      `eligible_denominator=${report.coverage_denominator.discovered} ` +
      `provisional=${report.coverage_denominator.provisional_discovered} ` +
      `excluded=${report.coverage_denominator.excluded_discovered}\n`
  )
}
