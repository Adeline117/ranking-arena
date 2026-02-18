import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: '免责声明',
  description: 'Arena risk disclaimer — important information about crypto trading risks and data accuracy.',
  alternates: {
    canonical: `${baseUrl}/disclaimer`,
  },
}

export default function DisclaimerLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
