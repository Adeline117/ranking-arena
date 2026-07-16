'use client'

import { useEffect, useRef, useState } from 'react'
import { tokens, alpha } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import Link from 'next/link'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { captureExchangeViewer, isExchangeViewerCurrent } from '@/lib/exchange/viewer-scope'

type BannerState = {
  viewerKey: `user:${string}` | null
  sessionGeneration: number
  show: boolean | null
}

export function ExchangeBindingBanner({ userId }: { userId: string | null }) {
  const { t } = useLanguage()
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const userIdRef = useRef(userId)
  userIdRef.current = userId
  const mountedRef = useRef(false)
  const requestGenerationRef = useRef(0)
  const renderedScope = captureExchangeViewer(auth, userId)
  const [bannerState, setBannerState] = useState<BannerState>({
    viewerKey: null,
    sessionGeneration: -1,
    show: null,
  })

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestGenerationRef.current += 1
    }
  }, [])

  useEffect(() => {
    const snapshot = captureExchangeViewer(authRef.current, userIdRef.current)
    if (!snapshot) return
    const requestGeneration = ++requestGenerationRef.current

    const isCurrent = () => {
      return (
        mountedRef.current &&
        requestGenerationRef.current === requestGeneration &&
        isExchangeViewerCurrent(snapshot, authRef.current, userIdRef.current)
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
          connections.some((connection) => connection.user_id !== snapshot.userId)
        )
          return

        setBannerState({
          viewerKey: snapshot.viewerKey,
          sessionGeneration: snapshot.sessionGeneration,
          show: connections.length === 0,
        })
      } catch {
        /* Exchange connection check non-critical */
      }
    }

    void loadBindingState()
    return () => {
      if (requestGenerationRef.current === requestGeneration) {
        requestGenerationRef.current += 1
      }
    }
  }, [auth.accessToken, auth.sessionGeneration, auth.userId, userId])

  const show =
    renderedScope &&
    bannerState.viewerKey === renderedScope.viewerKey &&
    bannerState.sessionGeneration === renderedScope.sessionGeneration
      ? bannerState.show
      : null

  const handleBindNavigation = (event: React.MouseEvent<HTMLAnchorElement>) => {
    const snapshot = captureExchangeViewer(authRef.current, userIdRef.current)
    if (!snapshot || !isExchangeViewerCurrent(snapshot, authRef.current, userIdRef.current)) {
      event.preventDefault()
    }
  }

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
      <Link
        href="/exchange/auth"
        onClick={handleBindNavigation}
        style={{ textDecoration: 'none', flexShrink: 0 }}
      >
        <Button variant="primary" size="sm">
          {t('goToBind')}
        </Button>
      </Link>
    </Box>
  )
}
