import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: '免责声明',
  description: 'Arena 风险免责声明 -- 关于加密货币交易风险和数据准确性的重要信息。',
  alternates: {
    canonical: `${baseUrl}/disclaimer`,
  },
}

export default function DisclaimerLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
