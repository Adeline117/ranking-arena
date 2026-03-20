import type { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'

export const metadata: Metadata = {
  title: '免责声明',
  description: 'Arena risk disclaimer — important information about crypto trading risks and data accuracy.',
  alternates: {
    canonical: `${BASE_URL}/disclaimer`,
  },
}

export default function DisclaimerLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
