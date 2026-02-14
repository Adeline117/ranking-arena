import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: '版权政策',
  description: 'Arena 版权与DMCA政策 -- 版权侵权通知与反通知流程。',
  alternates: {
    canonical: `${baseUrl}/dmca`,
  },
}

export default function DmcaLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
