'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { supabase } from '@/lib/supabase/client'
import { useToast } from '@/app/components/ui/Toast'
import { useDialog } from '@/app/components/ui/Dialog'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { formatTimeAgo } from '@/lib/utils/date'

interface TraderLink {
  id: string
  trader_id: string
  source: string
  handle: string | null
  verified_at: string
  created_at: string
}

export function TraderLinksSection({ _userId }: { userId: string }) {
  const [links, setLinks] = useState<TraderLink[]>([])
  const [loadingLinks, setLoadingLinks] = useState(true)
  const [deleting, setDeleting] = useState<string | null>(null)
  const { showToast } = useToast()
  const { showConfirm } = useDialog()
  const { t } = useLanguage()

  const loadLinks = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return

      const res = await fetch('/api/traders/link', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (res.ok) {
        const data = await res.json()
        setLinks(data.links || [])
      }
    } catch (error) {
      console.error('[TraderLinks] Load error:', error)
    } finally {
      setLoadingLinks(false)
    }
  }, [])

  useEffect(() => {
    loadLinks()
  }, [loadLinks])

  const handleDelete = async (linkId: string) => {
    const confirmed = await showConfirm(t('unlinkConfirm'), t('unlinkConfirmMsg'))
    if (!confirmed) return

    setDeleting(linkId)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return

      const res = await fetch(`/api/traders/link?id=${linkId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (res.ok) {
        setLinks((prev) => prev.filter((l) => l.id !== linkId))
        showToast(t('unlinked'), 'success')
      } else {
        const data = await res.json()
        showToast(data.error || t('operationFailed'), 'error')
      }
    } catch {
      showToast(t('networkError'), 'error')
    } finally {
      setDeleting(null)
    }
  }

  const getSourceLabel = (source: string) => {
    const futuresLabel = t('futures')
    const spotLabel = t('spot')
    const onChainLabel = t('onChain')
    const map: Record<string, string> = {
      binance_futures: futuresLabel,
      binance_spot: spotLabel,
      binance_web3: onChainLabel,
      bybit: futuresLabel,
      bitget_futures: futuresLabel,
      bitget_spot: spotLabel,
      mexc: futuresLabel,
      coinex: futuresLabel,
      okx_web3: onChainLabel,
      kucoin: futuresLabel,
      gmx: onChainLabel,
    }
    return map[source] || source
  }

  if (loadingLinks) {
    return (
      <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
        <Text size="sm" color="tertiary">{t('loadingText')}</Text>
      </Box>
    )
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
      {links.length === 0 ? (
        <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
          <Text size="sm" color="tertiary">{t('noLinkedTraders')}</Text>
          <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[2] }}>
            {t('linkTraderHint')}
          </Text>
        </Box>
      ) : (
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
          {links.map((link) => (
            <Box
              key={link.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: tokens.spacing[3],
                borderRadius: tokens.radius.md,
                background: tokens.colors.bg.primary,
                border: `1px solid ${tokens.colors.border.primary}`,
              }}
            >
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
                <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                  <Text size="sm" weight="medium">
                    {link.handle || link.trader_id.slice(0, 8)}
                  </Text>
                  <span style={{
                    padding: `1px ${tokens.spacing[2]}`,
                    borderRadius: tokens.radius.sm,
                    background: `${tokens.colors.accent.primary}15`,
                    color: tokens.colors.accent.primary,
                    fontSize: tokens.typography.fontSize.xs,
                  }}>
                    {getSourceLabel(link.source)}
                  </span>
                </Box>
                <Text size="xs" color="tertiary">
                  {t('linkedAt')} {formatTimeAgo(link.verified_at || link.created_at)}
                </Text>
              </Box>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleDelete(link.id)}
                disabled={deleting === link.id}
                style={{
                  color: tokens.colors.accent.error,
                  fontSize: tokens.typography.fontSize.xs,
                }}
              >
                {deleting === link.id ? '...' : t('unlink')}
              </Button>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}
