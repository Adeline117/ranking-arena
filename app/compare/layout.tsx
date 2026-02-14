import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: '交易员对比',
  description:
    '并排对比加密货币交易员的 ROI、胜率、最大回撤、Arena Score 和权益曲线。',
  alternates: {
    canonical: `${baseUrl}/compare`,
  },
  openGraph: {
    title: '交易员对比 | Arena',
    description: '跨交易所并排对比交易员数据。',
    url: `${baseUrl}/compare`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og-image.png`, width: 1200, height: 630, alt: 'Arena 交易员对比' }],
  },
  twitter: {
    card: 'summary',
    title: '交易员对比 | Arena',
    description: '跨交易所并排对比交易员数据。',
  },
}

export default function CompareLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
