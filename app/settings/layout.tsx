import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: '设置 | Arena',
  description: '管理你的 Arena 账号设置 — 个人资料、通知、隐私和交易所绑定。',
}

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
