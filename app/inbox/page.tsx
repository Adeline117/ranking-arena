'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import NotificationsList from '@/app/components/inbox/NotificationsList'
import ConversationsList from '@/app/components/inbox/ConversationsList'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export default function InboxPage() {
  const router = useRouter()
  const { email, authChecked, accessToken } = useAuthSession()
  const { t } = useLanguage()

  useEffect(() => {
    if (authChecked && !accessToken) {
      router.push('/login')
    }
  }, [authChecked, accessToken, router])

  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <main style={{ maxWidth: 600, margin: '0 auto', padding: `${tokens.spacing[4]} ${tokens.spacing[3]}`, paddingBottom: 80 }}>
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

        {/* Notifications section */}
        <NotificationsList />

        {/* Conversations section */}
        <ConversationsList />
      </main>

      <MobileBottomNav />
    </div>
  )
}
