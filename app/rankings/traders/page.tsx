import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

export const metadata: Metadata = {
  title: 'Trader Rankings - Arena',
  description: 'Top crypto traders ranked by ROI, win rate, max drawdown, and Arena Score across all platforms.',
}

export default function TradersPage() {
  redirect('/')
}
