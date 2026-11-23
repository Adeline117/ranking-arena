import { Metadata } from 'next'
import RankingsSubNav from './RankingsSubNav'
import { BASE_URL } from '@/lib/constants/urls'
import { JsonLd } from '@/app/components/Providers/JsonLd'
import { generateBreadcrumbSchema } from '@/lib/seo/structured-data'

export const metadata: Metadata = {
  title: 'Rankings',
  description:
    'Crypto trader rankings across current CEX, DEX, and on-chain source boards. Compare 90-day ROI, win rate, drawdown, and Arena Score; rankings recompute every two hours.',
  // 不在布局写 canonical：/rankings 本身是 308 到首页，子页面各自声明自己的 canonical。
  keywords: [
    'crypto trader ranking',
    'copy trading leaderboard',
    'ROI ranking',
    'Binance traders',
    'Bybit leaderboard',
    'crypto trading performance',
    'Arena Score',
  ],
  openGraph: {
    title: 'Trader Rankings',
    description:
      'Trader rankings across current public source boards, recomputed every two hours. Compare ROI, win rate, drawdown, and Arena Score.',
    url: BASE_URL,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${BASE_URL}/og-image.png`, width: 1200, height: 630, alt: 'Arena Rankings' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Trader Rankings',
    description: 'Trader rankings across current public source boards, recomputed every two hours.',
    images: [`${BASE_URL}/og-image.png`],
    creator: '@arenafi',
  },
}

const breadcrumbJsonLd = generateBreadcrumbSchema([
  { name: 'Arena', url: BASE_URL },
  { name: 'Rankings', url: `${BASE_URL}/` },
])

export default function RankingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', position: 'relative' }}>
      <JsonLd data={breadcrumbJsonLd} />
      <div
        className="mesh-gradient-bg"
        style={{
          position: 'fixed',
          inset: 0,
          background:
            'linear-gradient(135deg, var(--color-accent-primary-08) 0%, transparent 40%, var(--color-accent-primary-08) 100%)',
          opacity: 0.5,
          pointerEvents: 'none',
          zIndex: 0,
          transform: 'translateZ(0)',
          contain: 'strict layout paint',
        }}
      />
      <div
        className="container-padding has-mobile-nav"
        style={{
          maxWidth: 1400,
          margin: '0 auto',
          padding: '8px 16px',
          position: 'relative',
          zIndex: 1,
        }}
      >
        <RankingsSubNav />
        <div style={{ height: 16 }} />
        {children}
      </div>
    </div>
  )
}
