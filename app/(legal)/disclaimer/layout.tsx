import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Disclaimer',
  description: 'Arena risk disclaimer - important information about crypto trading risks and data accuracy.',
}

export default function DisclaimerLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
