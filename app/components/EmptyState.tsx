'use client'

import React from 'react'

type EmptyStateProps = {
  icon?: string
  title: string
  description?: string
  action?: React.ReactNode
}

export default function EmptyState({ icon = '📭', title, description, action }: EmptyStateProps) {
  return (
    <div
      style={{
        padding: '60px 20px',
        textAlign: 'center',
        color: '#9a9a9a',
      }}
    >
      <div style={{ fontSize: '48px', marginBottom: '16px' }}>{icon}</div>
      <div style={{ fontSize: '16px', fontWeight: 900, color: '#bdbdbd', marginBottom: '8px' }}>
        {title}
      </div>
      {description && (
        <div style={{ fontSize: '13px', color: '#777', marginBottom: '20px', maxWidth: '400px', margin: '0 auto 20px' }}>
          {description}
        </div>
      )}
      {action && <div>{action}</div>}
    </div>
  )
}

