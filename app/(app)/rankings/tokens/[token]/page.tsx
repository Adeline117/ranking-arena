import type { Metadata } from 'next'
import TokenRankingContainment from '../TokenRankingContainment'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Token Rankings — Verification Hold',
  description: 'Token rankings are withheld while verified authority snapshots are rebuilt.',
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
}

export default function TokenDetailPage() {
  return <TokenRankingContainment />
}
