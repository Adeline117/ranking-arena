'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { tokens } from '@/lib/design-tokens'
import { useAutoFocusTrap } from '@/lib/hooks/useFocusTrap'

interface ModalProps {
  children: React.ReactNode
  onClose: () => void
}

export function Modal({ children, onClose }: ModalProps) {
  const [mounted, setMounted] = useState(false)
  const modalRef = useAutoFocusTrap<HTMLDivElement>(mounted)

  useEffect(() => {
    setMounted(true)
    // 打开弹窗时禁止背景滚动
    document.body.style.overflow = 'hidden'

    // Escape key closes modal
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.body.style.overflow = ''
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

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
        zIndex: tokens.zIndex.modal,
        overflowY: 'auto',
      }}
    >
      <div
        ref={modalRef}
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
              width: 44,
              height: 44,
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

