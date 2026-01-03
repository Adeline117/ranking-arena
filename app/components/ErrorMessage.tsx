'use client'

import React from 'react'

type ErrorMessageProps = {
  title?: string
  message: string
  onRetry?: () => void
}

export default function ErrorMessage({ title = '出错了', message, onRetry }: ErrorMessageProps) {
  return (
    <div
      style={{
        padding: '24px',
        borderRadius: '12px',
        background: 'rgba(255,77,77,0.1)',
        border: '1px solid rgba(255,77,77,0.3)',
        color: '#ff7c7c',
      }}
    >
      <div style={{ fontSize: '16px', fontWeight: 900, marginBottom: '8px' }}>{title}</div>
      <div style={{ fontSize: '13px', marginBottom: onRetry ? '12px' : '0' }}>{message}</div>
      {onRetry && (
        <button
          onClick={onRetry}
          style={{
            marginTop: '12px',
            padding: '8px 16px',
            background: 'rgba(255,77,77,0.2)',
            border: '1px solid rgba(255,77,77,0.4)',
            borderRadius: '8px',
            color: '#ff7c7c',
            fontWeight: 700,
            cursor: 'pointer',
            fontSize: '13px',
          }}
        >
          重试
        </button>
      )}
    </div>
  )
}

