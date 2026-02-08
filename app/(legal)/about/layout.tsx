import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: '关于我们',
  description: '了解 ArenaFi -- 聚合 30+ 交易所数据的加密货币交易员排行榜与社区平台。',
  alternates: {
    canonical: `${baseUrl}/about`,
  },
}

export default function AboutLayout({ children }: { children: React.ReactNode }) {
  return children
}
