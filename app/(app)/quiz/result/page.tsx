/**
 * /quiz/result — Trading Personality Quiz result page
 *
 * Server component: reads type+match from search params, sets OG metadata,
 * queries recommended traders from DB, renders client component.
 */

import type { Metadata } from 'next'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { BASE_URL } from '@/lib/constants/urls'
import { PERSONALITY_TYPE_MAP, PERSONALITY_TYPES } from '../components/quiz-data'
import type { PersonalityTypeId, RecommendedTrader } from '../components/types'
import ResultPageClient from './ResultPageClient'

export const revalidate = 3600

interface Props {
  searchParams: Promise<{ type?: string; match?: string; lang?: string }>
}

// Type-specific trader query criteria
const TRADER_QUERIES: Record<PersonalityTypeId, { orderBy: string; ascending: boolean; filter?: string }> = {
  sniper: { orderBy: 'win_rate', ascending: false },
  scalper: { orderBy: 'trades_count', ascending: false },
  whale: { orderBy: 'pnl', ascending: false },
  analyst: { orderBy: 'arena_score', ascending: false },
  contrarian: { orderBy: 'roi', ascending: false },
  hodler: { orderBy: 'roi', ascending: false },
  degen: { orderBy: 'roi', ascending: false },
  strategist: { orderBy: 'arena_score', ascending: false },
  copycat: { orderBy: 'win_rate', ascending: false },
  arbitrageur: { orderBy: 'roi', ascending: false },
  gridbot: { orderBy: 'roi', ascending: false },
  narrator: { orderBy: 'roi', ascending: false },
}

async function getRecommendedTraders(typeId: PersonalityTypeId): Promise<RecommendedTrader[]> {
  try {
    const supabase = getSupabaseAdmin()
    const query = TRADER_QUERIES[typeId] || { orderBy: 'arena_score', ascending: false }

    const { data } = await supabase
      .from('leaderboard_ranks')
      .select('source, source_trader_id, handle, avatar_url, roi, arena_score, win_rate, pnl, rank')
      .eq('season_id', '90D')
      .not(query.orderBy, 'is', null)
      .order(query.orderBy, { ascending: query.ascending })
      .limit(3)

    if (!data?.length) return []

    return data.map((row) => ({
      handle: row.handle || row.source_trader_id || '',
      name: row.handle || row.source_trader_id || 'Unknown',
      avatar_url: row.avatar_url || null,
      platform: row.source || '',
      roi_90d: row.roi ?? null,
      arena_score: row.arena_score ?? null,
      win_rate: row.win_rate ?? null,
      pnl_90d: row.pnl ?? null,
    }))
  } catch {
    return []
  }
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const params = await searchParams
  const typeId = (params.type || 'sniper') as PersonalityTypeId
  const match = params.match || '85'
  const lang = params.lang || 'en'

  const pType = PERSONALITY_TYPE_MAP[typeId] || PERSONALITY_TYPES[0]
  const typeName = pType.nameKey // Will be resolved to actual name via i18n on client

  const title = `I'm ${typeId.charAt(0).toUpperCase() + typeId.slice(1)} - Trading Personality | Arena`
  const description = `${match}% match. Discover your trading personality and the legendary trader who matches your style.`

  return {
    title,
    description,
    alternates: { canonical: `${BASE_URL}/quiz/result?type=${typeId}` },
    openGraph: {
      title,
      description,
      url: `${BASE_URL}/quiz/result?type=${typeId}&match=${match}`,
      siteName: 'Arena',
      type: 'website',
      images: [
        {
          url: `${BASE_URL}/api/og/quiz?type=${typeId}&match=${match}&lang=${lang}`,
          width: 1200,
          height: 630,
          alt: `Trading Personality: ${typeName}`,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      creator: '@arenafi',
      images: [`${BASE_URL}/api/og/quiz?type=${typeId}&match=${match}&lang=${lang}`],
    },
  }
}

export default async function QuizResultPage({ searchParams }: Props) {
  const params = await searchParams
  const typeId = (params.type || 'sniper') as PersonalityTypeId
  const match = parseInt(params.match || '85', 10)
  const matchClamped = isNaN(match) ? 85 : Math.min(99, Math.max(60, match))

  const pType = PERSONALITY_TYPE_MAP[typeId]
  if (!pType) {
    // Fallback to sniper if invalid type
    const fallbackType = PERSONALITY_TYPES[0]
    const traders = await getRecommendedTraders(fallbackType.id)
    return <ResultPageClient typeId={fallbackType.id} matchPercent={85} recommendedTraders={traders} />
  }

  const traders = await getRecommendedTraders(typeId)

  return (
    <ResultPageClient typeId={typeId} matchPercent={matchClamped} recommendedTraders={traders} />
  )
}
