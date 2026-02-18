import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: '版权政策',
  description: 'Arena DMCA policy — copyright infringement notices and counter-notification process.',
  alternates: {
    canonical: `${baseUrl}/dmca`,
  },
}

export default function DmcaLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
