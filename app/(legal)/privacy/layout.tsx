import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: '隐私政策 — Arena',
  description: 'Arena 隐私政策 -- 我们如何收集、使用和保护你的个人数据。',
  alternates: {
    canonical: `${baseUrl}/privacy`,
  },
  openGraph: {
    title: 'Privacy Policy — Arena',
    description: 'Arena privacy policy — how we collect, use, and protect your personal data.',
    url: `${baseUrl}/privacy`,
    siteName: 'Arena',
    type: 'website',
  },
}

export default function PrivacyLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
