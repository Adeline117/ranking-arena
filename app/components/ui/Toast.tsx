'use client'

import { createContext, useContext, useState, useCallback, useMemo, ReactNode, useEffect, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { setGlobalToast } from '@/lib/hooks/useApiMutation'
import { t } from '@/lib/i18n'

type ToastType = 'success' | 'error' | 'warning' | 'info'

interface ToastAction {
  label: string
  onClick: () => void
}

interface Toast {
  id: string
  message: string
  type: ToastType
  duration: number
  createdAt: number
  txHash?: string
  chainId?: number
  action?: ToastAction
}

// Block explorer URLs by chain ID
const EXPLORER_URLS: Record<number, string> = {
  1: 'https://etherscan.io/tx/',
  8453: 'https://basescan.org/tx/',
  42161: 'https://arbiscan.io/tx/',
  10: 'https://optimistic.etherscan.io/tx/',
  137: 'https://polygonscan.com/tx/',
  56: 'https://bscscan.com/tx/',
}

function getTxExplorerUrl(txHash: string, chainId?: number): string {
  const base = EXPLORER_URLS[chainId || 8453] || EXPLORER_URLS[8453]
  return `${base}${txHash}`
}

interface ToastContextType {
  showToast: (message: string | { message?: string; code?: string; txHash?: string; chainId?: number; action?: ToastAction } | unknown, type?: ToastType, duration?: number) => void
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

const getToastConfig = (type: ToastType) => {
  switch (type) {
    case 'success':
      return {
        gradient: tokens.gradient.successSubtle,
        borderColor: `${tokens.colors.accent.success}50`,
        iconBg: tokens.gradient.success,
        textColor: tokens.colors.accent.success,
        icon: 'OK',
        progressColor: tokens.colors.accent.success,
      }
    case 'error':
      return {
        gradient: tokens.gradient.errorSubtle,
        borderColor: `${tokens.colors.accent.error}50`,
        iconBg: tokens.gradient.error,
        textColor: tokens.colors.accent.error,
        icon: 'X',
        progressColor: tokens.colors.accent.error,
      }
    case 'warning':
      return {
        gradient: tokens.gradient.warningSubtle,
        borderColor: `${tokens.colors.accent.warning}50`,
        iconBg: tokens.gradient.warning,
        textColor: tokens.colors.accent.warning,
        icon: '!',
        progressColor: tokens.colors.accent.warning,
      }
    case 'info':
    default:
      return {
        gradient: tokens.gradient.primarySubtle,
        borderColor: `${tokens.colors.accent.primary}50`,
        iconBg: tokens.gradient.primary,
        textColor: tokens.colors.accent.primary,
        icon: 'i',
        progressColor: tokens.colors.accent.primary,
      }
  }
}

function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const config = getToastConfig(toast.type)
  const [isExiting, setIsExiting] = useState(false)
  const [progress, setProgress] = useState(100)
  const startTimeRef = useRef(Date.now())
  const exitTimerRef = useRef<NodeJS.Timeout | null>(null)

  // #25: Swipe-to-dismiss touch state
  const touchStartXRef = useRef(0)
  const touchDeltaRef = useRef(0)
  const toastElRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const interval = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current
      const remaining = Math.max(0, 100 - (elapsed / toast.duration) * 100)
      setProgress(remaining)

      if (remaining <= 0) {
        clearInterval(interval)
      }
    }, 50)

    return () => clearInterval(interval)
  }, [toast.duration])

  // Cleanup exit timer on unmount
  useEffect(() => {
    return () => {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current)
      }
    }
  }, [])

  const handleClose = () => {
    setIsExiting(true)
    exitTimerRef.current = setTimeout(onClose, 200)
  }

  // #25: Touch event handlers for swipe-to-dismiss
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartXRef.current = e.touches[0].clientX
    touchDeltaRef.current = 0
  }
  const handleTouchMove = (e: React.TouchEvent) => {
    const dx = e.touches[0].clientX - touchStartXRef.current
    touchDeltaRef.current = dx
    const el = toastElRef.current
    if (el) {
      el.style.transform = `translateX(${dx}px)`
      el.style.opacity = String(Math.max(0, 1 - Math.abs(dx) / 200))
      el.style.transition = 'none'
    }
  }
  const handleTouchEnd = () => {
    const el = toastElRef.current
    if (Math.abs(touchDeltaRef.current) > 80) {
      // Dismiss
      if (el) {
        el.style.transition = 'transform 0.2s ease, opacity 0.2s ease'
        el.style.transform = `translateX(${touchDeltaRef.current > 0 ? 300 : -300}px)`
        el.style.opacity = '0'
      }
      setTimeout(onClose, 200)
    } else {
      // Snap back
      if (el) {
        el.style.transition = 'transform 0.2s ease, opacity 0.2s ease'
        el.style.transform = 'translateX(0)'
        el.style.opacity = '1'
      }
    }
    touchDeltaRef.current = 0
  }

  return (
    <div
      ref={toastElRef}
      className={isExiting ? 'toast-exit' : 'toast-enter'}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--glass-bg-secondary)',
        backdropFilter: tokens.glass.blur.lg,
        WebkitBackdropFilter: tokens.glass.blur.lg,
        border: `1px solid ${config.borderColor}`,
        borderRadius: tokens.radius.xl,
        overflow: 'hidden',
        minWidth: 'min(320px, calc(100vw - 40px))',
        maxWidth: 'min(420px, calc(100vw - 40px))',
        boxShadow: 'var(--shadow-xl, 0 20px 40px rgba(0,0,0,0.15))',
      }}
    >
      {/* Content */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[3],
          padding: tokens.spacing[4],
        }}
      >
        {/* Icon */}
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: tokens.radius.full,
            background: config.iconBg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            boxShadow: `0 4px 12px ${config.textColor}40`,
          }}
        >
          <span style={{ 
            color: tokens.colors.white, 
            fontSize: 14, 
            fontWeight: 900,
            textShadow: 'var(--text-shadow-sm)',
          }}>
            {config.icon}
          </span>
        </div>
        
        {/* Message */}
        <div style={{ flex: 1 }}>
          <span style={{ 
            color: tokens.colors.text.primary,
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: tokens.typography.fontWeight.semibold,
            lineHeight: 1.4,
          }}>
            {toast.message}
          </span>
          {toast.txHash && (
            <a
              href={getTxExplorerUrl(toast.txHash, toast.chainId)}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'block',
                fontSize: tokens.typography.fontSize.xs,
                color: tokens.colors.accent.brand,
                marginTop: 4,
                textDecoration: 'none',
                opacity: 0.85,
              }}
            >
              Tx: {toast.txHash.slice(0, 6)}...{toast.txHash.slice(-4)} ↗
            </a>
          )}
        </div>

        {/* Action Button (optional undo / custom action) */}
        {toast.action && (
          <button
            onClick={() => { toast.action!.onClick(); handleClose() }}
            className="btn-press"
            style={{
              background: `${config.textColor}18`,
              border: `1px solid ${config.textColor}40`,
              color: config.textColor,
              cursor: 'pointer',
              padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: tokens.typography.fontWeight.bold,
              borderRadius: tokens.radius.md,
              whiteSpace: 'nowrap',
              flexShrink: 0,
              transition: 'background 150ms ease',
            }}
          >
            {toast.action.label}
          </button>
        )}

        {/* Close Button */}
        <button
          onClick={handleClose}
          aria-label="Dismiss notification"
          className="btn-press toast-close-btn focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
          style={{
            background: 'transparent',
            border: 'none',
            color: tokens.colors.text.tertiary,
            cursor: 'pointer',
            padding: tokens.spacing[1],
            fontSize: 18,
            lineHeight: 1.2,
            borderRadius: tokens.radius.full,
            width: 28,
            height: 28,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background 150ms ease, color 150ms ease',
          }}
        >
          ×
        </button>
      </div>
      
      {/* Progress Bar */}
      <div
        style={{
          height: 3,
          background: 'var(--color-bg-tertiary)',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${progress}%`,
            background: `linear-gradient(90deg, ${config.progressColor}, ${config.progressColor}80)`,
            transition: 'width 0.05s linear',
            borderRadius: '0 2px 2px 0',
          }}
        />
      </div>
    </div>
  )
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const dismissTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map())

  useEffect(() => {
    const timers = dismissTimersRef.current
    return () => {
      timers.forEach((timer) => clearTimeout(timer))
      timers.clear()
    }
  }, [])

  const showToast = useCallback((
    message: string | { message?: string; code?: string; error?: string } | unknown,
    type: ToastType = 'info',
    duration?: number
  ) => {
    // Error/warning toasts need more reading time
    const defaultDurations: Record<ToastType, number> = {
      success: 4000,
      info: 4000,
      warning: 5000,
      error: 5500,
    }
    const finalDuration = duration ?? defaultDurations[type]
    // Parse message
    let finalMessage: string
    if (typeof message === 'string') {
      finalMessage = message
    } else if (message && typeof message === 'object') {
      const msgObj = message as Record<string, unknown>
      if (typeof msgObj.message === 'string') {
        finalMessage = msgObj.message
      } else if (typeof msgObj.error === 'string') {
        finalMessage = msgObj.error
      } else if (typeof msgObj.msg === 'string') {
        finalMessage = msgObj.msg
      } else {
        finalMessage = t('operationFailed')
      }
    } else {
      finalMessage = String(message || t('unknownError'))
    }

    // Extract txHash and action if present
    let txHash: string | undefined
    let chainId: number | undefined
    let action: ToastAction | undefined
    if (message && typeof message === 'object') {
      const msgObj = message as Record<string, unknown>
      if (typeof msgObj.txHash === 'string') txHash = msgObj.txHash
      if (typeof msgObj.chainId === 'number') chainId = msgObj.chainId
      if (msgObj.action && typeof msgObj.action === 'object') {
        const a = msgObj.action as Record<string, unknown>
        if (typeof a.label === 'string' && typeof a.onClick === 'function') {
          action = { label: a.label, onClick: a.onClick as () => void }
        }
      }
    }

    const id = `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    const newToast: Toast = { id, message: finalMessage, type, duration: finalDuration, createdAt: Date.now(), txHash, chainId, action }

    setToasts((prev) => {
      // Deduplicate: skip if same message shown within last 1.5s
      const isDuplicate = prev.some(
        (t) => t.message === finalMessage && Date.now() - t.createdAt < 1500
      )
      if (isDuplicate) return prev
      return [...prev.slice(-4), newToast]
    })

    if (finalDuration > 0) {
      const timer = setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id))
        dismissTimersRef.current.delete(id)
      }, finalDuration)
      dismissTimersRef.current.set(id, timer)
    }
  }, [])

  const hideToast = useCallback((id: string) => {
    // Clear auto-dismiss timer if exists
    const timer = dismissTimersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      dismissTimersRef.current.delete(id)
    }
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  // 设置全局 toast 供 useApiMutation 使用
  useEffect(() => {
    setGlobalToast(showToast)
  }, [showToast])

  return (
    <ToastContext.Provider value={useMemo(() => ({ showToast, hideToast }), [showToast, hideToast])}>
      {children}
      
      {/* Toast Container */}
      {toasts.length > 0 && (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="false"
          className="toast-container"
          style={{
            position: 'fixed',
            top: 80,
            right: 16,
            zIndex: tokens.zIndex.toast,
            maxWidth: 'calc(100vw - 32px)',
            display: 'flex',
            flexDirection: 'column',
            gap: tokens.spacing[3],
            pointerEvents: 'none',
          }}
        >
          {toasts.map((toast) => (
            <div key={toast.id} style={{ pointerEvents: 'auto' }}>
              <ToastItem
                toast={toast}
                onClose={() => hideToast(toast.id)}
              />
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  )
}

export default ToastProvider
