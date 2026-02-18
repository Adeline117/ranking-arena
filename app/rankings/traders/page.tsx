import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

export const metadata: Metadata = {
  title: '交易员排行榜 - Arena',
  description: '全平台顶级加密交易员排行，实时 ROI、胜率、Arena Score 数据。',
}

export default function TradersPage() {
  redirect('/')
}
