import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: '服务条款 — Arena',
  description: 'Arena terms of service — platform usage rules, guidelines, and user agreement.',
  alternates: {
    canonical: `${baseUrl}/terms`,
  },
  openGraph: {
    title: 'Terms of Service — Arena',
    description: 'Arena terms of service — platform usage rules, guidelines, and user agreement.',
    url: `${baseUrl}/terms`,
    siteName: 'Arena',
    type: 'website',
  },
}

export default function TermsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
