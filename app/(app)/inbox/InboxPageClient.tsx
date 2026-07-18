'use client'

import { features } from '@/lib/features'
import { redirect, useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
// MobileBottomNav is rendered by root layout — do not duplicate here
import NotificationsList from '@/app/components/inbox/NotificationsList'
import ConversationsList from '@/app/components/inbox/ConversationsList'
import { useRequireAuth } from '@/lib/hooks/useRequireAuth'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { NotificationsPageSkeleton } from '@/app/components/ui/PageSkeleton'

type TabKey = 'notifications' | 'messages'

export default function InboxPageClient() {
  if (!features.social) redirect('/')

  // U10-7: unify the login-wall param on the shared useRequireAuth (returnUrl=)
  // instead of a hand-written /login?redirect= — the rest of the app uses returnUrl.
  const { isLoggedIn, isLoading } = useRequireAuth()
  const { t } = useLanguage()
  const searchParams = useSearchParams()
  const requestedTab: TabKey = searchParams.get('tab') === 'messages' ? 'messages' : 'notifications'
  const requestedChat =
    searchParams.get('chat') === 'group'
      ? 'group'
      : searchParams.get('chat') === 'direct'
        ? 'direct'
        : 'all'
  const [activeTab, setActiveTab] = useState<TabKey>(requestedTab)

  useEffect(() => setActiveTab(requestedTab), [requestedTab])

  function selectTab(tab: TabKey): void {
    setActiveTab(tab)
    const params = new URLSearchParams(searchParams.toString())
    params.set('tab', tab)
    if (tab !== 'messages') params.delete('chat')
    globalThis.history.replaceState(null, '', `/inbox?${params.toString()}`)
  }

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'notifications', label: t('tabNotifications') },
    { key: 'messages', label: t('tabMessages') },
  ]

  if (isLoading || !isLoggedIn) {
    return <NotificationsPageSkeleton />
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      <div
        style={{
          maxWidth: 600,
          margin: '0 auto',
          padding: `${tokens.spacing[4]} ${tokens.spacing[3]}`,
          paddingBottom: 80,
        }}
      >
        {/* Page header */}
        <div
          style={{
            padding: `${tokens.spacing[5]} ${tokens.spacing[4]} ${tokens.spacing[3]}`,
          }}
        >
          <h1 style={{ fontSize: tokens.typography.fontSize['2xl'], fontWeight: 900, margin: 0 }}>
            {t('u10inbox_pageTitle')}
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
                onClick={() => selectTab(tab.key)}
                style={{
                  padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                  background: 'transparent',
                  border: 'none',
                  borderBottom: isActive
                    ? `2px solid ${tokens.colors.accent.brand}`
                    : '2px solid transparent',
                  color: isActive ? tokens.colors.text.primary : tokens.colors.text.secondary,
                  fontWeight: isActive ? 800 : 600,
                  fontSize: tokens.typography.fontSize.sm,
                  cursor: 'pointer',
                  transition: `all ${tokens.transition.fast}`,
                  marginBottom: -1,
                  minHeight: 44,
                }}
              >
                {tab.label}
              </button>
            )
          })}
        </div>

        {/* Tab content */}
        {activeTab === 'notifications' && <NotificationsList variant="page" />}
        {activeTab === 'messages' && <ConversationsList initialFilter={requestedChat} />}
      </div>
    </div>
  )
}
