import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Portfolio',
  description: 'Track your connected exchange portfolio performance, positions, and PnL on Arena.',
  robots: { index: false, follow: false },
}

export default function PortfolioLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
