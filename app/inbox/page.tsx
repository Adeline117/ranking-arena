'use client'

import { features } from '@/lib/features'
import { notFound } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
// MobileBottomNav is rendered by root layout — do not duplicate here
import NotificationsList from '@/app/components/inbox/NotificationsList'
import ConversationsList from '@/app/components/inbox/ConversationsList'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

type TabKey = 'notifications' | 'messages'


export default function InboxPage() {
  if (!features.social) notFound()

  const router = useRouter()
  const { email, authChecked, accessToken } = useAuthSession()
  const { t } = useLanguage()
  const [activeTab, setActiveTab] = useState<TabKey>('notifications')

  useEffect(() => {
    if (authChecked && !accessToken) {
      router.push('/login?redirect=/inbox')
    }
  }, [authChecked, accessToken, router])

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'notifications', label: t('tabNotifications') },
    { key: 'messages', label: t('tabMessages') },
  ]

  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <div style={{ maxWidth: 600, margin: '0 auto', padding: `${tokens.spacing[4]} ${tokens.spacing[3]}`, paddingBottom: 80 }}>
        {/* Page header */}
        <div
          style={{
            padding: `${tokens.spacing[5]} ${tokens.spacing[4]} ${tokens.spacing[3]}`,
          }}
        >
          <h1 style={{ fontSize: tokens.typography.fontSize['2xl'], fontWeight: 900, margin: 0 }}>
            {t('inbox')}
          </h1>
        </div>

        {/* Tabs */}
        <div
          style={{
            display: 'flex',
            gap: tokens.spacing[1],
            padding: `0 ${tokens.spacing[4]}`,
            marginBottom: tokens.spacing[4],
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          {tabs.map((tab) => {
            const isActive = activeTab === tab.key
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                style={{
                  padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                  background: 'transparent',
                  border: 'none',
                  borderBottom: isActive ? `2px solid ${tokens.colors.accent.brand}` : '2px solid transparent',
                  color: isActive ? tokens.colors.text.primary : tokens.colors.text.secondary,
                  fontWeight: isActive ? 800 : 600,
                  fontSize: tokens.typography.fontSize.sm,
                  cursor: 'pointer',
                  transition: `all ${tokens.transition.fast}`,
                  marginBottom: -1,
                }}
              >
                {tab.label}
              </button>
            )
          })}
        </div>

        {/* Tab content */}
        {activeTab === 'notifications' && <NotificationsList />}
        {activeTab === 'messages' && <ConversationsList />}
      </div>
    </div>
  )
}
