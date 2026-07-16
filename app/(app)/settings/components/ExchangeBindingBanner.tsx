'use client'

import { useEffect, useRef, useState } from 'react'
import { tokens, alpha } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import Link from 'next/link'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'

type ViewerSnapshot = {
  viewerKey: string | null
  accessToken: string | null
  generation: number
}

type BannerState = {
  viewerKey: string | null
  generation: number
  show: boolean | null
}

function getAccessTokenSubject(token: string): string | null {
  try {
    const encodedPayload = token.split('.')[1]
    if (!encodedPayload) return null
    const base64 = encodedPayload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const payload = JSON.parse(atob(padded)) as { sub?: unknown }
    return typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}

export function ExchangeBindingBanner({ userId }: { userId: string | null }) {
  const { t } = useLanguage()
  const auth = useAuthSession()
  const tokenSubject = auth.accessToken ? getAccessTokenSubject(auth.accessToken) : null
  const viewerKey =
    auth.userId && auth.userId === userId && tokenSubject === auth.userId ? auth.userId : null
  const validAccessToken = viewerKey ? auth.accessToken : null
  const scopeRef = useRef<ViewerSnapshot>({
    viewerKey,
    accessToken: validAccessToken,
    generation: 0,
  })

  // Invalidate viewer-owned state during render so account B can never display
  // a late banner decision computed for account A.
  if (
    scopeRef.current.viewerKey !== viewerKey ||
    scopeRef.current.accessToken !== validAccessToken
  ) {
    scopeRef.current = {
      viewerKey,
      accessToken: validAccessToken,
      generation: scopeRef.current.generation + 1,
    }
  }
  const renderedScope = scopeRef.current
  const [bannerState, setBannerState] = useState<BannerState>({
    viewerKey: null,
    generation: -1,
    show: null,
  })

  useEffect(() => {
    const snapshot = renderedScope
    if (!snapshot.viewerKey || !snapshot.accessToken) return

    const isCurrent = () => {
      const current = scopeRef.current
      return (
        current.viewerKey === snapshot.viewerKey &&
        current.accessToken === snapshot.accessToken &&
        current.generation === snapshot.generation
      )
    }

    const loadBindingState = async () => {
      try {
        const response = await fetch('/api/exchange/connections', {
          headers: { Authorization: `Bearer ${snapshot.accessToken}` },
          cache: 'no-store',
        })
        if (!isCurrent() || !response.ok) return

        const payload = (await response.json()) as {
          data?: { connections?: Array<{ id: string; user_id: string }> }
        }
        if (!isCurrent()) return

        const connections = payload.data?.connections
        if (
          !Array.isArray(connections) ||
          connections.some((connection) => connection.user_id !== snapshot.viewerKey)
        )
          return

        setBannerState({
          viewerKey: snapshot.viewerKey,
          generation: snapshot.generation,
          show: connections.length === 0,
        })
      } catch {
        /* Exchange connection check non-critical */
      }
    }

    void loadBindingState()
  }, [renderedScope])

  const show =
    bannerState.viewerKey === renderedScope.viewerKey &&
    bannerState.generation === renderedScope.generation
      ? bannerState.show
      : null

  if (!show) return null

  return (
    <Box
      style={{
        marginBottom: tokens.spacing[6],
        padding: tokens.spacing[5],
        borderRadius: tokens.radius['2xl'],
        background: `linear-gradient(135deg, ${alpha(tokens.colors.accent.primary, 7)}, ${alpha(tokens.colors.accent.brand, 3)})`,
        border: `1px solid ${alpha(tokens.colors.accent.primary, 19)}`,
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[4],
      }}
    >
      <Box
        style={{
          width: 48,
          height: 48,
          borderRadius: tokens.radius.lg,
          background: `${alpha(tokens.colors.accent.primary, 13)}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke={tokens.colors.accent.primary}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      </Box>
      <Box style={{ flex: 1 }}>
        <Text size="sm" weight="bold" style={{ marginBottom: 4 }}>
          {t('bindExchangeBannerTitle')}
        </Text>
        <Text size="xs" color="tertiary">
          {t('bindExchangeBannerDesc')}
        </Text>
      </Box>
      <Link href="/exchange/auth" style={{ textDecoration: 'none', flexShrink: 0 }}>
        <Button variant="primary" size="sm">
          {t('goToBind')}
        </Button>
      </Link>
    </Box>
  )
}
