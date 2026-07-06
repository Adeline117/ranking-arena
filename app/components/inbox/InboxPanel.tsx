'use client'

import { useEffect, useRef } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { tokens } from '@/lib/design-tokens'
import { useInboxStore } from '@/lib/stores/inboxStore'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import NotificationsList from './NotificationsList'
import ConversationsList from './ConversationsList'

// Self-contained QueryClient (2026-07-04 修 U10-1):首页 TopNav 刻意在 Providers
// (含 QueryClientProvider)外渲染以保 LCP;点铃铛打开本面板时 NotificationsList/
// ConversationsList 的 useInfiniteQuery 找不到 QueryClient 直接 throw → 首页点铃铛
// 整页崩溃。给面板自带一个 client,任何页面(有无祖先 provider)都自足不崩。
let inboxQueryClient: QueryClient | null = null
function getInboxQueryClient(): QueryClient {
  if (!inboxQueryClient) {
    inboxQueryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
    })
  }
  return inboxQueryClient
}

function InboxPanelInner(): React.ReactElement | null {
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
      className="h-dvh-minus-nav"
      style={{
        position: 'fixed',
        top: 56,
        right: 0,
        width: 'min(400px, 100vw)',
        maxWidth: '100vw',
        background: tokens.colors.bg.primary,
        borderLeft: `1px solid ${tokens.colors.border.primary}`,
        boxShadow: tokens.shadow.xl,
        zIndex: tokens.zIndex.overlay,
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
        <span
          style={{
            fontWeight: 800,
            fontSize: tokens.typography.fontSize.lg,
            color: tokens.colors.text.primary,
          }}
        >
          {t('inbox')}
        </span>
        <button
          aria-label="Close"
          onClick={closePanel}
          className="hover-bg-secondary"
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

export default function InboxPanel(): React.ReactElement | null {
  return (
    <QueryClientProvider client={getInboxQueryClient()}>
      <InboxPanelInner />
    </QueryClientProvider>
  )
}
