import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { BASE_URL } from '@/lib/constants/urls'
import { features } from '@/lib/features'

export const metadata: Metadata = {
  // Root layout template appends ' | Arena'; OG/Twitter titles below bypass it
  // and keep the explicit suffix.
  title: 'Trading Competitions',
  description:
    'Compete with traders worldwide. Join trading competitions on Arena to test your skills and climb the leaderboard.',
  alternates: {
    canonical: `${BASE_URL}/competitions`,
  },
  openGraph: {
    title: 'Trading Competitions | Arena',
    description: 'Compete with traders worldwide on Arena.',
    url: `${BASE_URL}/competitions`,
    siteName: 'Arena',
    type: 'website',
    images: [
      { url: `${BASE_URL}/og-image.png`, width: 1200, height: 630, alt: 'Arena Competitions' },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Trading Competitions | Arena',
    description: 'Compete with traders worldwide on Arena.',
    images: [`${BASE_URL}/og-image.png`],
    creator: '@arenafi',
  },
}

export default function Layout({ children }: { children: React.ReactNode }) {
  // 比赛功能预上线封存：无 NEXT_PUBLIC_FEATURE_COMPETITIONS=true 时全部页面 404
  // （更新 cron 未挂→榜是死的、无导航入口）。覆盖 list/create/[id] 所有子页。
  if (!features.competitions) notFound()
  return children
}
