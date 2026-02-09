import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'System Status',
  description: 'Arena platform system status - database, Redis, and data freshness monitoring.',
}

export default function StatusLayout({ children }: { children: React.ReactNode }) {
  return children
}
