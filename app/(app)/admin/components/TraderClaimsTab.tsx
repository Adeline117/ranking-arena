'use client'

import { useEffect, useState, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import Card from '@/app/components/ui/Card'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface TraderClaim {
  id: string
  user_id: string
  trader_id: string
  source: string
  handle: string | null
  verification_method: string
  status: string
  reject_reason: string | null
  created_at: string
  verified_at: string | null
  user_email?: string
}

interface TraderClaimsTabProps {
  accessToken: string | null
}

export default function TraderClaimsTab({ accessToken }: TraderClaimsTabProps) {
  const { t } = useLanguage()
  const [claims, setClaims] = useState<TraderClaim[]>([])
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'pending' | 'verified' | 'rejected'>('all')
  const [rejectInputs, setRejectInputs] = useState<Record<string, boolean>>({})
  const [rejectReasons, setRejectReasons] = useState<Record<string, string>>({})

  const loadClaims = useCallback(async () => {
    if (!accessToken) return
    setLoading(true)
    try {
      const res = await fetch('/api/admin/claims', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (res.ok) {
        const data = await res.json()
        setClaims(data.data?.claims || [])
      }
    } catch {
      // Silent fail
    } finally {
      setLoading(false)
    }
  }, [accessToken])

  useEffect(() => {
    loadClaims()
  }, [loadClaims])

  const handleReview = async (claimId: string, approved: boolean) => {
    if (!accessToken) return
    setActionLoading(claimId)
    try {
      const res = await fetch('/api/traders/claim/review', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          claimId,
          approved,
          rejectReason: !approved ? rejectReasons[claimId]?.trim() : undefined,
        }),
      })
      if (res.ok) {
        await loadClaims()
        setRejectInputs(prev => ({ ...prev, [claimId]: false }))
        setRejectReasons(prev => ({ ...prev, [claimId]: '' }))
      }
    } catch {
      // Silent fail
    } finally {
      setActionLoading(null)
    }
  }

  const filtered = filter === 'all'
    ? claims
    : claims.filter(c => c.status === filter)

  const statusColor = (status: string) => {
    switch (status) {
      case 'verified': return tokens.colors.accent.success
      case 'pending': case 'reviewing': return tokens.colors.accent.warning
      case 'rejected': return tokens.colors.accent.error
      default: return tokens.colors.text.tertiary
    }
  }

  const counts = {
    all: claims.length,
    pending: claims.filter(c => c.status === 'pending' || c.status === 'reviewing').length,
    verified: claims.filter(c => c.status === 'verified').length,
    rejected: claims.filter(c => c.status === 'rejected').length,
  }

  return (
    <Card title={t('traderClaims') || 'Trader Claims'}>
      {/* Filter buttons */}
      <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[4], flexWrap: 'wrap' }}>
        {(['all', 'pending', 'verified', 'rejected'] as const).map(f => (
          <Button
            key={f}
            variant={filter === f ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? (t('all') || 'All') : f.charAt(0).toUpperCase() + f.slice(1)}
            {counts[f] > 0 && ` (${counts[f]})`}
          </Button>
        ))}
      </Box>

      {loading ? (
        <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
          <Text color="tertiary">{t('loading')}</Text>
        </Box>
      ) : filtered.length === 0 ? (
        <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
          <Text color="tertiary">{t('noClaims') || 'No claims found'}</Text>
        </Box>
      ) : (
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
          {filtered.map(claim => (
            <Box
              key={claim.id}
              style={{
                padding: tokens.spacing[4],
                background: tokens.colors.bg.secondary,
                borderRadius: tokens.radius.lg,
                border: `1px solid ${tokens.colors.border.primary}`,
              }}
            >
              <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: tokens.spacing[3] }}>
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[1] }}>
                    <Text weight="bold" style={{ fontSize: 14 }}>
                      {claim.handle || claim.trader_id}
                    </Text>
                    <Text size="xs" style={{
                      padding: '2px 8px',
                      borderRadius: tokens.radius.full,
                      background: statusColor(claim.status) + '20',
                      color: statusColor(claim.status),
                      fontWeight: 700,
                    }}>
                      {claim.status}
                    </Text>
                  </Box>
                  <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
                    {claim.source} · {claim.verification_method} · {new Date(claim.created_at).toLocaleDateString()}
                  </Text>
                  <Text size="xs" color="tertiary">
                    trader_id: {claim.trader_id.length > 20 ? claim.trader_id.slice(0, 10) + '...' + claim.trader_id.slice(-6) : claim.trader_id}
                  </Text>
                  {claim.user_email && (
                    <Text size="xs" color="tertiary">
                      user: {claim.user_email}
                    </Text>
                  )}
                  {claim.reject_reason && (
                    <Text size="xs" style={{ color: tokens.colors.accent.error, marginTop: tokens.spacing[1] }}>
                      Reason: {claim.reject_reason}
                    </Text>
                  )}
                </Box>

                {/* Action buttons for pending claims */}
                {(claim.status === 'pending' || claim.status === 'reviewing') && (
                  <Box style={{ display: 'flex', gap: tokens.spacing[2], flexShrink: 0 }}>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => handleReview(claim.id, true)}
                      disabled={actionLoading === claim.id}
                    >
                      {actionLoading === claim.id ? '...' : (t('approve') || 'Approve')}
                    </Button>
                    {!rejectInputs[claim.id] ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setRejectInputs(prev => ({ ...prev, [claim.id]: true }))}
                      >
                        {t('reject') || 'Reject'}
                      </Button>
                    ) : (
                      <Box style={{ display: 'flex', gap: tokens.spacing[1], alignItems: 'center' }}>
                        <input
                          type="text"
                          placeholder="Reason..."
                          value={rejectReasons[claim.id] || ''}
                          onChange={e => setRejectReasons(prev => ({ ...prev, [claim.id]: e.target.value }))}
                          style={{
                            padding: '4px 8px',
                            fontSize: 12,
                            border: `1px solid ${tokens.colors.border.primary}`,
                            borderRadius: tokens.radius.md,
                            background: tokens.colors.bg.primary,
                            color: tokens.colors.text.primary,
                            width: 120,
                          }}
                        />
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleReview(claim.id, false)}
                          disabled={actionLoading === claim.id}
                        >
                          {actionLoading === claim.id ? '...' : 'Confirm'}
                        </Button>
                      </Box>
                    )}
                  </Box>
                )}
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </Card>
  )
}
