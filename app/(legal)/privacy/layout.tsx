import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: '隐私政策',
  description: 'ArenaFi 隐私政策 -- 我们如何收集、使用和保护你的个人数据。',
  alternates: {
    canonical: `${baseUrl}/privacy`,
  },
}

export default function PrivacyLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
