'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { tokens, alpha } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import Card from '@/app/components/ui/Card'
import ErrorMessage from '@/app/components/ui/ErrorMessage'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getCsrfHeaders } from '@/lib/api/client'

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

async function readResponseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: unknown
      message?: unknown
    }
    if (typeof body.error === 'string' && body.error.trim()) return body.error.trim()
    const nestedError =
      body.error && typeof body.error === 'object'
        ? (body.error as { message?: unknown }).message
        : undefined
    if (typeof nestedError === 'string' && nestedError.trim()) {
      return nestedError.trim()
    }
    if (typeof body.message === 'string' && body.message.trim()) return body.message.trim()
  } catch {
    // A proxy or transient upstream may return a non-JSON error page.
  }
  return response.status ? `${fallback} (${response.status})` : fallback
}

export default function TraderClaimsTab({ accessToken }: TraderClaimsTabProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [claims, setClaims] = useState<TraderClaim[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState<'all' | 'pending' | 'verified' | 'rejected'>('all')
  const [rejectInputs, setRejectInputs] = useState<Record<string, boolean>>({})
  const [rejectReasons, setRejectReasons] = useState<Record<string, string>>({})
  const loadRequestIdRef = useRef(0)
  const actionInFlightRef = useRef<string | null>(null)

  const loadClaims = useCallback(
    async (showSpinner = true): Promise<boolean> => {
      const requestId = ++loadRequestIdRef.current
      if (!accessToken) {
        setClaims([])
        setLoadError(t('adminLoadFailed'))
        setLoading(false)
        return false
      }
      if (showSpinner) setLoading(true)
      setLoadError(null)
      try {
        const res = await fetch('/api/admin/claims', {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) {
          throw new Error(await readResponseError(res, t('adminLoadFailed')))
        }
        const data = await res.json()
        if (requestId !== loadRequestIdRef.current) return false
        setClaims(Array.isArray(data.data?.claims) ? data.data.claims : [])
        return true
      } catch (error) {
        if (requestId !== loadRequestIdRef.current) return false
        const message =
          error instanceof Error && error.message ? error.message : t('adminLoadFailed')
        setLoadError(message)
        showToast(message, 'error')
        return false
      } finally {
        if (requestId === loadRequestIdRef.current && showSpinner) setLoading(false)
      }
    },
    [accessToken, showToast, t]
  )

  useEffect(() => {
    void loadClaims()
    return () => {
      loadRequestIdRef.current += 1
    }
  }, [loadClaims])

  const handleReview = async (claimId: string, approved: boolean) => {
    if (!accessToken || actionInFlightRef.current) return
    actionInFlightRef.current = claimId
    setActionLoading(claimId)
    setActionErrors((prev) => {
      const next = { ...prev }
      delete next[claimId]
      return next
    })
    try {
      const res = await fetch('/api/traders/claim/review', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          claimId,
          approved,
          rejectReason: !approved ? rejectReasons[claimId]?.trim() : undefined,
        }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        throw new Error(await readResponseError(res, t('claimFailed')))
      }

      const payload = (await res.json()) as { data?: { claim?: Partial<TraderClaim> } }
      const reviewedClaim = payload.data?.claim
      const expectedStatus = approved ? 'verified' : 'rejected'
      if (
        !reviewedClaim ||
        reviewedClaim.id !== claimId ||
        reviewedClaim.status !== expectedStatus
      ) {
        throw new Error(t('claimFailed'))
      }

      // The review response is the commit acknowledgement. Apply it before the
      // follow-up refresh so a refresh outage never leaves a completed claim
      // looking actionable and invites a duplicate review.
      setClaims((prev) =>
        prev.map((claim) => (claim.id === claimId ? { ...claim, ...reviewedClaim } : claim))
      )

      setRejectInputs((prev) => ({ ...prev, [claimId]: false }))
      setRejectReasons((prev) => ({ ...prev, [claimId]: '' }))
      showToast(approved ? t('approved') : t('rejected'), 'success')
      await loadClaims(false)
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : t('claimFailed')
      setActionErrors((prev) => ({ ...prev, [claimId]: message }))
      showToast(message, 'error')
    } finally {
      actionInFlightRef.current = null
      setActionLoading(null)
    }
  }

  const filtered =
    filter === 'all'
      ? claims
      : claims.filter((claim) =>
          filter === 'pending'
            ? claim.status === 'pending' || claim.status === 'reviewing'
            : claim.status === filter
        )

  const statusColor = (status: string) => {
    switch (status) {
      case 'verified':
        return tokens.colors.accent.success
      case 'pending':
      case 'reviewing':
        return tokens.colors.accent.warning
      case 'rejected':
        return tokens.colors.accent.error
      default:
        return tokens.colors.text.tertiary
    }
  }

  const counts = {
    all: claims.length,
    pending: claims.filter((c) => c.status === 'pending' || c.status === 'reviewing').length,
    verified: claims.filter((c) => c.status === 'verified').length,
    rejected: claims.filter((c) => c.status === 'rejected').length,
  }

  return (
    <Card title={t('traderClaims')}>
      {/* Filter buttons */}
      <Box
        style={{
          display: 'flex',
          gap: tokens.spacing[2],
          marginBottom: tokens.spacing[4],
          flexWrap: 'wrap',
        }}
      >
        {(['all', 'pending', 'verified', 'rejected'] as const).map((f) => (
          <Button
            key={f}
            aria-pressed={filter === f}
            variant={filter === f ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? t('all') : f.charAt(0).toUpperCase() + f.slice(1)}
            {counts[f] > 0 && ` (${counts[f]})`}
          </Button>
        ))}
        <Button
          variant="text"
          size="sm"
          disabled={loading || actionLoading !== null}
          onClick={() => void loadClaims()}
        >
          {t('refresh')}
        </Button>
      </Box>

      {loadError && (
        <Box style={{ marginBottom: tokens.spacing[4] }}>
          <ErrorMessage message={loadError} onRetry={() => void loadClaims()} />
        </Box>
      )}

      {loading ? (
        <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
          <Text color="tertiary">{t('loading')}</Text>
        </Box>
      ) : loadError && claims.length === 0 ? null : filtered.length === 0 ? (
        <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
          <Text color="tertiary">{t('noClaims')}</Text>
        </Box>
      ) : (
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
          {filtered.map((claim) => (
            <Box
              key={claim.id}
              style={{
                padding: tokens.spacing[4],
                background: tokens.colors.bg.secondary,
                borderRadius: tokens.radius.lg,
                border: `1px solid ${tokens.colors.border.primary}`,
              }}
            >
              <Box
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: tokens.spacing[3],
                  flexWrap: 'wrap',
                }}
              >
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Box
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: tokens.spacing[2],
                      marginBottom: tokens.spacing[1],
                    }}
                  >
                    <Text weight="bold" style={{ fontSize: tokens.typography.fontSize.base }}>
                      {claim.handle || claim.trader_id}
                    </Text>
                    <Text
                      size="xs"
                      style={{
                        padding: '2px 8px',
                        borderRadius: tokens.radius.full,
                        background: alpha(statusColor(claim.status), 13),
                        color: statusColor(claim.status),
                        fontWeight: tokens.typography.fontWeight.bold,
                      }}
                    >
                      {claim.status}
                    </Text>
                  </Box>
                  <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
                    {claim.source} · {claim.verification_method} ·{' '}
                    {new Date(claim.created_at).toLocaleDateString()}
                  </Text>
                  <Text size="xs" color="tertiary">
                    trader_id:{' '}
                    {claim.trader_id.length > 20
                      ? claim.trader_id.slice(0, 10) + '...' + claim.trader_id.slice(-6)
                      : claim.trader_id}
                  </Text>
                  {claim.user_email && (
                    <Text size="xs" color="tertiary">
                      user: {claim.user_email}
                    </Text>
                  )}
                  {claim.reject_reason && (
                    <Text
                      size="xs"
                      style={{ color: tokens.colors.accent.error, marginTop: tokens.spacing[1] }}
                    >
                      Reason: {claim.reject_reason}
                    </Text>
                  )}
                </Box>

                {/* Action buttons for pending claims */}
                {(claim.status === 'pending' || claim.status === 'reviewing') && (
                  <Box
                    style={{
                      display: 'flex',
                      gap: tokens.spacing[2],
                      flexShrink: 0,
                      flexWrap: 'wrap',
                      justifyContent: 'flex-end',
                      maxWidth: '100%',
                    }}
                  >
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => handleReview(claim.id, true)}
                      disabled={actionLoading !== null}
                      loading={actionLoading === claim.id}
                    >
                      {t('approve')}
                    </Button>
                    {!rejectInputs[claim.id] ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={actionLoading !== null}
                        onClick={() => {
                          setRejectInputs((prev) => ({ ...prev, [claim.id]: true }))
                          setActionErrors((prev) => {
                            const next = { ...prev }
                            delete next[claim.id]
                            return next
                          })
                        }}
                      >
                        {t('reject')}
                      </Button>
                    ) : (
                      <Box
                        style={{
                          display: 'flex',
                          gap: tokens.spacing[1],
                          alignItems: 'center',
                          flexWrap: 'wrap',
                          maxWidth: '100%',
                        }}
                      >
                        <input
                          type="text"
                          aria-label={t('adminRejectReasonPlaceholder')}
                          aria-describedby={
                            actionErrors[claim.id] ? `claim-review-error-${claim.id}` : undefined
                          }
                          placeholder={t('adminRejectReasonPlaceholder')}
                          value={rejectReasons[claim.id] || ''}
                          maxLength={500}
                          disabled={actionLoading !== null}
                          onChange={(e) => {
                            setRejectReasons((prev) => ({ ...prev, [claim.id]: e.target.value }))
                            setActionErrors((prev) => {
                              const next = { ...prev }
                              delete next[claim.id]
                              return next
                            })
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && actionLoading === null) {
                              event.preventDefault()
                              void handleReview(claim.id, false)
                            }
                            if (event.key === 'Escape' && actionLoading === null) {
                              event.preventDefault()
                              setRejectInputs((prev) => ({ ...prev, [claim.id]: false }))
                              setRejectReasons((prev) => ({ ...prev, [claim.id]: '' }))
                            }
                          }}
                          style={{
                            padding: '4px 8px',
                            fontSize: tokens.typography.fontSize.xs,
                            border: `1px solid ${tokens.colors.border.primary}`,
                            borderRadius: tokens.radius.md,
                            background: tokens.colors.bg.primary,
                            color: tokens.colors.text.primary,
                            width: 180,
                            maxWidth: '100%',
                          }}
                        />
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleReview(claim.id, false)}
                          disabled={actionLoading !== null}
                          loading={actionLoading === claim.id}
                        >
                          {t('confirm')}
                        </Button>
                        <Button
                          variant="text"
                          size="sm"
                          disabled={actionLoading !== null}
                          onClick={() => {
                            setRejectInputs((prev) => ({ ...prev, [claim.id]: false }))
                            setRejectReasons((prev) => ({ ...prev, [claim.id]: '' }))
                            setActionErrors((prev) => {
                              const next = { ...prev }
                              delete next[claim.id]
                              return next
                            })
                          }}
                        >
                          {t('cancel')}
                        </Button>
                      </Box>
                    )}
                  </Box>
                )}
              </Box>
              {actionErrors[claim.id] && (
                <Box
                  id={`claim-review-error-${claim.id}`}
                  role="alert"
                  aria-live="assertive"
                  style={{
                    marginTop: tokens.spacing[3],
                    padding: tokens.spacing[2],
                    borderRadius: tokens.radius.md,
                    background: alpha(tokens.colors.accent.error, 10),
                    border: `1px solid ${alpha(tokens.colors.accent.error, 35)}`,
                  }}
                >
                  <Text size="sm" style={{ color: tokens.colors.accent.error }}>
                    {actionErrors[claim.id]}
                  </Text>
                </Box>
              )}
            </Box>
          ))}
        </Box>
      )}
    </Card>
  )
}
