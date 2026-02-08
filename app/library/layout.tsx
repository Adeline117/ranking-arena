import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: '交易书库',
  description:
    '精选加密货币交易书籍、指南和教育资源，帮助你构建交易知识体系。',
  alternates: {
    canonical: `${baseUrl}/library`,
  },
  openGraph: {
    title: '交易书库 | ArenaFi',
    description: '精选加密货币交易书籍和教育资源。',
    url: `${baseUrl}/library`,
    siteName: 'ArenaFi',
    type: 'website',
    images: [{ url: `${baseUrl}/og.png`, width: 1200, height: 630, alt: 'ArenaFi 交易书库' }],
  },
  twitter: {
    card: 'summary',
    title: '交易书库 | ArenaFi',
    description: '精选加密货币交易书籍和教育资源。',
  },
}

export default function LibraryLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
