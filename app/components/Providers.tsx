'use client'

import { ReactNode } from 'react'
import { LanguageProvider } from './Utils/LanguageProvider'
import { ToastProvider } from './UI/Toast'
import { DialogProvider } from './UI/Dialog'

export default function Providers({ children }: { children: ReactNode }) {
  return (
    <LanguageProvider>
      <ToastProvider>
        <DialogProvider>
          {children}
        </DialogProvider>
      </ToastProvider>
    </LanguageProvider>
  )
}

