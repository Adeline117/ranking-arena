import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

export const metadata: Metadata = {
  title: 'Rankings',
  description: 'Multi-dimensional crypto trader rankings across 20+ exchanges. Real-time ROI, win rate, and Arena Score. Enter. Outperform.',
}

export default function RankingsPage() {
  redirect('/')
}
