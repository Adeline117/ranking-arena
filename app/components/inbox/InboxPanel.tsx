'use client'

import { useEffect, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useInboxStore } from '@/lib/stores/inboxStore'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import NotificationsList from './NotificationsList'
import ConversationsList from './ConversationsList'

export default function InboxPanel(): React.ReactElement | null {
  const panelOpen = useInboxStore((s) => s.panelOpen)
  const closePanel = useInboxStore((s) => s.closePanel)
  const panelRef = useRef<HTMLDivElement>(null)
  const { t } = useLanguage()

  useEffect(() => {
    if (!panelOpen) return

    function handleClickOutside(e: MouseEvent): void {
      if (!panelRef.current?.contains(e.target as Node)) {
        const target = e.target as HTMLElement
        if (target.closest('[data-inbox-trigger]')) return
        closePanel()
      }
    }

    function handleEsc(e: KeyboardEvent): void {
      if (e.key === 'Escape') closePanel()
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEsc)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [panelOpen, closePanel])

  if (!panelOpen) return null

  return (
    <div
      ref={panelRef}
      style={{
        position: 'fixed',
        top: 56,
        right: 0,
        width: 400,
        maxWidth: '100vw',
        height: 'calc(100vh - 56px)',
        background: tokens.colors.bg.primary,
        borderLeft: `1px solid ${tokens.colors.border.primary}`,
        boxShadow: tokens.shadow.xl,
        zIndex: 45,
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        animation: 'slideInRight 0.2s ease',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: `${tokens.spacing[4]} ${tokens.spacing[4]}`,
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
          position: 'sticky',
          top: 0,
          background: tokens.colors.bg.primary,
          zIndex: 1,
        }}
      >
        <span style={{ fontWeight: 800, fontSize: tokens.typography.fontSize.lg, color: tokens.colors.text.primary }}>
          {t('inbox')}
        </span>
        <button
          onClick={closePanel}
          style={{
            width: 32,
            height: 32,
            borderRadius: '50%',
            border: 'none',
            background: 'transparent',
            color: tokens.colors.text.secondary,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 18,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = tokens.colors.bg.secondary }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
        >
          ×
        </button>
      </div>

      {/* Notifications section */}
      <NotificationsList />

      {/* Conversations section */}
      <ConversationsList />

      {/* Inline animation style */}
      <style jsx global>{`
        @keyframes slideInRight {
          from {
            transform: translateX(100%);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
      `}</style>
    </div>
  )
}
