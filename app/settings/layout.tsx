import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Settings | 设置',
  description: 'Manage your ArenaFi account settings — profile, notifications, privacy, and exchange connections. | 管理你的 Arena 账号设置 — 个人资料、通知、隐私和交易所绑定。',
  alternates: {
    canonical: `${baseUrl}/settings`,
  },
  robots: {
    index: false,
    follow: false,
  },
}

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
