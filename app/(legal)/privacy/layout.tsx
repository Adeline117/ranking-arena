import type { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'

export const metadata: Metadata = {
  title: 'Privacy Policy | How We Protect Your Data',
  description: 'Arena privacy policy — Learn how we collect, use, and protect your personal information. We are committed to transparency and security in handling your data on our crypto trader ranking platform.',
  alternates: {
    canonical: `${BASE_URL}/privacy`,
  },
  openGraph: {
    title: 'Privacy Policy',
    description: 'Learn how Arena protects your personal information. We are committed to transparency and security in handling your data on our crypto trader ranking platform.',
    url: `${BASE_URL}/privacy`,
    siteName: 'Arena',
    type: 'website',
    images: [{ 
      url: `${BASE_URL}/og-image.png`, 
      width: 1200, 
      height: 630, 
      alt: 'Arena - Privacy Policy' 
    }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Privacy Policy',
    description: 'Learn how Arena protects your personal information and handles your data securely.',
    images: [`${BASE_URL}/og-image.png`],
    creator: '@arenafi',
  },
}

export default function PrivacyLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
