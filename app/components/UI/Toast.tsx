'use client'

import { createContext, useContext, useState, useCallback, ReactNode } from 'react'
import { tokens } from '@/lib/design-tokens'

type ToastType = 'success' | 'error' | 'warning' | 'info'

interface Toast {
  id: string
  message: string
  type: ToastType
  duration?: number
}

interface ToastContextType {
  showToast: (message: string, type?: ToastType, duration?: number) => void
  hideToast: (id: string) => void
}

const ToastContext = createContext<ToastContextType | null>(null)

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider')
  }
  return context
}

const getToastStyles = (type: ToastType) => {
  const successColor = tokens.colors.accent.success
  const errorColor = tokens.colors.accent.error
  const warningColor = tokens.colors.accent.warning
  
  switch (type) {
    case 'success':
      return {
        background: `${successColor}20`,
        border: `1px solid ${successColor}66`,
        color: successColor,
        icon: '✓',
      }
    case 'error':
      return {
        background: `${errorColor}20`,
        border: `1px solid ${errorColor}66`,
        color: errorColor,
        icon: '✕',
      }
    case 'warning':
      return {
        background: `${warningColor}20`,
        border: `1px solid ${warningColor}66`,
        color: warningColor,
        icon: '⚠',
      }
    case 'info':
    default:
      return {
        background: `${tokens.colors.accent.primary}20`,
        border: `1px solid ${tokens.colors.accent.primary}66`,
        color: tokens.colors.accent.primary,
        icon: 'ℹ',
      }
  }
}

function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const styles = getToastStyles(toast.type)

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 16px',
        borderRadius: 12,
        background: styles.background,
        border: styles.border,
        color: styles.color,
        fontSize: 14,
        fontWeight: 600,
        minWidth: 280,
        maxWidth: 400,
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
        animation: 'toastSlideIn 0.3s ease-out',
      }}
    >
      <span style={{ fontSize: 16, fontWeight: 900 }}>{styles.icon}</span>
      <span style={{ flex: 1 }}>{toast.message}</span>
      <button
        onClick={onClose}
        style={{
          background: 'transparent',
          border: 'none',
          color: styles.color,
          cursor: 'pointer',
          padding: 4,
          fontSize: 18,
          lineHeight: 1,
          opacity: 0.7,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1' }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7' }}
      >
        ×
      </button>
    </div>
  )
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const showToast = useCallback((message: string, type: ToastType = 'info', duration: number = 3000) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    const newToast: Toast = { id, message, type, duration }
    
    setToasts((prev) => [...prev, newToast])

    if (duration > 0) {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id))
      }, duration)
    }
  }, [])

  const hideToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ showToast, hideToast }}>
      {children}
      
      {/* Toast Container */}
      {toasts.length > 0 && (
        <div
          style={{
            position: 'fixed',
            top: 80,
            right: 20,
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {toasts.map((toast) => (
            <ToastItem
              key={toast.id}
              toast={toast}
              onClose={() => hideToast(toast.id)}
            />
          ))}
        </div>
      )}

      {/* Animation styles */}
      <style jsx global>{`
        @keyframes toastSlideIn {
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
    </ToastContext.Provider>
  )
}

export default ToastProvider

