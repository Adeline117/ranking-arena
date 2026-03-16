'use client'

import { ReactNode, useEffect } from 'react'
import { LanguageProvider } from './LanguageProvider'
import { ToastProvider, useToast } from '../ui/Toast'
import { DialogProvider } from '../ui/Dialog'
import { PremiumProvider } from '@/lib/premium/hooks'
import { initCsrfToken } from '@/lib/api/client'
import { ErrorBoundary } from '../utils/ErrorBoundary'
import { SWRConfigProvider } from '@/lib/hooks/SWRConfig'
import { initializeErrorInterceptors } from '@/lib/middleware/error-interceptor'
import dynamic from 'next/dynamic'
import { useLoginModal } from '@/lib/hooks/useLoginModal'
const PrivyClientProvider = dynamic(() => import('./PrivyClientProvider'))
const LoginModal = dynamic(() => import('../auth/LoginModal'), { ssr: false })

// Web3Provider is NO LONGER loaded at root level.
// It's lazy-loaded only when wallet features are needed.
// See: lib/web3/provider.tsx (LazyWeb3Provider) and components that use useWeb3()

// 内部组件，用于初始化错误拦截器
function ErrorInterceptorInitializer({ children }: { children: ReactNode }) {
  const { showToast } = useToast()
  
  useEffect(() => {
    // 初始化错误拦截器，传入 toast 函数
    initializeErrorInterceptors((message, type = 'error') => {
      showToast(message, type)
    })
  }, [showToast])
  
  return <>{children}</>
}

function GlobalLoginModal() {
  const { isOpen, message, closeLoginModal } = useLoginModal()
  if (!isOpen) return null
  return <LoginModal open={isOpen} onClose={closeLoginModal} message={message} />
}

export default function Providers({ children }: { children: ReactNode }) {
  // 初始化 CSRF Token
  useEffect(() => {
    initCsrfToken()
  }, [])

  return (
    <ErrorBoundary>
      <SWRConfigProvider>
        <PrivyClientProvider>
          <LanguageProvider>
            <PremiumProvider>
              <ToastProvider>
                <ErrorInterceptorInitializer>
                  <DialogProvider>
                    {children}
                    <GlobalLoginModal />
                  </DialogProvider>
                </ErrorInterceptorInitializer>
              </ToastProvider>
            </PremiumProvider>
          </LanguageProvider>
        </PrivyClientProvider>
      </SWRConfigProvider>
    </ErrorBoundary>
  )
}


