import { isPublicRankingSourceAllowed } from '@/lib/rankings/publication-policy'
import {
  type LeaderboardPublicationSeason,
  type SealedLeaderboardPublicationProofSet,
  LEADERBOARD_PUBLICATION_PROOFS_MAX_TRADERS,
} from '@/lib/rankings/read-publication-proofs'
import {
  readSealedRankingAuthorityGeneration,
  readSealedRankingGeneration,
  SealedRankingSourceOutsideAuthorityError,
} from '@/lib/rankings/read-sealed-ranking-generation'
import {
  createSupabaseRestRpcClient,
  type SupabaseRestRpcClient,
} from '@/lib/rankings/supabase-rest-rpc-client'

const READ_TIMEOUT_MS = 4_000
const MAX_LOOKUP_ROWS = 100
const LOOKUP_ROW_LIMIT = MAX_LOOKUP_ROWS + 1
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/
const ETH_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/
const SEASONS: readonly LeaderboardPublicationSeason[] = ['90D', '30D', '7D']

type RestTable = 'leaderboard_ranks' | 'trader_sources'

export interface EdgePublicTraderRankingConfig {
  readonly supabaseUrl: string
  readonly serviceRoleKey: string
  readonly fetchImpl?: typeof fetch
}

export interface EdgePublicTraderRankingInput {
  readonly handle: string
  readonly source?: string
}

export interface EdgePublicTraderRanking {
  readonly handle: string | null
  readonly avatarUrl: string | null
  readonly source: string
  readonly sourceTraderId: string
  readonly season: LeaderboardPublicationSeason | null
  readonly rank: number | null
  readonly arenaScore: number | null
  readonly roi: number | null
  readonly pnl: number | null
  readonly winRate: number | null
  readonly maxDrawdown: number | null
}

interface TraderIdentity {
  readonly handle: string | null
  readonly avatarUrl: string | null
  readonly source: string
  readonly sourceTraderId: string
}

interface PublishedRank extends TraderIdentity {
  readonly season: LeaderboardPublicationSeason
  readonly rank: number
  readonly arenaScore: number
  readonly roi: number | null
  readonly pnl: number | null
  readonly winRate: number | null
  readonly maxDrawdown: number | null
}

interface SeasonLookup {
  readonly identities: readonly TraderIdentity[]
  readonly ranks: readonly PublishedRank[]
}

function requireLookupHandle(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    value.trim() !== value ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new TypeError('public trader ranking handle is invalid')
  }
  return ETH_ADDRESS_PATTERN.test(value) ? value.toLowerCase() : value
}

function requireSourceHint(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value ||
    !isPublicRankingSourceAllowed(value)
  ) {
    throw new TypeError('public trader ranking source is invalid')
  }
  return value
}

function normalizedRestBaseUrl(value: string): string {
  return new URL(value).href.replace(/\/+$/, '')
}

async function readRestRows(
  config: Required<EdgePublicTraderRankingConfig>,
  baseUrl: string,
  table: RestTable,
  filters: Readonly<Record<string, string>>
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) params.set(key, value)
  params.set('limit', String(LOOKUP_ROW_LIMIT))

  const response = await config.fetchImpl(`${baseUrl}/rest/v1/${table}?${params.toString()}`, {
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
    },
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`public trader ranking REST read failed with status ${response.status}`)
  }

  const payload: unknown = await response.json()
  if (!Array.isArray(payload)) {
    throw new TypeError('public trader ranking REST read returned a non-array payload')
  }
  if (payload.length > MAX_LOOKUP_ROWS) {
    throw new Error('public trader ranking lookup is ambiguous')
  }
  if (payload.some((row) => row === null || typeof row !== 'object' || Array.isArray(row))) {
    throw new TypeError('public trader ranking REST read returned an invalid row')
  }
  return payload as Record<string, unknown>[]
}

function proofSources(publication: SealedLeaderboardPublicationProofSet): readonly string[] {
  return publication.proofs.map((proof) => proof.source)
}

function sourceFilter(sources: readonly string[]): string {
  return sources.length === 1 ? `eq.${sources[0]}` : `in.(${sources.join(',')})`
}

function identityKey(identity: Pick<TraderIdentity, 'source' | 'sourceTraderId'>): string {
  return `${identity.source}\u0000${identity.sourceTraderId}`
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function optionalFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseIdentity(
  row: Record<string, unknown>,
  lookup: string,
  allowedSources: ReadonlySet<string>
): TraderIdentity | null {
  const source = row.source
  const sourceTraderId = row.source_trader_id
  const handle = optionalString(row.handle)
  if (
    typeof source !== 'string' ||
    typeof sourceTraderId !== 'string' ||
    sourceTraderId.length === 0 ||
    !allowedSources.has(source) ||
    !isPublicRankingSourceAllowed(source) ||
    (handle !== lookup && sourceTraderId !== lookup)
  ) {
    return null
  }
  return Object.freeze({
    handle,
    avatarUrl: optionalString(row.avatar_url),
    source,
    sourceTraderId,
  })
}

function parsePublishedRank(
  row: Record<string, unknown>,
  lookup: string,
  season: LeaderboardPublicationSeason,
  publication: SealedLeaderboardPublicationProofSet,
  allowedSources: ReadonlySet<string>
): PublishedRank | null {
  const identity = parseIdentity(row, lookup, allowedSources)
  if (
    !identity ||
    row.season_id !== season ||
    row.rank_publication_id !== publication.scoreCohortId ||
    typeof row.rank !== 'number' ||
    !Number.isSafeInteger(row.rank) ||
    row.rank <= 0 ||
    row.rank > LEADERBOARD_PUBLICATION_PROOFS_MAX_TRADERS ||
    typeof row.arena_score !== 'number' ||
    !Number.isFinite(row.arena_score) ||
    row.arena_score <= 0 ||
    row.arena_score > 100
  ) {
    return null
  }
  return Object.freeze({
    ...identity,
    season,
    rank: row.rank,
    arenaScore: row.arena_score,
    roi: optionalFiniteNumber(row.roi),
    pnl: optionalFiniteNumber(row.pnl),
    winRate: optionalFiniteNumber(row.win_rate),
    maxDrawdown: optionalFiniteNumber(row.max_drawdown),
  })
}

function deduplicateIdentities(identities: readonly TraderIdentity[]): TraderIdentity[] {
  const unique = new Map<string, TraderIdentity>()
  for (const identity of identities) {
    const key = identityKey(identity)
    const previous = unique.get(key)
    unique.set(
      key,
      Object.freeze({
        source: identity.source,
        sourceTraderId: identity.sourceTraderId,
        handle: previous?.handle ?? identity.handle,
        avatarUrl: previous?.avatarUrl ?? identity.avatarUrl,
      })
    )
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.sourceTraderId.localeCompare(right.sourceTraderId)
  )
}

function sortPublishedRanks(ranks: readonly PublishedRank[]): PublishedRank[] {
  return [...ranks].sort(
    (left, right) =>
      right.arenaScore - left.arenaScore ||
      left.rank - right.rank ||
      left.source.localeCompare(right.source) ||
      left.sourceTraderId.localeCompare(right.sourceTraderId)
  )
}

function rankSelect(): string {
  return [
    'handle',
    'avatar_url',
    'source',
    'source_trader_id',
    'season_id',
    'rank_publication_id',
    'roi',
    'pnl',
    'win_rate',
    'max_drawdown',
    'arena_score',
    'rank',
  ].join(',')
}

async function lookupRows(
  config: Required<EdgePublicTraderRankingConfig>,
  baseUrl: string,
  table: RestTable,
  select: string,
  lookup: string,
  sources: readonly string[],
  additionalFilters: Readonly<Record<string, string>> = {}
): Promise<Record<string, unknown>[]> {
  const common = {
    select,
    source: sourceFilter(sources),
    order: 'source.asc,source_trader_id.asc',
    ...additionalFilters,
  }
  const [byHandle, bySourceTraderId] = await Promise.all([
    readRestRows(config, baseUrl, table, {
      ...common,
      handle: `eq.${lookup}`,
    }),
    readRestRows(config, baseUrl, table, {
      ...common,
      source_trader_id: `eq.${lookup}`,
    }),
  ])
  return [...byHandle, ...bySourceTraderId]
}

async function readSeasonLookup(
  rpcClient: SupabaseRestRpcClient,
  config: Required<EdgePublicTraderRankingConfig>,
  baseUrl: string,
  lookup: string,
  season: LeaderboardPublicationSeason,
  sourceHint: string | undefined,
  includeDirectory: boolean
): Promise<SeasonLookup> {
  const reader = async (
    publication: SealedLeaderboardPublicationProofSet
  ): Promise<SeasonLookup> => {
    const sources = proofSources(publication)
    const allowedSources = new Set(sources)
    const rankFilters = {
      season_id: `eq.${season}`,
      rank_publication_id: `eq.${publication.scoreCohortId}`,
    }
    const [directoryRows, rankRows] = await Promise.all([
      includeDirectory
        ? lookupRows(
            config,
            baseUrl,
            'trader_sources',
            'handle,avatar_url,source,source_trader_id',
            lookup,
            sources
          )
        : Promise.resolve([]),
      lookupRows(config, baseUrl, 'leaderboard_ranks', rankSelect(), lookup, sources, rankFilters),
    ])
    const ranks = sortPublishedRanks(
      rankRows
        .map((row) => parsePublishedRank(row, lookup, season, publication, allowedSources))
        .filter((rank): rank is PublishedRank => rank !== null)
    )
    const identities = deduplicateIdentities([
      ...directoryRows
        .map((row) => parseIdentity(row, lookup, allowedSources))
        .filter((identity): identity is TraderIdentity => identity !== null),
      ...ranks,
    ])
    return Object.freeze({
      identities: Object.freeze(identities),
      ranks: Object.freeze(ranks),
    })
  }

  if (sourceHint) {
    return (
      await readSealedRankingGeneration(
        rpcClient as never,
        { season, sources: [sourceHint] },
        reader
      )
    ).value
  }
  return (await readSealedRankingAuthorityGeneration(rpcClient as never, season, reader)).value
}

function mergeRankIdentity(
  rank: PublishedRank,
  identities: readonly TraderIdentity[]
): PublishedRank {
  const identity = identities.find((candidate) => identityKey(candidate) === identityKey(rank))
  if (!identity) return rank
  return Object.freeze({
    ...rank,
    handle: identity.handle ?? rank.handle,
    avatarUrl: identity.avatarUrl ?? rank.avatarUrl,
  })
}

function publicRanking(
  identity: TraderIdentity,
  rank: PublishedRank | null
): EdgePublicTraderRanking {
  return Object.freeze({
    handle: identity.handle,
    avatarUrl: identity.avatarUrl,
    source: identity.source,
    sourceTraderId: identity.sourceTraderId,
    season: rank?.season ?? null,
    rank: rank?.rank ?? null,
    arenaScore: rank?.arenaScore ?? null,
    roi: rank?.roi ?? null,
    pnl: rank?.pnl ?? null,
    winRate: rank?.winRate ?? null,
    maxDrawdown: rank?.maxDrawdown ?? null,
  })
}

/**
 * Resolve one Edge-card trader and read only a stable, sealed public ranking.
 *
 * Directory matches are exact (no wildcard `ilike`). When a handle maps to
 * multiple exchanges, only a rank from the same sealed generation can choose
 * the identity. Every leaderboard query is bound to the proof cohort.
 */
export async function readEdgePublicTraderRanking(
  rawConfig: EdgePublicTraderRankingConfig,
  input: EdgePublicTraderRankingInput
): Promise<EdgePublicTraderRanking | null> {
  const fetchImpl = rawConfig.fetchImpl ?? fetch
  const rpcClient = createSupabaseRestRpcClient(
    rawConfig.supabaseUrl,
    rawConfig.serviceRoleKey,
    fetchImpl
  )
  const config: Required<EdgePublicTraderRankingConfig> = {
    ...rawConfig,
    fetchImpl,
  }
  const baseUrl = normalizedRestBaseUrl(rawConfig.supabaseUrl)
  const lookup = requireLookupHandle(input.handle)
  const sourceHint = requireSourceHint(input.source)

  const initial = await readSeasonLookup(
    rpcClient,
    config,
    baseUrl,
    lookup,
    SEASONS[0],
    sourceHint,
    true
  )
  if (initial.ranks[0]) {
    const rank = mergeRankIdentity(initial.ranks[0], initial.identities)
    return publicRanking(rank, rank)
  }
  if (initial.identities.length === 0) return null

  const candidateKeys = new Set(initial.identities.map(identityKey))
  for (const season of SEASONS.slice(1)) {
    let seasonLookup: SeasonLookup
    try {
      seasonLookup = await readSeasonLookup(
        rpcClient,
        config,
        baseUrl,
        lookup,
        season,
        sourceHint,
        false
      )
    } catch (error) {
      if (error instanceof SealedRankingSourceOutsideAuthorityError) continue
      throw error
    }
    const rank = seasonLookup.ranks.find((candidate) => candidateKeys.has(identityKey(candidate)))
    if (rank) {
      const merged = mergeRankIdentity(rank, initial.identities)
      return publicRanking(merged, merged)
    }
  }

  return initial.identities.length === 1 ? publicRanking(initial.identities[0], null) : null
}
