import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Compare Traders - Arena',
  description:
    '并排对比加密货币交易员的 ROI、胜率、最大回撤、Arena Score 和权益曲线。',
  alternates: {
    canonical: `${baseUrl}/compare`,
  },
  openGraph: {
    title: 'Compare Traders | Arena',
    description: 'Compare traders side-by-side across exchanges.',
    url: `${baseUrl}/compare`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og-image.png`, width: 1200, height: 630, alt: 'Arena 交易员对比' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Compare Traders | Arena',
    description: 'Compare traders side-by-side across exchanges.',
    images: [`${baseUrl}/og-image.png`],
    creator: '@arenafi',
  },
}

export default function CompareLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
