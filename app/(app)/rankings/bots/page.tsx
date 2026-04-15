import { Suspense } from 'react'
import { BASE_URL } from '@/lib/constants/urls'
import BotsClient from './BotsClient'
import type { BotRankingsResponse } from '@/lib/hooks/useBotRankings'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'

export const revalidate = 300 // ISR: 5 minutes

const SSR_TIMEOUT_MS = 4000

export const metadata = {
  title: 'Bot Rankings — TG Bots, AI Agents & Vaults',
  description:
    'Discover the best Web3 bots, AI agents, and on-chain vaults. Ranked by Arena Score across TVL, APY, and user activity.',
  alternates: { canonical: `${BASE_URL}/rankings/bots` },
  openGraph: {
    title: 'Bot Rankings — TG Bots, AI Agents & Vaults',
    description: 'Web3 bot leaderboard ranked by Arena Score. TG bots, AI agents, vaults.',
    url: `${BASE_URL}/rankings/bots`,
    siteName: 'Arena',
    type: 'website',
  },
}

async function fetchInitialBots(): Promise<BotRankingsResponse | null> {
  try {
    const url = `${BASE_URL}/api/bots?window=90D&sort_by=arena_score&sort_dir=desc`
    const res = await fetch(url, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(SSR_TIMEOUT_MS),
    })
    if (!res.ok) return null
    return res.json()
  } catch {
    // SSR fetch failed — client will fetch via SWR
    return null
  }
}

export default async function BotRankingsPage() {
  const initialBots = await fetchInitialBots()

  return (
    <Suspense fallback={
      <div style={{ minHeight: '100vh', background: 'var(--color-bg-primary)' }}>
        <div className="max-w-5xl mx-auto px-4 py-6"><RankingSkeleton /></div>
      </div>
    }>
      <BotsClient initialBots={initialBots} />
    </Suspense>
  )
}
