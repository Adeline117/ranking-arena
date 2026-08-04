import type { RawPage, SourceRow, Timeframe } from './core/types'
import { strictCanonicalJson, strictCanonicalSha256 } from './strict-canonical-json'

export const COPIER_SNAPSHOT_ARTIFACT_CONTRACT = 'arena.ingest.copier-snapshot-artifact@1' as const
export const COPIER_SNAPSHOT_RAW_ARTIFACT_ROLE = 'copier_snapshot' as const

export type CopierSnapshotLane = 'tier_b' | 'tier_c'
export type CopierSnapshotTerminalState = 'stream_exhausted_unverified' | 'caller_limited'
export type CopierSnapshotSourceDepth = Exclude<SourceRow['copier_table_depth'], 'none'>

export interface CopierSnapshotArtifact {
  readonly contract: typeof COPIER_SNAPSHOT_ARTIFACT_CONTRACT
  readonly source: Readonly<{
    id: number
    slug: string
    currency: SourceRow['currency']
    copier_table_depth: CopierSnapshotSourceDepth
    fetch_region: SourceRow['fetch_region']
  }>
  readonly trader: Readonly<{
    id: number
    exchange_trader_id: string
  }>
  readonly lane: CopierSnapshotLane
  readonly request_timeframe: Timeframe | null
  readonly observed_at: string
  readonly page_count: number
  readonly scan_terminal_state: CopierSnapshotTerminalState
  readonly caller_limited: boolean
  /** No reviewed cross-source extractor exists yet. Never infer this from rows. */
  readonly source_reported_row_count: null
  readonly pages: readonly Readonly<RawPage>[]
}

export interface BuildCopierSnapshotArtifactInput {
  src: SourceRow
  traderId: number
  exchangeTraderId: string
  lane: CopierSnapshotLane
  requestTimeframe: Timeframe | null
  pages: readonly RawPage[]
  callerLimited: boolean
}

function artifactError(detail: string): Error {
  return new Error(`[ingest] copier snapshot artifact failed: ${detail}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonicalInstant(value: unknown, label: string): string {
  if (typeof value !== 'string') throw artifactError(`${label} must be an ISO timestamp`)
  const epochMs = Date.parse(value)
  if (!Number.isFinite(epochMs) || new Date(epochMs).toISOString() !== value) {
    throw artifactError(`${label} must be a canonical ISO timestamp`)
  }
  return value
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function assertCoordinate(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw artifactError(`${label} must be a positive safe integer`)
  }
}

function isCopierSnapshotSourceDepth(
  value: SourceRow['copier_table_depth']
): value is CopierSnapshotSourceDepth {
  return value === 'full' || value === 'top10' || value === 'top3_preview'
}

function normalizePage(page: RawPage, ordinal: number): RawPage {
  if (typeof page !== 'object' || page === null || Array.isArray(page)) {
    throw artifactError(`page ${ordinal} must be an object`)
  }
  if (!Number.isSafeInteger(page.pageIndex) || page.pageIndex <= 0) {
    throw artifactError(`page ${ordinal} has an invalid page index`)
  }
  if (
    typeof page.url !== 'string' ||
    page.url !== page.url.trim() ||
    page.url.length < 1 ||
    page.url.length > 4096
  ) {
    throw artifactError(`page ${ordinal} has an invalid URL`)
  }
  return {
    pageIndex: page.pageIndex,
    payload: page.payload,
    url: page.url,
    fetchedAt: canonicalInstant(page.fetchedAt, `page ${ordinal} fetchedAt`),
  }
}

/**
 * Build the exact replay artifact before Storage I/O. The parser projection is
 * intentionally absent: RAW proves what was captured, while the database
 * publication writer owns row conservation and its versioned row hashes.
 */
export function buildCopierSnapshotArtifact(
  input: BuildCopierSnapshotArtifactInput
): CopierSnapshotArtifact {
  const sourceDepth = input.src.copier_table_depth
  assertCoordinate(input.src.id, 'source id')
  assertCoordinate(input.traderId, 'trader id')
  if (
    input.src.status !== 'active' ||
    input.src.serving_mode !== 'serving' ||
    !isCopierSnapshotSourceDepth(sourceDepth)
  ) {
    throw artifactError('source must be active serving with a copier surface')
  }
  if (!/^[a-z0-9][a-z0-9_]{0,127}$/.test(input.src.slug)) {
    throw artifactError('source slug is invalid')
  }
  if (!['USDT', 'USDx', 'USDC', 'USD'].includes(input.src.currency)) {
    throw artifactError('source currency is invalid')
  }
  if (!['local', 'vps_sg', 'vps_jp'].includes(input.src.fetch_region)) {
    throw artifactError('source fetch region is invalid')
  }
  if (
    typeof input.exchangeTraderId !== 'string' ||
    input.exchangeTraderId !== input.exchangeTraderId.trim() ||
    input.exchangeTraderId.length < 1 ||
    input.exchangeTraderId.length > 512
  ) {
    throw artifactError('exchange trader id is invalid')
  }
  if (input.lane !== 'tier_b' && input.lane !== 'tier_c') {
    throw artifactError('lane is invalid')
  }
  if (typeof input.callerLimited !== 'boolean') {
    throw artifactError('caller-limited state is invalid')
  }
  if (input.lane === 'tier_b') {
    if (input.requestTimeframe !== null || input.callerLimited) {
      throw artifactError('Tier-B must be unbounded and timeframe-independent')
    }
  } else if (![0, 7, 30, 90].includes(input.requestTimeframe as number)) {
    throw artifactError('Tier-C request timeframe is invalid')
  }
  if (!Array.isArray(input.pages) || input.pages.length < 1 || input.pages.length > 100000) {
    throw artifactError('capture must contain between 1 and 100000 pages')
  }

  const pages = input.pages.map((page, index) => normalizePage(page, index + 1))
  for (let index = 1; index < pages.length; index += 1) {
    if (Date.parse(pages[index].fetchedAt) < Date.parse(pages[index - 1].fetchedAt)) {
      throw artifactError('page capture clocks must be nondecreasing')
    }
  }
  const observedAt = pages[pages.length - 1].fetchedAt
  const callerLimited = input.callerLimited
  const artifact = {
    contract: COPIER_SNAPSHOT_ARTIFACT_CONTRACT,
    source: {
      id: input.src.id,
      slug: input.src.slug,
      currency: input.src.currency,
      copier_table_depth: sourceDepth,
      fetch_region: input.src.fetch_region,
    },
    trader: {
      id: input.traderId,
      exchange_trader_id: input.exchangeTraderId,
    },
    lane: input.lane,
    request_timeframe: input.requestTimeframe,
    observed_at: observedAt,
    page_count: pages.length,
    scan_terminal_state: callerLimited
      ? ('caller_limited' as const)
      : ('stream_exhausted_unverified' as const),
    caller_limited: callerLimited,
    source_reported_row_count: null,
    pages,
  } satisfies CopierSnapshotArtifact

  try {
    return deepFreeze(JSON.parse(strictCanonicalJson(artifact)) as CopierSnapshotArtifact)
  } catch (cause) {
    throw artifactError(
      `artifact is not strict canonical JSON: ${cause instanceof Error ? cause.message : String(cause)}`
    )
  }
}

export function copierSnapshotSourceRunId(artifact: CopierSnapshotArtifact): string {
  return strictCanonicalSha256(artifact)
}

/** Rebuild and byte-compare an untrusted value before any RAW side effect. */
export function revalidateCopierSnapshotArtifact(value: unknown): CopierSnapshotArtifact {
  if (!isRecord(value) || value.contract !== COPIER_SNAPSHOT_ARTIFACT_CONTRACT) {
    throw artifactError('artifact contract is invalid')
  }
  if (!isRecord(value.source) || !isRecord(value.trader) || !Array.isArray(value.pages)) {
    throw artifactError('artifact coordinates or pages are malformed')
  }

  const rebuilt = buildCopierSnapshotArtifact({
    src: {
      id: value.source.id,
      slug: value.source.slug,
      currency: value.source.currency,
      copier_table_depth: value.source.copier_table_depth,
      fetch_region: value.source.fetch_region,
      status: 'active',
      serving_mode: 'serving',
    } as SourceRow,
    traderId: value.trader.id as number,
    exchangeTraderId: value.trader.exchange_trader_id as string,
    lane: value.lane as CopierSnapshotLane,
    requestTimeframe: value.request_timeframe as Timeframe | null,
    pages: value.pages as RawPage[],
    callerLimited: value.caller_limited as boolean,
  })

  let exact = false
  try {
    exact = strictCanonicalJson(value) === strictCanonicalJson(rebuilt)
  } catch {
    exact = false
  }
  if (!exact) throw artifactError('artifact is not the exact canonical contract')
  return rebuilt
}
