import type { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'

export const metadata: Metadata = {
  title: 'Claim Your Crypto Trader Profile',
  description: 'Verify your identity and take ownership of your trader profile on Arena. Get a verified badge, edit your bio, and stand out on the leaderboard.',
  openGraph: {
    title: 'Claim Your Crypto Trader Profile',
    description: 'Verify your identity and take ownership of your trader profile on Arena. Get a verified badge and customize your profile.',
    url: `${BASE_URL}/claim`,
    siteName: 'Arena',
    type: 'website',
    images: [
      {
        url: '/api/og?type=claim&title=Claim+Your+Trader+Profile&subtitle=Verify+ownership+and+take+control',
        width: 1200,
        height: 630,
        alt: 'Claim Your Trader Profile on Arena',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Claim Your Crypto Trader Profile',
    description: 'Verify your identity and take ownership of your trader profile on Arena.',
  },
  alternates: {
    canonical: `${BASE_URL}/claim`,
  },
}

export default function ClaimLayout({ children }: { children: React.ReactNode }) {
  return children
}
