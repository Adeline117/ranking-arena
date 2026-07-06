import { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'

export const metadata: Metadata = {
  title: 'Watchlist',
  description:
    'Track your favorite crypto traders. Monitor ROI, Arena Score, and performance changes in real-time.',
  alternates: {
    canonical: `${BASE_URL}/watchlist`,
  },
  openGraph: {
    title: 'Trader Watchlist',
    description: 'Track your favorite crypto traders and monitor their performance.',
    url: `${BASE_URL}/watchlist`,
    siteName: 'Arena',
    type: 'website',
  },
}

// 2026-07-04 #4:收敛到统一"我的收藏"hub。旧链接/书签重定向到 hub 的交易员 tab
// (WatchlistClient 本身在 hub 里复用,数据层零改动)。
import { redirect } from 'next/navigation'

export default function WatchlistPage() {
  redirect('/saved?tab=traders')
}
