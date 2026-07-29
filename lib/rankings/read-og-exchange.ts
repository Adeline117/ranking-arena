import { parsePublicActiveRankingSource } from '@/lib/constants/exchanges'
import { isPublicRankingSourceAllowed } from '@/lib/rankings/publication-policy'
import { readSealedRankingGeneration } from '@/lib/rankings/read-sealed-ranking-generation'
import { createSupabaseRestRpcClient } from '@/lib/rankings/supabase-rest-rpc-client'

const READ_TIMEOUT_MS = 4_000
const TOP_TRADER_LIMIT = 3
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

export interface OgExchangeRankingConfig {
  readonly supabaseUrl: string
  readonly serviceRoleKey: string
  readonly fetchImpl?: typeof fetch
}

export interface OgExchangeTopTrader {
  readonly handle: string | null
  readonly avatar_url: string | null
  readonly roi: number | null
  readonly arena_score: number | null
  readonly rank: number
}

export interface OgExchangeRanking {
  readonly traders: readonly OgExchangeTopTrader[]
  readonly total: number
}

function normalizedRestBaseUrl(value: string): string {
  return new URL(value).href.replace(/\/+$/, '')
}

function optionalText(value: unknown, field: string, maximumLength: number): string | null {
  if (value === null || value === '') return null
  if (
    typeof value !== 'string' ||
    value.length > maximumLength ||
    value.trim() !== value ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new TypeError(`OG exchange ranking row has invalid ${field}`)
  }
  return value
}

function optionalFiniteNumber(value: unknown, field: string): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`OG exchange ranking row has invalid ${field}`)
  }
  return value
}

async function readTopTraderRows(
  config: Required<OgExchangeRankingConfig>,
  baseUrl: string,
  source: string,
  scoreCohortId: string
): Promise<unknown[]> {
  const params = new URLSearchParams({
    select:
      'source,source_trader_id,handle,avatar_url,roi,arena_score,rank,season_id,rank_publication_id,is_outlier',
    source: `eq.${source}`,
    season_id: 'eq.90D',
    rank_publication_id: `eq.${scoreCohortId}`,
    arena_score: 'gt.0',
    rank: 'not.is.null',
    or: '(is_outlier.is.null,is_outlier.eq.false)',
    order: 'rank.asc.nullslast',
    limit: String(TOP_TRADER_LIMIT),
  })
  const response = await config.fetchImpl(
    `${baseUrl}/rest/v1/leaderboard_ranks?${params.toString()}`,
    {
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
      },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    }
  )
  if (!response.ok) {
    throw new Error(`OG exchange ranking REST query failed with status ${response.status}`)
  }

  const payload: unknown = await response.json()
  if (!Array.isArray(payload) || payload.length > TOP_TRADER_LIMIT) {
    throw new TypeError('OG exchange ranking REST query returned an invalid payload')
  }
  return payload
}

/** Read one exchange card from one immutable 90D public generation in Edge runtime. */
export async function readOgExchangeRanking(
  rawConfig: OgExchangeRankingConfig,
  requestedSource: string
): Promise<OgExchangeRanking> {
  const source = parsePublicActiveRankingSource(requestedSource)
  if (!source || !isPublicRankingSourceAllowed(source)) {
    throw new TypeError('OG exchange source is not a canonical public ranking source')
  }

  const fetchImpl = rawConfig.fetchImpl ?? fetch
  const rpcClient = createSupabaseRestRpcClient(
    rawConfig.supabaseUrl,
    rawConfig.serviceRoleKey,
    fetchImpl
  )
  const config: Required<OgExchangeRankingConfig> = {
    ...rawConfig,
    fetchImpl,
  }
  const baseUrl = normalizedRestBaseUrl(rawConfig.supabaseUrl)

  return (
    await readSealedRankingGeneration(
      rpcClient as never,
      { season: '90D', sources: [source] },
      async (publication) => {
        const proof = publication.proofs.find((candidate) => candidate.source === source)
        if (!proof) {
          throw new Error('OG exchange publication proof does not authorize the requested source')
        }
        const rows = await readTopTraderRows(config, baseUrl, source, publication.scoreCohortId)
        if (proof.published_rank_count < rows.length) {
          throw new Error('OG exchange publication proof does not authorize the returned rows')
        }

        const identities = new Set<string>()
        const traders = rows.map((value) => {
          if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            throw new TypeError('OG exchange ranking REST query returned an invalid row')
          }
          const row = value as Record<string, unknown>
          const sourceTraderId = optionalText(row.source_trader_id, 'source_trader_id', 2_048)
          const arenaScore = optionalFiniteNumber(row.arena_score, 'arena_score')
          const rank = row.rank
          if (
            row.source !== source ||
            row.season_id !== '90D' ||
            row.rank_publication_id !== publication.scoreCohortId ||
            row.is_outlier === true ||
            !sourceTraderId ||
            identities.has(sourceTraderId) ||
            arenaScore === null ||
            arenaScore <= 0 ||
            arenaScore > 100 ||
            typeof rank !== 'number' ||
            !Number.isSafeInteger(rank) ||
            rank <= 0 ||
            rank > proof.published_rank_count
          ) {
            throw new Error('OG exchange ranking row escaped its sealed publication')
          }
          identities.add(sourceTraderId)
          return Object.freeze({
            handle: optionalText(row.handle, 'handle', 200),
            avatar_url: optionalText(row.avatar_url, 'avatar_url', 8_192),
            roi: optionalFiniteNumber(row.roi, 'roi'),
            arena_score: arenaScore,
            rank,
          })
        })

        return Object.freeze({
          traders: Object.freeze(traders),
          total: proof.published_rank_count,
        })
      },
      { timeoutMs: 10_000 }
    )
  ).value
}
