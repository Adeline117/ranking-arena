'use client'

import { ReactNode, useEffect } from 'react'
import { LanguageProvider } from './Utils/LanguageProvider'
import { ToastProvider } from './UI/Toast'
import { DialogProvider } from './UI/Dialog'
import { PremiumProvider } from '@/lib/premium/hooks'
import { initCsrfToken } from '@/lib/api/client'

export default function Providers({ children }: { children: ReactNode }) {
  // 初始化 CSRF Token
  useEffect(() => {
    initCsrfToken()
  }, [])
  
  return (
    <LanguageProvider>
      <PremiumProvider>
        <ToastProvider>
          <DialogProvider>
            {children}
          </DialogProvider>
        </ToastProvider>
      </PremiumProvider>
    </LanguageProvider>
  )
}


