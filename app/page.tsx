'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'

import TopNav from './components/TopNav'
import RankingTable from './components/RankingTable'
import PostFeed from './components/PostFeed'
import MarketPanel from './components/MarketPanel'
import Card from './components/Card'
import TraderDrawer from './components/TraderDrawer'

/* =====================
   Types
===================== */

export type Trader = {
  id: string
  handle: string
  roi: number
  win_rate: number
  followers: number
}

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

      const { data, error } = await supabase
        .from('traders')
        .select('id, handle, roi, win_rate, followers')
        .order('roi', { ascending: false })
        .limit(email ? 50 : 10)

      if (!error && data) {
        setTraders(data as Trader[])
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

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#060606',
        color: '#f2f2f2',
      }}
    >
      {/* 顶部导航 */}
      {/* @ts-expect-error: TopNav expects 'email' prop */}
      <TopNav email={email} />

      {/* 主体 */}
      <main
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          padding: '18px 16px',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '320px 1fr 280px',
            gap: 16,
          }}
        >
          {/* 左：热门讨论 */}
          <section>
            <Card title="热门讨论">
              <PostFeed />
            </Card>
          </section>

          {/* 中：排名流（产品核心） */}
          <section>
            <RankingTable
              traders={traders}
              loading={loadingTraders}
              loggedIn={!!email}
              onSelectTrader={(t) => setSelectedTrader(t)}
            />
          </section>

          {/* 右：市场 */}
          <section>
            <MarketPanel />
          </section>
        </div>
      </main>

      {/* 右侧 Trader 抽屉：不影响你原来的三栏 UI */}
      <TraderDrawer
        open={!!selectedTrader}
        trader={selectedTrader as any}
        onClose={() => setSelectedTrader(null)}
      />
    </div>
  )
}
