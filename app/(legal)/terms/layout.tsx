import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: '服务条款',
  description: 'ArenaFi 服务条款 -- 平台使用规则、指南和用户协议。',
  alternates: {
    canonical: `${baseUrl}/terms`,
  },
}

export default function TermsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
