import type { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'

export const metadata: Metadata = {
  title: {
    default: 'Trading Personality Test',
    template: '%s | Arena',
  },
  description:
    'Discover your trading personality in 30 questions. Are you a Sniper, Whale, or Degen? 12 personalities to uncover. Find your trading style and the legendary trader who matches you.',
  alternates: { canonical: `${BASE_URL}/quiz` },
  openGraph: {
    title: 'Trading Personality Test | Arena',
    description:
      'Discover your trading personality in 30 questions. 12 personalities to uncover. Find your style and the legendary trader who matches you.',
    url: `${BASE_URL}/quiz`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${BASE_URL}/api/og/quiz?type=sniper&match=85`, width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Trading Personality Test | Arena',
    description: 'Discover your trading personality in 30 questions. 12 personalities to uncover.',
    creator: '@arenafi',
  },
}

export default function QuizLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
