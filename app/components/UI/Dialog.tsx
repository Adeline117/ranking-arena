'use client'

import { createContext, useContext, useState, useCallback, ReactNode } from 'react'
import { tokens } from '@/lib/design-tokens'

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

export function useDialog() {
  const context = useContext(DialogContext)
  if (!context) {
    throw new Error('useDialog must be used within a DialogProvider')
  }
  return context
}

interface DialogState {
  isOpen: boolean
  options: DialogOptions | null
  resolve: ((value: boolean) => void) | null
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState>({
    isOpen: false,
    options: null,
    resolve: null,
  })

  const showDialog = useCallback((options: DialogOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setState({
        isOpen: true,
        options,
        resolve,
      })
    })
  }, [])

  const showAlert = useCallback((title: string, message: string): Promise<void> => {
    return new Promise((resolve) => {
      setState({
        isOpen: true,
        options: {
          title,
          message,
          type: 'alert',
          confirmText: '确定',
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
      confirmText: '确定',
      cancelText: '取消',
    })
  }, [showDialog])

  const showDangerConfirm = useCallback((title: string, message: string): Promise<boolean> => {
    return showDialog({
      title,
      message,
      type: 'danger',
      confirmText: '确定',
      cancelText: '取消',
    })
  }, [showDialog])

  const hideDialog = useCallback(() => {
    if (state.resolve) {
      state.resolve(false)
    }
    setState({
      isOpen: false,
      options: null,
      resolve: null,
    })
  }, [state.resolve])

  const handleConfirm = useCallback(async () => {
    if (state.options?.onConfirm) {
      await state.options.onConfirm()
    }
    if (state.resolve) {
      state.resolve(true)
    }
    setState({
      isOpen: false,
      options: null,
      resolve: null,
    })
  }, [state.options, state.resolve])

  const handleCancel = useCallback(() => {
    if (state.options?.onCancel) {
      state.options.onCancel()
    }
    if (state.resolve) {
      state.resolve(false)
    }
    setState({
      isOpen: false,
      options: null,
      resolve: null,
    })
  }, [state.options, state.resolve])

  const getButtonColor = () => {
    if (state.options?.type === 'danger') {
      return '#ff4d4d'
    }
    return '#8b6fa8'
  }

  return (
    <DialogContext.Provider value={{ showDialog, showAlert, showConfirm, showDangerConfirm, hideDialog }}>
      {children}
      
      {/* Dialog Overlay */}
      {state.isOpen && state.options && (
        <div
          onClick={handleCancel}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.65)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
            zIndex: 10000,
            animation: 'dialogFadeIn 0.2s ease-out',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 400,
              background: '#0b0b0b',
              border: '1px solid #1f1f1f',
              borderRadius: 16,
              padding: 24,
              animation: 'dialogSlideIn 0.3s ease-out',
            }}
          >
            {/* Title */}
            <h2 style={{
              fontSize: 18,
              fontWeight: 900,
              color: '#f2f2f2',
              marginBottom: 12,
            }}>
              {state.options.title}
            </h2>

            {/* Message */}
            <p style={{
              fontSize: 14,
              color: '#9a9a9a',
              lineHeight: 1.6,
              marginBottom: 24,
            }}>
              {state.options.message}
            </p>

            {/* Buttons */}
            <div style={{
              display: 'flex',
              gap: 12,
              justifyContent: 'flex-end',
            }}>
              {state.options.type !== 'alert' && (
                <button
                  onClick={handleCancel}
                  style={{
                    padding: '10px 20px',
                    borderRadius: 10,
                    border: '1px solid #1f1f1f',
                    background: 'transparent',
                    color: '#9a9a9a',
                    fontWeight: 700,
                    fontSize: 14,
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
                    e.currentTarget.style.color = '#eaeaea'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent'
                    e.currentTarget.style.color = '#9a9a9a'
                  }}
                >
                  {state.options.cancelText || '取消'}
                </button>
              )}
              <button
                onClick={handleConfirm}
                style={{
                  padding: '10px 20px',
                  borderRadius: 10,
                  border: 'none',
                  background: getButtonColor(),
                  color: '#fff',
                  fontWeight: 900,
                  fontSize: 14,
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.opacity = '0.9'
                  e.currentTarget.style.transform = 'scale(1.02)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.opacity = '1'
                  e.currentTarget.style.transform = 'scale(1)'
                }}
              >
                {state.options.confirmText || '确定'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Animation styles */}
      <style jsx global>{`
        @keyframes dialogFadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        @keyframes dialogSlideIn {
          from {
            transform: scale(0.95) translateY(-10px);
            opacity: 0;
          }
          to {
            transform: scale(1) translateY(0);
            opacity: 1;
          }
        }
      `}</style>
    </DialogContext.Provider>
  )
}

export default DialogProvider

