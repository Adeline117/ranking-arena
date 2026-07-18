'use client'

import { ReactNode, useEffect } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { LanguageProvider } from './LanguageProvider'
import { ToastProvider, useToast } from '../ui/Toast'
import { DialogProvider } from '../ui/Dialog'
import { PremiumProvider } from '@/lib/premium/hooks'
import type { UserSubscription, SubscriptionTier } from '@/lib/premium'
import { useMemo } from 'react'
import { initCsrfToken } from '@/lib/api/client'
import { ErrorBoundary } from '../utils/ErrorBoundary'
// SWR fully migrated to React Query — SWRConfigProvider removed
import { getQueryClient } from '@/lib/hooks/queryClient'
import { initializeErrorInterceptors } from '@/lib/middleware/error-interceptor'
import dynamic from 'next/dynamic'
import { useLoginModal } from '@/lib/hooks/useLoginModal'
import { PushViewerSync } from '@/app/components/notifications/PushViewerSync'
const PrivyClientProvider = dynamic(() => import('./PrivyClientProvider'))
const LoginModal = dynamic(() => import('../auth/LoginModal'), { ssr: false })

// Web3Provider is NO LONGER loaded at root level.
// It's lazy-loaded only when wallet features are needed.
// See: lib/web3/provider.tsx (LazyWeb3Provider) and components that use useWeb3()

// 内部组件，用于初始化错误拦截器
function ErrorInterceptorInitializer({ children }: { children: ReactNode }) {
  const { showToast } = useToast()

  useEffect(() => {
    // 初始化错误拦截器 — deferred to avoid blocking hydration
    const init = () =>
      initializeErrorInterceptors((message, type = 'error') => {
        showToast(message, type)
      })
    if ('requestIdleCallback' in window) {
      requestIdleCallback(init, { timeout: 3000 })
    } else {
      setTimeout(init, 1000)
    }
  }, [showToast])

  return <>{children}</>
}

function GlobalLoginModal() {
  const { isOpen, message, closeLoginModal } = useLoginModal()
  if (!isOpen) return null
  return <LoginModal open={isOpen} onClose={closeLoginModal} message={message} />
}

/**
 * ROOT-ROOT CAUSE FIX: Read subscription tier from cookie set by Stripe webhook.
 * This eliminates the 2-4 second requestIdleCallback delay where Pro users
 * see free-tier UI. Cookie is a "hint" — full subscription loads in background.
 */
function PremiumProviderWithSSRHint({ children }: { children: ReactNode }) {
  const initialSub = useMemo<UserSubscription | undefined>(() => {
    if (typeof document === 'undefined') return undefined
    const match = document.cookie.match(/(?:^|;\s*)arena_tier=(\w+)/)
    const tier = match?.[1]
    if (!tier || tier === 'free') return undefined
    return {
      userId: '',
      tier: tier as SubscriptionTier,
      status: 'active',
      startDate: new Date().toISOString(),
      endDate: null,
      trialEndDate: null,
      autoRenew: true,
      usage: {
        apiCallsToday: 0,
        comparisonReportsThisMonth: 0,
        exportsThisMonth: 0,
        currentFollows: 0,
        currentCustomRankings: 0,
      },
    }
  }, [])
  return <PremiumProvider initialSubscription={initialSub}>{children}</PremiumProvider>
}

export default function Providers({ children }: { children: ReactNode }) {
  // Server renders get an isolated cache per request; the browser receives the
  // same singleton across renders and Suspense retries.
  const queryClient = getQueryClient()

  // 初始化 CSRF Token — deferred to avoid blocking hydration
  useEffect(() => {
    if ('requestIdleCallback' in window) {
      requestIdleCallback(() => initCsrfToken(), { timeout: 3000 })
    } else {
      setTimeout(() => initCsrfToken(), 1000)
    }
  }, [])

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <PrivyClientProvider>
          <LanguageProvider>
            <PremiumProviderWithSSRHint>
              <ToastProvider>
                <ErrorInterceptorInitializer>
                  <DialogProvider>
                    {children}
                    <PushViewerSync />
                    <GlobalLoginModal />
                  </DialogProvider>
                </ErrorInterceptorInitializer>
              </ToastProvider>
            </PremiumProviderWithSSRHint>
          </LanguageProvider>
        </PrivyClientProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
