import { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'
import MethodologyPageClient from './MethodologyPageClient'

export const revalidate = 3600 // ISR: 1 hour (static content)

export const metadata: Metadata = {
  title: 'Arena Score Methodology — How We Rank Traders',
  description:
    'Learn how Arena calculates trader rankings across current public source boards. Our methodology evaluates ROI, PnL, and risk metrics using the Arena Score algorithm.',
  alternates: {
    canonical: `${BASE_URL}/methodology`,
  },
  openGraph: {
    title: 'Arena Score Methodology — How We Rank Crypto Traders',
    description:
      'Learn how Arena Score ranks traders across current public source boards using ROI, PnL, and risk metrics.',
    url: `${BASE_URL}/methodology`,
    siteName: 'Arena',
    type: 'website',
    images: [
      {
        url: `${BASE_URL}/og-image.png`,
        width: 1200,
        height: 630,
        alt: 'Arena Methodology',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Arena Score Methodology — How We Rank Traders',
    description: 'Learn how Arena Score ranks traders across current public source boards.',
    images: [`${BASE_URL}/og-image.png`],
    creator: '@arenafi',
  },
}

export default function MethodologyPage() {
  return <MethodologyPageClient />
}
