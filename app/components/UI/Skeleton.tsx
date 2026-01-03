'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../Base'

export function SkeletonLine({ width = '100%', height = '16px' }: { width?: string; height?: string }) {
  return (
    <Box
      style={{
        width,
        height,
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.md,
        animation: 'pulse 1.5s ease-in-out infinite',
      }}
    />
  )
}

export function SkeletonCard() {
  return (
    <Box
      bg="secondary"
      p={4}
      radius="xl"
      border="primary"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacing[3],
      }}
    >
      <SkeletonLine width="60%" height="20px" />
      <SkeletonLine width="100%" />
      <SkeletonLine width="80%" />
    </Box>
  )
}

export function RankingSkeleton() {
  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
      {Array.from({ length: 5 }).map((_, i) => (
        <Box
          key={i}
          bg="primary"
          p={3}
          radius="lg"
          border="secondary"
          style={{
            display: 'grid',
            gridTemplateColumns: '52px 1fr 80px 70px 90px',
            alignItems: 'center',
            gap: tokens.spacing[2],
          }}
        >
          <SkeletonLine width="30px" height="16px" />
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
            <SkeletonLine width="30px" height="30px" />
            <SkeletonLine width="100px" height="16px" />
          </Box>
          <SkeletonLine width="60px" height="16px" />
          <SkeletonLine width="50px" height="16px" />
          <SkeletonLine width="70px" height="16px" />
        </Box>
      ))}
    </Box>
  )
}
