'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import NotificationsList from '@/app/components/inbox/NotificationsList'
import ConversationsList from '@/app/components/inbox/ConversationsList'

export default function InboxPage() {
  const router = useRouter()
  const [email, setEmail] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        router.push('/login')
        return
      }
      setEmail(session.user?.email ?? null)
    })
  }, [router])

  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <main style={{ maxWidth: 600, margin: '0 auto', paddingBottom: 80 }}>
        {/* Page header */}
        <div
          style={{
            padding: `${tokens.spacing[5]} ${tokens.spacing[4]} ${tokens.spacing[3]}`,
          }}
        >
          <h1 style={{ fontSize: tokens.typography.fontSize['2xl'], fontWeight: 900, margin: 0 }}>
            收件箱
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
