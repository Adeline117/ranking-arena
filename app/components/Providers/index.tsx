'use client'

import { ReactNode, useEffect } from 'react'
import { LanguageProvider } from './LanguageProvider'
import { ToastProvider } from '../ui/Toast'
import { DialogProvider } from '../ui/Dialog'
import { PremiumProvider } from '@/lib/premium/hooks'
import { initCsrfToken } from '@/lib/api/client'
import { ErrorBoundary } from './ErrorBoundary'
import { SWRConfigProvider } from '@/lib/hooks/SWRConfig'

export default function Providers({ children }: { children: ReactNode }) {
  // 初始化 CSRF Token
  useEffect(() => {
    initCsrfToken()
  }, [])
  
  return (
    <ErrorBoundary>
      <SWRConfigProvider>
        <LanguageProvider>
          <PremiumProvider>
            <ToastProvider>
              <DialogProvider>
                {children}
              </DialogProvider>
            </ToastProvider>
          </PremiumProvider>
        </LanguageProvider>
      </SWRConfigProvider>
    </ErrorBoundary>
  )
}


