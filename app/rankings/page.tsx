import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

export const metadata: Metadata = {
  title: 'Rankings',
  description: 'All rankings in crypto. Multi-dimensional trader rankings across 30+ exchanges — ROI, win rate, Arena Score, and more.',
}

export default function RankingsPage() {
  redirect('/')
}
