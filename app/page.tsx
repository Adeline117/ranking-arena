'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'

import TopNav from './components/Layout/TopNav'
import RankingTable, { type Trader } from './components/Features/RankingTable'
import PostFeed from './components/Features/PostFeed'
import MarketPanel from './components/Features/MarketPanel'
import Card from './components/UI/Card'
import TraderDrawer from './components/Features/TraderDrawer'
import CompareTraders from './components/Features/CompareTraders'
import { Box } from './components/Base'

/* =====================
   Page
===================== */

export default function HomePage() {
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

      // 从 trader_snapshots 获取最新的 ROI Top 100 数据
      // 先获取最新的 captured_at，然后查询该批次的数据
      const { data: latestSnapshot, error: latestError } = await supabase
        .from('trader_snapshots')
        .select('captured_at')
        .eq('source', 'binance')
        .order('captured_at', { ascending: false })
        .limit(1)
        .single()

      if (latestError || !latestSnapshot) {
        console.error('[ranking] latest snapshot error:', latestError)
        setTraders([])
        setLoadingTraders(false)
        return
      }

      // 查询该批次的数据
      const { data, error } = await supabase
        .from('trader_snapshots')
        .select(`
          source_trader_id,
          rank,
          roi,
          followers,
          trader_sources!trader_snapshots_source_source_trader_id_fkey(handle)
        `)
        .eq('source', 'binance')
        .eq('captured_at', latestSnapshot.captured_at)
        .order('rank', { ascending: true })
        .limit(email ? 100 : 50)

      if (!error && data) {
        // 转换为 Trader 格式
        const tradersData: Trader[] = data.map((item: any) => ({
          id: item.source_trader_id,
          handle: item.trader_sources?.handle || item.source_trader_id,
          roi: item.roi || 0,
          win_rate: 0, // trader_snapshots 中没有 win_rate，暂时设为 0
          followers: item.followers || 0,
        }))
        setTraders(tradersData)
      } else {
        console.error('[ranking]', error)
        setTraders([])
      }

      setLoadingTraders(false)
    }

    load()
  }, [email])

  /* ---------- trader drawer ---------- */
  const [selectedTrader, setSelectedTrader] = useState<Trader | null>(null)
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
        px={4}
        py={6}
        style={{
          maxWidth: 1200,
          margin: '0 auto',
        }}
      >
        <Box
          style={{
            display: 'grid',
            gridTemplateColumns: '320px 1fr 280px',
            gap: tokens.spacing[4],
          }}
        >
          {/* 左：热门讨论 */}
          <Box as="section">
            <Card title="热门讨论">
              <PostFeed />
            </Card>
          </Box>

          {/* 中：排名流（产品核心） */}
          <Box as="section">
            <RankingTable
              traders={traders}
              loading={loadingTraders}
              loggedIn={!!email}
              onSelectTrader={(trader) => setSelectedTrader(trader)}
            />
          </Box>

          {/* 右：市场 */}
          <Box as="section">
            <MarketPanel />
          </Box>
        </Box>
      </Box>

      {/* 右侧 Trader 抽屉：不影响你原来的三栏 UI */}
      <TraderDrawer
        open={!!selectedTrader}
        trader={selectedTrader as any}
        onClose={() => setSelectedTrader(null)}
      />

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
