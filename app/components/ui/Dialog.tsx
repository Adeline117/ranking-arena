'use client'

import { createContext, useContext, useState, useCallback, useMemo, ReactNode, useEffect, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { t } from '@/lib/i18n'

interface DialogOptions {
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  type?: 'confirm' | 'alert' | 'danger'
  onConfirm?: () => void | Promise<void>
  onCancel?: () => void
}

interface DialogContextType {
  showDialog: (options: DialogOptions) => Promise<boolean>
  showAlert: (title: string, message: string) => Promise<void>
  showConfirm: (title: string, message: string) => Promise<boolean>
  showDangerConfirm: (title: string, message: string) => Promise<boolean>
  hideDialog: () => void
}

const DialogContext = createContext<DialogContextType | null>(null)

function getDialogIcon(type?: string): string {
  if (type === 'danger') return '\u26A0'
  if (type === 'alert') return '\u2139'
  return '?'
}

export function useDialog() {
  const context = useContext(DialogContext)
  if (!context) {
    throw new Error('useDialog must be used within a DialogProvider')
  }
  return context
}

interface DialogState {
  isOpen: boolean
  isExiting: boolean
  options: DialogOptions | null
  resolve: ((value: boolean) => void) | null
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState>({
    isOpen: false,
    isExiting: false,
    options: null,
    resolve: null,
  })
  const [isLoading, setIsLoading] = useState(false)
  const closeTimerRef = useRef<NodeJS.Timeout | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  // Cleanup close timer on unmount
  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current)
      }
    }
  }, [])

  // Forward declaration ref for handleCancel (used in useEffect before declaration)
  const handleCancelRef = useRef<() => void>(() => {})

  // Scroll lock when dialog is open
  useEffect(() => {
    if (state.isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [state.isOpen])

  // Focus trap + escape key
  useEffect(() => {
    if (!state.isOpen) return

    // Save previously focused element
    previousFocusRef.current = document.activeElement as HTMLElement

    // Focus the dialog after render
    const timer = setTimeout(() => {
      if (dialogRef.current) {
        const firstButton = dialogRef.current.querySelector('button') as HTMLElement
        firstButton?.focus()
      }
    }, 50)

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleCancelRef.current()
        return
      }

      // Focus trap: keep Tab within dialog
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
        if (focusable.length === 0) return

        const first = focusable[0]
        const last = focusable[focusable.length - 1]

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault()
            last.focus()
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault()
            first.focus()
          }
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('keydown', handleKeyDown)
      // Restore focus when dialog closes
      previousFocusRef.current?.focus()
    }
  }, [state.isOpen])

  const showDialog = useCallback((options: DialogOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setState({
        isOpen: true,
        isExiting: false,
        options,
        resolve,
      })
    })
  }, [])

  const showAlert = useCallback((title: string, message: string): Promise<void> => {
    return new Promise((resolve) => {
      setState({
        isOpen: true,
        isExiting: false,
        options: {
          title,
          message,
          type: 'alert',
          confirmText: t('confirm'),
        },
        resolve: () => resolve(),
      })
    })
  }, [])

  const showConfirm = useCallback((title: string, message: string): Promise<boolean> => {
    return showDialog({
      title,
      message,
      type: 'confirm',
      confirmText: t('confirm'),
      cancelText: t('cancel'),
    })
  }, [showDialog])

  const showDangerConfirm = useCallback((title: string, message: string): Promise<boolean> => {
    return showDialog({
      title,
      message,
      type: 'danger',
      confirmText: t('confirm'),
      cancelText: t('cancel'),
    })
  }, [showDialog])

  const closeDialog = useCallback(() => {
    // Clear any existing close timer
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
    }
    setState(prev => ({ ...prev, isExiting: true }))
    closeTimerRef.current = setTimeout(() => {
      setState({
        isOpen: false,
        isExiting: false,
        options: null,
        resolve: null,
      })
      closeTimerRef.current = null
    }, 200)
  }, [])

  const hideDialog = useCallback(() => {
    if (state.resolve) {
      state.resolve(false)
    }
    closeDialog()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- state is an object; only re-create when resolve ref changes, not on every state update
  }, [state.resolve, closeDialog])

  const handleConfirm = useCallback(async () => {
    if (state.options?.onConfirm) {
      setIsLoading(true)
      try {
        await state.options.onConfirm()
      } finally {
        setIsLoading(false)
      }
    }
    if (state.resolve) {
      state.resolve(true)
    }
    closeDialog()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- state is an object; only re-create when options/resolve change, not on every state update
  }, [state.options, state.resolve, closeDialog])

  const handleCancel = useCallback(() => {
    if (state.options?.onCancel) {
      state.options.onCancel()
    }
    if (state.resolve) {
      state.resolve(false)
    }
    closeDialog()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- state is an object; only re-create when options/resolve change, not on every state update
  }, [state.options, state.resolve, closeDialog])

  // Keep ref in sync
  handleCancelRef.current = handleCancel

  const getButtonConfig = () => {
    if (state.options?.type === 'danger') {
      return {
        gradient: tokens.gradient.error,
        shadowColor: `${tokens.colors.accent.error}40`,
        hoverShadow: tokens.shadow.glowError,
      }
    }
    return {
      gradient: tokens.gradient.primary,
      shadowColor: `${tokens.colors.accent.primary}40`,
      hoverShadow: tokens.shadow.glow,
    }
  }

  const buttonConfig = getButtonConfig()

  const contextValue = useMemo(
    () => ({ showDialog, showAlert, showConfirm, showDangerConfirm, hideDialog }),
    [showDialog, showAlert, showConfirm, showDangerConfirm, hideDialog]
  )

  return (
    <DialogContext.Provider value={contextValue}>
      {children}
      
      {/* Dialog Overlay */}
      {state.isOpen && state.options && (
        <div
          onClick={handleCancel}
          className={state.isExiting ? 'modal-overlay-exit' : 'modal-overlay-enter'}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'var(--color-backdrop-heavy)',
            backdropFilter: tokens.glass.blur.sm,
            WebkitBackdropFilter: tokens.glass.blur.sm,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
            zIndex: tokens.zIndex.modal,
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
            onClick={(e) => e.stopPropagation()}
            className={`dialog-overlay-mobile ${state.isExiting ? 'modal-content-exit' : 'modal-content-enter'}`}
            style={{
              width: '100%',
              maxWidth: 420,
              background: tokens.glass.bg.secondary,
              backdropFilter: tokens.glass.blur.xl,
              WebkitBackdropFilter: tokens.glass.blur.xl,
              border: tokens.glass.border.medium,
              borderRadius: tokens.radius['2xl'],
              padding: 0,
              boxShadow: `${tokens.shadow.xl}, 0 0 80px var(--color-accent-primary-10)`,
              overflow: 'hidden',
            }}
          >
            {/* Header with gradient accent */}
            <div
              style={{
                height: 4,
                background: state.options.type === 'danger' 
                  ? tokens.gradient.error 
                  : tokens.gradient.primary,
              }}
            />
            
            {/* Content */}
            <div style={{ padding: tokens.spacing[6] }}>
              {/* Icon */}
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: tokens.radius.full,
                  background: state.options.type === 'danger'
                    ? tokens.gradient.errorSubtle
                    : tokens.gradient.primarySubtle,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto',
                  marginBottom: tokens.spacing[4],
                  border: `1px solid ${state.options.type === 'danger' 
                    ? `${tokens.colors.accent.error}30` 
                    : `${tokens.colors.accent.primary}30`}`,
                }}
              >
                <span aria-hidden="true" style={{
                  fontSize: 24,
                  color: state.options.type === 'danger'
                    ? tokens.colors.accent.error
                    : tokens.colors.accent.primary,
                }}>
                  {getDialogIcon(state.options.type)}
                </span>
              </div>
              
              {/* Title */}
              <h2 id="dialog-title" style={{
                fontSize: tokens.typography.fontSize.xl,
                fontWeight: tokens.typography.fontWeight.black,
                color: tokens.colors.text.primary,
                marginBottom: tokens.spacing[2],
                textAlign: 'center',
              }}>
                {state.options.title}
              </h2>

              {/* Message */}
              <p style={{
                fontSize: tokens.typography.fontSize.sm,
                color: tokens.colors.text.secondary,
                lineHeight: 1.6,
                marginBottom: tokens.spacing[6],
                textAlign: 'center',
              }}>
                {state.options.message}
              </p>

              {/* Buttons */}
              <div style={{
                display: 'flex',
                gap: tokens.spacing[3],
                justifyContent: 'center',
              }}>
                {state.options.type !== 'alert' && (
                  <button
                    onClick={handleCancel}
                    className="btn-press"
                    style={{
                      padding: `${tokens.spacing[3]} ${tokens.spacing[6]}`,
                      borderRadius: tokens.radius.lg,
                      border: tokens.glass.border.light,
                      background: tokens.glass.bg.light,
                      color: tokens.colors.text.secondary,
                      fontWeight: tokens.typography.fontWeight.bold,
                      fontSize: tokens.typography.fontSize.sm,
                      cursor: 'pointer',
                      transition: tokens.transition.base,
                      minWidth: 100,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = tokens.glass.bg.medium
                      e.currentTarget.style.color = tokens.colors.text.primary
                      e.currentTarget.style.borderColor = 'var(--glass-border-heavy)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = tokens.glass.bg.light
                      e.currentTarget.style.color = tokens.colors.text.secondary
                      e.currentTarget.style.borderColor = 'var(--glass-border-light)'
                    }}
                  >
                    {state.options.cancelText || t('cancel')}
                  </button>
                )}
                <button
                  onClick={handleConfirm}
                  disabled={isLoading}
                  className="btn-press"
                  style={{
                    padding: `${tokens.spacing[3]} ${tokens.spacing[6]}`,
                    borderRadius: tokens.radius.lg,
                    border: 'none',
                    background: buttonConfig.gradient,
                    color: tokens.colors.white,
                    fontWeight: tokens.typography.fontWeight.black,
                    fontSize: tokens.typography.fontSize.sm,
                    cursor: isLoading ? 'not-allowed' : 'pointer',
                    transition: tokens.transition.base,
                    minWidth: 100,
                    boxShadow: `0 4px 12px ${buttonConfig.shadowColor}`,
                    opacity: isLoading ? 0.7 : 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: tokens.spacing[2],
                  }}
                  onMouseEnter={(e) => {
                    if (!isLoading) {
                      e.currentTarget.style.transform = 'translateY(-2px)'
                      e.currentTarget.style.boxShadow = buttonConfig.hoverShadow
                    }
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = 'translateY(0)'
                    e.currentTarget.style.boxShadow = `0 4px 12px ${buttonConfig.shadowColor}`
                  }}
                >
                  {isLoading && (
                    <span
                      className="spinner-sm"
                      style={{
                        borderColor: `${tokens.colors.white}4d`,
                        borderTopColor: tokens.colors.white,
                      }}
                    />
                  )}
                  {state.options.confirmText || t('confirm')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  )
}

export default DialogProvider
