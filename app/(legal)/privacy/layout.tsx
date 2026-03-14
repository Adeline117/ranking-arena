import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Privacy Policy — Arena | How We Protect Your Data',
  description: 'Arena privacy policy — Learn how we collect, use, and protect your personal information. We are committed to transparency and security in handling your data on our crypto trader ranking platform.',
  alternates: {
    canonical: `${baseUrl}/privacy`,
  },
  openGraph: {
    title: 'Privacy Policy — Arena',
    description: 'Learn how Arena protects your personal information. We are committed to transparency and security in handling your data on our crypto trader ranking platform.',
    url: `${baseUrl}/privacy`,
    siteName: 'Arena',
    type: 'website',
    images: [{ 
      url: `${baseUrl}/og-image.png`, 
      width: 1200, 
      height: 630, 
      alt: 'Arena - Privacy Policy' 
    }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Privacy Policy — Arena',
    description: 'Learn how Arena protects your personal information and handles your data securely.',
    images: [`${baseUrl}/og-image.png`],
    creator: '@arenafi',
  },
}

export default function PrivacyLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
