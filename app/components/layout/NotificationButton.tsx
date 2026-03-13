'use client'

import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import { NotificationIcon } from '../ui/icons'
import { useLanguage } from '../Providers/LanguageProvider'
import { useInboxStore } from '@/lib/stores/inboxStore'

export interface NotificationButtonProps {
  totalUnread: number
}

export default function NotificationButton({ totalUnread }: NotificationButtonProps) {
  const { t } = useLanguage()
  const router = useRouter()

  return (
    <button
      data-inbox-trigger
      className="top-nav-notif-btn"
      aria-label={t('inbox')}
      onClick={() => {
        // On mobile, navigate to inbox page; on desktop, toggle panel
        if (window.innerWidth < 1024) {
          router.push('/inbox')
        } else {
          useInboxStore.getState().togglePanel()
        }
      }}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 44,
        height: 44,
        borderRadius: tokens.radius.full,
        background: 'transparent',
        color: 'var(--color-text-secondary)',
        border: 'none',
        cursor: 'pointer',
        transition: `all ${tokens.transition.base}`,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = tokens.glass.bg.light
        e.currentTarget.style.color = 'var(--color-text-primary)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
        e.currentTarget.style.color = 'var(--color-text-secondary)'
      }}
    >
      <NotificationIcon size={20} />
      {totalUnread > 0 && (
        <Box
          style={{
            position: 'absolute',
            top: -1,
            right: -3,
            minWidth: 18,
            height: 18,
            borderRadius: tokens.radius.md,
            background: tokens.gradient.error,
            border: `2px solid var(--color-bg-primary)`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 4px',
            boxShadow: tokens.shadow.glowError,
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 800, color: tokens.colors.white, lineHeight: 1 }}>
            {totalUnread > 99 ? '99+' : totalUnread}
          </span>
        </Box>
      )}
    </button>
  )
}
