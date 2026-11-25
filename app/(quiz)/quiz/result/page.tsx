/**
 * /quiz/result — Trading Personality Quiz result page
 *
 * Server component: reads type+match from search params, sets OG metadata,
 * queries recommended traders from DB, renders client component.
 */

import type { Metadata } from 'next'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { BASE_URL } from '@/lib/constants/urls'
import { sanitizePublicRankingPayload } from '@/lib/rankings/publication-policy'
import { PERSONALITY_TYPE_MAP, PERSONALITY_TYPES } from '../components/quiz-data'
import type { PersonalityTypeId, RecommendedTrader } from '../components/types'
import ResultPageClient from './ResultPageClient'

export const revalidate = 3600

interface Props {
  searchParams: Promise<{
    type?: string
    match?: string
    lang?: string
    secondary?: string
    percents?: string
  }>
}

// English names for server-side metadata (i18n is client-only)
const TYPE_ENGLISH_NAMES: Record<PersonalityTypeId, string> = {
  sniper: 'The Sniper',
  scalper: 'The Scalper',
  whale: 'The Whale',
  analyst: 'The Analyst',
  contrarian: 'The Contrarian',
  hodler: 'The HODLer',
  degen: 'The Degen',
  strategist: 'The Strategist',
  copycat: 'The Copy Trader',
  tourist: 'The Tourist',
  paperhands: 'The Paper Hands',
  narrator: 'The Narrative Trader',
}

// Type-specific trader query criteria
const TRADER_QUERIES: Record<
  PersonalityTypeId,
  { orderBy: string; ascending: boolean; filter?: string }
> = {
  sniper: { orderBy: 'win_rate', ascending: false },
  scalper: { orderBy: 'trades_count', ascending: false },
  whale: { orderBy: 'pnl', ascending: false },
  analyst: { orderBy: 'arena_score', ascending: false },
  contrarian: { orderBy: 'roi', ascending: false },
  hodler: { orderBy: 'roi', ascending: false },
  degen: { orderBy: 'roi', ascending: false },
  strategist: { orderBy: 'arena_score', ascending: false },
  copycat: { orderBy: 'win_rate', ascending: false },
  tourist: { orderBy: 'roi', ascending: false },
  paperhands: { orderBy: 'roi', ascending: false },
  narrator: { orderBy: 'roi', ascending: false },
}

const QUIZ_RECOMMENDATION_PERIOD = '90D'
// Quiz recommendations describe real traders with Arena score/ROI claims, so
// they must use the same sealed ranking cohort as every other public surface.
// Keep the proof fields selected for local defense-in-depth validation.
const PUBLIC_QUIZ_TRADER_COLUMNS =
  'source,source_trader_id,handle,avatar_url,roi,arena_score,win_rate,pnl,rank,season_id,max_drawdown,score_completeness,metrics_estimated,is_outlier,computed_at'

type VerifiedQuizTrader = Record<string, unknown> & {
  source: string
  source_trader_id: string
  rank: number
  roi: number
  arena_score: number
  // Optional on a ranked row: null means the source did not provide it.
  win_rate: number | null
  pnl: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow bridge while generated Supabase types catch up with the public view. */
function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isVerifiedQuizTrader(row: unknown): row is VerifiedQuizTrader {
  return (
    isRecord(row) &&
    typeof row.source === 'string' &&
    typeof row.source_trader_id === 'string' &&
    row.source_trader_id.length > 0 &&
    typeof row.rank === 'number' &&
    Number.isSafeInteger(row.rank) &&
    row.rank > 0 &&
    finiteNumber(row.roi) &&
    finiteNumber(row.arena_score) &&
    (row.win_rate === null || finiteNumber(row.win_rate)) &&
    finiteNumber(row.pnl)
  )
}

/**
 * Preserve the query's finite top-three cohort. If a cache/proxy injects a
 * malformed row, filtering it and showing a lower row would create a new,
 * unproved recommendation ordering. Fail closed instead.
 */
function verifyQuizRecommendationCohort(value: unknown): VerifiedQuizTrader[] | null {
  if (!Array.isArray(value)) return null
  const sanitized = sanitizePublicRankingPayload(
    { traders: value, period: QUIZ_RECOMMENDATION_PERIOD },
    { expectedPeriod: QUIZ_RECOMMENDATION_PERIOD }
  ) as { traders?: unknown[] }
  const rows = Array.isArray(sanitized.traders)
    ? sanitized.traders.filter(isVerifiedQuizTrader)
    : []

  return rows.length === value.length ? rows : null
}

async function getRecommendedTraders(typeId: PersonalityTypeId): Promise<RecommendedTrader[]> {
  try {
    const supabase = getSupabaseAdmin()
    const query = TRADER_QUERIES[typeId] || { orderBy: 'arena_score', ascending: false }

    const { data, error } = await supabase
      .from('public_ranked_leaderboard')
      .select(PUBLIC_QUIZ_TRADER_COLUMNS)
      .eq('season_id', QUIZ_RECOMMENDATION_PERIOD)
      .not('rank', 'is', null)
      .not(query.orderBy, 'is', null)
      .order(query.orderBy, { ascending: query.ascending })
      .order('rank', { ascending: true, nullsFirst: false })
      .limit(3)

    if (error || !data?.length) return []
    const verifiedRows = verifyQuizRecommendationCohort(data)
    if (!verifiedRows) return []

    return verifiedRows.map((row) => {
      const handle =
        typeof row.handle === 'string' && row.handle.trim().length > 0
          ? row.handle.trim()
          : row.source_trader_id
      return {
        handle,
        name: handle,
        avatar_url: typeof row.avatar_url === 'string' ? row.avatar_url : null,
        platform: row.source,
        roi_90d: row.roi,
        arena_score: row.arena_score,
        win_rate: row.win_rate,
        pnl_90d: row.pnl,
      }
    })
  } catch {
    return []
  }
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const params = await searchParams
  const typeId = (params.type || 'sniper') as PersonalityTypeId
  const match = params.match || '85'
  const lang = params.lang || 'en'

  const validType = PERSONALITY_TYPE_MAP[typeId] ? typeId : 'sniper'
  const _pType = PERSONALITY_TYPE_MAP[validType] || PERSONALITY_TYPES[0]
  // Use proper English name for OG metadata (i18n is client-only)
  const typeLabel =
    TYPE_ENGLISH_NAMES[validType as PersonalityTypeId] ||
    validType.charAt(0).toUpperCase() + validType.slice(1)

  const title = `I'm ${typeLabel} - Trading Personality`
  const description = `${match}% match. Discover your trading personality and the legendary trader who matches your style.`

  return {
    title,
    description,
    alternates: { canonical: `${BASE_URL}/quiz/result?type=${validType}` },
    openGraph: {
      title,
      description,
      url: `${BASE_URL}/quiz/result?type=${validType}&match=${match}`,
      siteName: 'Arena',
      type: 'website',
      images: [
        {
          url: `${BASE_URL}/api/og/quiz?type=${validType}&match=${match}&lang=${lang}`,
          width: 1200,
          height: 630,
          alt: `Trading Personality: ${typeLabel}`,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      creator: '@arenafi',
      images: [`${BASE_URL}/api/og/quiz?type=${validType}&match=${match}&lang=${lang}`],
    },
  }
}

/**
 * Parse compact percents param ("12,8,5,...") back into Record<PersonalityTypeId, number>.
 * Returns null if param is missing or malformed.
 */
function parsePercentsParam(
  percents: string | undefined
): Record<PersonalityTypeId, number> | null {
  if (!percents) return null
  const parts = percents.split(',').map(Number)
  if (parts.length !== PERSONALITY_TYPES.length || parts.some(isNaN)) return null
  const result = {} as Record<PersonalityTypeId, number>
  PERSONALITY_TYPES.forEach((pt, i) => {
    result[pt.id] = parts[i]
  })
  return result
}

export default async function QuizResultPage({ searchParams }: Props) {
  const params = await searchParams
  const typeId = (params.type || 'sniper') as PersonalityTypeId
  const match = parseInt(params.match || '85', 10)
  const matchClamped = isNaN(match) ? 85 : Math.min(99, Math.max(55, match))

  // Parse optional secondary type and type breakdown percents from URL
  const secondaryRaw = params.secondary as string | undefined
  const secondaryType = (
    secondaryRaw && PERSONALITY_TYPE_MAP[secondaryRaw] ? secondaryRaw : undefined
  ) as PersonalityTypeId | undefined
  const allTypePercents = parsePercentsParam(params.percents)

  const pType = PERSONALITY_TYPE_MAP[typeId]
  if (!pType) {
    // Fallback to sniper if invalid type
    const fallbackType = PERSONALITY_TYPES[0]
    const traders = await getRecommendedTraders(fallbackType.id)
    return (
      <ResultPageClient typeId={fallbackType.id} matchPercent={85} recommendedTraders={traders} />
    )
  }

  const traders = await getRecommendedTraders(typeId)

  return (
    <ResultPageClient
      typeId={typeId}
      matchPercent={matchClamped}
      recommendedTraders={traders}
      secondaryTypeId={secondaryType}
      allTypePercents={allTypePercents}
    />
  )
}
