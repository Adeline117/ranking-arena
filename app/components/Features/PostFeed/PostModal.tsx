'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { tokens } from '@/lib/design-tokens'

interface ModalProps {
  children: React.ReactNode
  onClose: () => void
}

export function Modal({ children, onClose }: ModalProps) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    // 打开弹窗时禁止背景滚动
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [])

  const modalContent = (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        display: 'grid',
        placeItems: 'center',
        padding: 16,
        zIndex: 9000,
        overflowY: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(760px, 100%)',
          maxHeight: '90vh',
          overflowY: 'auto',
          border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: 16,
          background: tokens.colors.bg.secondary,
          padding: 16,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            aria-label="关闭"
            style={{
              border: 'none',
              background: 'transparent',
              color: tokens.colors.text.secondary,
              cursor: 'pointer',
              fontSize: 20,
              width: 32,
              height: 32,
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  )

  // 使用 Portal 将弹窗渲染到 body 层级，脱离 sticky 父容器的层叠上下文
  if (!mounted) return null
  return createPortal(modalContent, document.body)
}

