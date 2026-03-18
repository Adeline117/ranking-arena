'use client'

import { useEffect, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Box } from '../base'
import RankingSection from './RankingSection'
import PullToRefresh from '../ui/PullToRefresh'
import { useTraderData, useAuth } from './hooks'
import { useLanguage } from '../Providers/LanguageProvider'
import type { TimeRange } from './hooks/useTraderData'
import type { InitialTrader } from '@/lib/getInitialTraders'
import type { Trader } from '../ranking/RankingTable'

interface HomePageClientProps {
  initialTraders?: InitialTrader[]
  initialLastUpdated?: string | null
}

/**
 * 首页客户端组件
 * 处理交互状态和数据同步
 * 数据通过客户端fetch获取，SSR排行榜由SSRRankingTable提供
 */
export default function HomePageClient({ initialTraders, initialLastUpdated }: HomePageClientProps) {
  // DEBUG: Test with only useTraderData
  const convertedInitialTraders: Trader[] | undefined = useMemo(() =>
    initialTraders?.map(t => ({
      id: t.id, handle: t.handle, roi: t.roi, pnl: t.pnl,
      win_rate: t.win_rate, max_drawdown: t.max_drawdown,
      followers: t.followers, source: t.source, avatar_url: t.avatar_url,
      arena_score: t.arena_score, score_confidence: t.score_confidence,
    })), [initialTraders])

  const { traders, loading } = useTraderData({
    initialTraders: convertedInitialTraders,
    initialLastUpdated,
  })

  return (
    <div className="home-ranking-section" style={{ padding: 20, textAlign: 'center', color: 'var(--color-text-secondary)' }}>
      <p>DEBUG: useTraderData active</p>
      <p>{traders.length} traders | loading: {String(loading)}</p>
    </div>
  )
}
