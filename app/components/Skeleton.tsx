'use client'

import React from 'react'

export function SkeletonLine({ width = '100%', height = '16px' }: { width?: string; height?: string }) {
  return (
    <div
      style={{
        width,
        height,
        background: 'rgba(255,255,255,0.05)',
        borderRadius: '8px',
        animation: 'pulse 1.5s ease-in-out infinite',
      }}
    />
  )
}

export function SkeletonCard() {
  return (
    <div
      style={{
        padding: '16px',
        borderRadius: '16px',
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      <SkeletonLine width="60%" height="20px" />
      <SkeletonLine width="100%" />
      <SkeletonLine width="80%" />
    </div>
  )
}

export function RankingSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          style={{
            display: 'grid',
            gridTemplateColumns: '52px 1fr 80px 70px 90px',
            alignItems: 'center',
            gap: '10px',
            padding: '12px',
            borderRadius: '14px',
            background: '#0b0b0b',
            border: '1px solid #141414',
          }}
        >
          <SkeletonLine width="30px" height="16px" />
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <SkeletonLine width="30px" height="30px" />
            <SkeletonLine width="100px" height="16px" />
          </div>
          <SkeletonLine width="60px" height="16px" />
          <SkeletonLine width="50px" height="16px" />
          <SkeletonLine width="70px" height="16px" />
        </div>
      ))}
    </div>
  )
}

