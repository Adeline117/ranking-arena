import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

export const metadata: Metadata = {
  title: '排行榜 - Arena',
  description: '多维度加密交易员排行榜，覆盖20+交易所，实时更新。Enter. Outperform.',
}

export default function RankingsPage() {
  redirect('/')
}
