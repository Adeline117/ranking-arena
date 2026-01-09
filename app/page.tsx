'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import {
  getAllLatestTimestamps,
  getAllLatestSnapshots,
  getAllTraderHandles,
  type TraderSource,
} from '@/lib/data/trader-snapshots'
import { logError } from '@/lib/utils/error-handler'

import TopNav from './components/Layout/TopNav'
import RankingTable, { type Trader } from './components/Features/RankingTable'
import PostFeed from './components/Features/PostFeed'
import MarketPanel from './components/Features/MarketPanel'
import Card from './components/UI/Card'
import CompareTraders from './components/Features/CompareTraders'
import ExchangeQuickConnect from './components/ExchangeQuickConnect'
import { Box } from './components/Base'
import { useLanguage } from './components/Utils/LanguageProvider'

/* =====================
   Page
===================== */

export default function HomePage() {
  const { t } = useLanguage()
  
  /* ---------- auth ---------- */
  const [email, setEmail] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
    })
  }, [])

  /* ---------- ranking flow ---------- */
  const [traders, setTraders] = useState<Trader[]>([])
  const [loadingTraders, setLoadingTraders] = useState(true)

  useEffect(() => {
    const load = async () => {
      setLoadingTraders(true)
      try {
        const { loadAllTraders } = await import('@/lib/data/trader-loader')
        const tradersData = await loadAllTraders(supabase)
        setTraders(tradersData)
      } catch (error) {
        logError(error, 'HomePage')
      } finally {
        setLoadingTraders(false)
      }
    }

    load()
    
    // 每5分钟自动刷新一次数据
    const interval = setInterval(() => {
      load()
    }, 5 * 60 * 1000) // 5分钟 = 300000毫秒
    
    return () => clearInterval(interval)
  }, [email])

  /* ---------- trader compare ---------- */
  const [compareTraders, setCompareTraders] = useState<Trader[]>([])

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      {/* 顶部导航 */}
      <TopNav email={email} />

      {/* 主体 */}
      <Box
        as="main"
        className="container-padding"
        px={4}
        py={6}
        style={{
          maxWidth: 1200,
          margin: '0 auto',
        }}
      >
        {/* 快速绑定交易所 */}
        <ExchangeQuickConnect />
        <Box
          className="main-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: '320px 1fr 280px',
            gap: tokens.spacing[4],
          }}
        >
          {/* 左：热门讨论 */}
          <Box as="section" className="home-left-section">
            <Card title={t('hotDiscussion')}>
              <PostFeed />
            </Card>
            <Link
              href="/groups"
              style={{
                display: 'block',
                marginTop: tokens.spacing[3],
                textAlign: 'center',
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                background: 'rgba(139, 111, 168, 0.1)',
                color: '#8b6fa8',
                borderRadius: tokens.radius.md,
                border: '1px solid rgba(139, 111, 168, 0.3)',
                textDecoration: 'none',
                fontSize: '14px',
                fontWeight: 700,
                transition: 'all 0.2s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(139, 111, 168, 0.2)'
                e.currentTarget.style.borderColor = 'rgba(139, 111, 168, 0.5)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(139, 111, 168, 0.1)'
                e.currentTarget.style.borderColor = 'rgba(139, 111, 168, 0.3)'
              }}
            >
              {t('more')} →
            </Link>
          </Box>

          {/* 中：排名流（产品核心） */}
          <Box as="section" className="home-ranking-section">
            <RankingTable
              traders={traders}
              loading={loadingTraders}
              loggedIn={!!email}
              source={traders.length > 0 ? traders[0].source : 'binance_web3'}
            />
          </Box>

          {/* 右：市场 */}
          <Box as="section" className="home-right-section">
            <MarketPanel />
          </Box>
        </Box>
      </Box>

      {/* 交易者对比面板 */}
      {compareTraders.length > 0 && (
        <CompareTraders
          traders={compareTraders}
          onRemove={(id) => setCompareTraders(compareTraders.filter((t) => t.id !== id))}
          onClear={() => setCompareTraders([])}
        />
      )}
    </Box>
  )
}
