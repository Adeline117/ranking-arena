import type { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'

export const metadata: Metadata = {
  title: '版权政策',
  description: 'Arena DMCA policy — copyright infringement notices and counter-notification process.',
  alternates: {
    canonical: `${BASE_URL}/dmca`,
  },
}

export default function DmcaLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
