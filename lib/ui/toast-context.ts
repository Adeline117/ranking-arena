'use client'

/**
 * Toast context, types and hook. Lives in lib/ so lib hooks can raise toasts
 * without importing app/. The provider UI stays in app/components/ui/Toast.
 */

import { createContext, useContext } from 'react'

export type ToastType = 'success' | 'error' | 'warning' | 'info'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface Toast {
  id: string
  message: string
  type: ToastType
  duration: number
  createdAt: number
  txHash?: string
  chainId?: number
  action?: ToastAction
}

export interface ToastContextType {
  showToast: (
    message:
      | string
      | { message?: string; code?: string; txHash?: string; chainId?: number; action?: ToastAction }
      | unknown,
    type?: ToastType,
    duration?: number
  ) => void
  hideToast: (id: string) => void
}

export const ToastContext = createContext<ToastContextType | null>(null)

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider')
  }
  return context
}
