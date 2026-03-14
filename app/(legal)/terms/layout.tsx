import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Terms of Service | User Agreement & Guidelines',
  description: 'Arena terms of service — Read our platform usage rules, community guidelines, and user agreement. Understand your rights and responsibilities when using our crypto trader ranking platform.',
  alternates: {
    canonical: `${baseUrl}/terms`,
  },
  openGraph: {
    title: 'Terms of Service',
    description: 'Arena terms of service — platform usage rules, community guidelines, and user agreement for our crypto trader ranking platform.',
    url: `${baseUrl}/terms`,
    siteName: 'Arena',
    type: 'website',
    images: [{ 
      url: `${baseUrl}/og-image.png`, 
      width: 1200, 
      height: 630, 
      alt: 'Arena - Terms of Service' 
    }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Terms of Service',
    description: 'Read our platform usage rules, community guidelines, and user agreement.',
    images: [`${baseUrl}/og-image.png`],
    creator: '@arenafi',
  },
}

export default function TermsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
