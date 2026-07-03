'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLoginModal } from '@/lib/hooks/useLoginModal'
import { getCsrfHeaders } from '@/lib/api/client'
import Link from 'next/link'

export default function CreateCompetitionPage() {
  const { t } = useLanguage()
  const { accessToken, isLoggedIn } = useAuthSession()
  const router = useRouter()

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [metric, setMetric] = useState('roi')
  const [startAt, setStartAt] = useState('')
  const [endAt, setEndAt] = useState('')
  const [maxParticipants, setMaxParticipants] = useState('100')
  const [entryFee, setEntryFee] = useState('0')
  const [prizePool, setPrizePool] = useState('0')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Per-field validation messages, keyed by field id.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  // Validate every field; returns the error map (empty = valid).
  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {}
    if (!title.trim()) {
      errs.title = t('compErrTitleRequired')
    }
    const now = new Date()
    const start = startAt ? new Date(startAt) : null
    const end = endAt ? new Date(endAt) : null
    if (!start || isNaN(start.getTime())) {
      errs.start = t('compErrStartRequired')
    } else if (start.getTime() <= now.getTime()) {
      errs.start = t('compErrStartFuture')
    }
    if (!end || isNaN(end.getTime())) {
      errs.end = t('compErrEndRequired')
    } else if (start && !isNaN(start.getTime()) && end.getTime() <= start.getTime()) {
      errs.end = t('compErrEndAfterStart')
    }
    const max = parseInt(maxParticipants, 10)
    if (isNaN(max) || max < 2) {
      errs.max = t('compErrMaxParticipants')
    }
    const fee = parseFloat(entryFee)
    if (entryFee.trim() === '' || isNaN(fee) || fee < 0) {
      errs.entryFee = t('compErrAmountInvalid')
    }
    const prize = parseFloat(prizePool)
    if (prizePool.trim() === '' || isNaN(prize) || prize < 0) {
      errs.prizePool = t('compErrAmountInvalid')
    }
    return errs
  }

  const metrics = [
    { value: 'roi', label: 'ROI' },
    { value: 'pnl', label: 'PnL' },
    { value: 'sharpe', label: 'Sharpe Ratio' },
    { value: 'max_drawdown', label: 'Max Drawdown' },
  ]

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isLoggedIn) {
      setError(t('compLoginRequired'))
      return
    }

    // Block submit on any invalid field; focus the first offending control.
    const errs = validate()
    setFieldErrors(errs)
    if (Object.keys(errs).length > 0) {
      const order = ['title', 'start', 'end', 'max', 'entryFee', 'prizePool']
      const firstKey = order.find((k) => errs[k])
      const idMap: Record<string, string> = {
        title: 'comp-title',
        start: 'comp-start',
        end: 'comp-end',
        max: 'comp-max',
        entryFee: 'comp-entry-fee',
        prizePool: 'comp-prize-pool',
      }
      if (firstKey) document.getElementById(idMap[firstKey])?.focus()
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      const res = await fetch('/api/competitions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || null,
          metric,
          start_at: new Date(startAt).toISOString(),
          end_at: new Date(endAt).toISOString(),
          max_participants: parseInt(maxParticipants) || 100,
          entry_fee_cents: Math.round((parseFloat(entryFee) || 0) * 100),
          prize_pool_cents: Math.round((parseFloat(prizePool) || 0) * 100),
        }),
      })
      const json = await res.json()
      if (!json.success) {
        setError(t('competitionCreateFailed'))
      } else {
        router.push(`/competitions/${json.data.id}`)
      }
    } catch {
      setError('Network error')
    } finally {
      setSubmitting(false)
    }
  }

  const inputStyle = {
    width: '100%',
    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
    background: tokens.colors.bg.primary,
    color: tokens.colors.text.primary,
    border: `1px solid ${tokens.colors.border.primary}`,
    borderRadius: tokens.radius.md,
    fontSize: tokens.typography.fontSize.sm,
    outline: 'none',
  }

  const labelStyle = {
    display: 'block' as const,
    fontSize: tokens.typography.fontSize.sm,
    fontWeight: tokens.typography.fontWeight.medium,
    marginBottom: tokens.spacing[1],
    color: tokens.colors.text.secondary,
  }

  const hintStyle = {
    fontSize: tokens.typography.fontSize.xs,
    color: tokens.colors.text.tertiary,
    marginTop: tokens.spacing[1],
  }

  // Merge a red border onto inputs that currently have an error.
  const inputStyleFor = (field: string) =>
    fieldErrors[field]
      ? { ...inputStyle, border: `1px solid ${tokens.colors.accent.error}` }
      : inputStyle

  // Inline, screen-reader-linked error message for a field.
  const FieldError = ({ field }: { field: string }) =>
    fieldErrors[field] ? (
      <Text
        id={`${field}-error`}
        role="alert"
        style={{
          color: tokens.colors.accent.error,
          fontSize: tokens.typography.fontSize.xs,
          marginTop: tokens.spacing[1],
        }}
      >
        {fieldErrors[field]}
      </Text>
    ) : null

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      <Box
        style={{
          maxWidth: 640,
          margin: '0 auto',
          padding: `${tokens.spacing[6]} ${tokens.spacing[4]}`,
        }}
      >
        {/* Breadcrumb */}
        <Box style={{ marginBottom: tokens.spacing[4] }}>
          <Link
            href="/competitions"
            style={{
              color: tokens.colors.text.secondary,
              textDecoration: 'none',
              fontSize: tokens.typography.fontSize.sm,
            }}
          >
            {t('compPageTitle')}
          </Link>
          <Text
            as="span"
            style={{ color: tokens.colors.text.tertiary, margin: `0 ${tokens.spacing[2]}` }}
          >
            /
          </Text>
          <Text as="span" style={{ fontSize: tokens.typography.fontSize.sm }}>
            {t('compCreateTitle')}
          </Text>
        </Box>

        <Text
          as="h1"
          style={{
            fontSize: tokens.typography.fontSize['2xl'],
            fontWeight: tokens.typography.fontWeight.bold,
            marginBottom: tokens.spacing[5],
          }}
        >
          {t('compCreateTitle')}
        </Text>

        {!isLoggedIn ? (
          <Box
            style={{
              padding: tokens.spacing[6],
              textAlign: 'center',
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.lg,
              border: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            <Text style={{ color: tokens.colors.text.secondary, marginBottom: tokens.spacing[4] }}>
              {t('compLoginRequired')}
            </Text>
            <Button onClick={() => useLoginModal.getState().openLoginModal()}>
              {t('compLoginToCreate')}
            </Button>
          </Box>
        ) : (
          <form onSubmit={handleSubmit} noValidate>
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
              {/* Title */}
              <Box>
                <label htmlFor="comp-title" style={labelStyle}>
                  {t('compFieldTitle')} *
                </label>
                <input
                  id="comp-title"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t('compFieldTitlePlaceholder')}
                  maxLength={100}
                  aria-invalid={!!fieldErrors.title}
                  aria-describedby={fieldErrors.title ? 'title-error' : undefined}
                  style={inputStyleFor('title')}
                />
                <FieldError field="title" />
              </Box>

              {/* Description */}
              <Box>
                <label htmlFor="comp-description" style={labelStyle}>
                  {t('compFieldDescription')}
                </label>
                <textarea
                  id="comp-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('compFieldDescPlaceholder')}
                  rows={3}
                  maxLength={500}
                  style={{ ...inputStyle, resize: 'vertical' as const }}
                />
              </Box>

              {/* Metric */}
              <Box>
                <label htmlFor="comp-metric" style={labelStyle}>
                  {t('compFieldMetric')} *
                </label>
                <select
                  id="comp-metric"
                  value={metric}
                  onChange={(e) => setMetric(e.target.value)}
                  style={inputStyle}
                >
                  {metrics.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </Box>

              {/* Dates */}
              <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
                <Box style={{ flex: 1 }}>
                  <label htmlFor="comp-start" style={labelStyle}>
                    {t('compStartDate')} *
                  </label>
                  <input
                    id="comp-start"
                    type="datetime-local"
                    value={startAt}
                    onChange={(e) => setStartAt(e.target.value)}
                    aria-invalid={!!fieldErrors.start}
                    aria-describedby={fieldErrors.start ? 'start-error' : undefined}
                    style={inputStyleFor('start')}
                  />
                  <FieldError field="start" />
                </Box>
                <Box style={{ flex: 1 }}>
                  <label htmlFor="comp-end" style={labelStyle}>
                    {t('compEndDate')} *
                  </label>
                  <input
                    id="comp-end"
                    type="datetime-local"
                    value={endAt}
                    onChange={(e) => setEndAt(e.target.value)}
                    aria-invalid={!!fieldErrors.end}
                    aria-describedby={fieldErrors.end ? 'end-error' : undefined}
                    style={inputStyleFor('end')}
                  />
                  <FieldError field="end" />
                </Box>
              </Box>

              {/* Max Participants */}
              <Box>
                <label htmlFor="comp-max" style={labelStyle}>
                  {t('compFieldMaxParticipants')}
                </label>
                <input
                  id="comp-max"
                  type="number"
                  value={maxParticipants}
                  onChange={(e) => setMaxParticipants(e.target.value)}
                  min={2}
                  max={10000}
                  aria-invalid={!!fieldErrors.max}
                  aria-describedby={fieldErrors.max ? 'max-error' : undefined}
                  style={inputStyleFor('max')}
                />
                <FieldError field="max" />
              </Box>

              {/* Entry Fee + Prize Pool */}
              <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
                <Box style={{ flex: 1 }}>
                  <label htmlFor="comp-entry-fee" style={labelStyle}>
                    {t('compFieldEntryFee')} *
                  </label>
                  <input
                    id="comp-entry-fee"
                    type="number"
                    value={entryFee}
                    onChange={(e) => setEntryFee(e.target.value)}
                    min={0}
                    step="0.01"
                    aria-invalid={!!fieldErrors.entryFee}
                    aria-describedby={
                      fieldErrors.entryFee ? 'entryFee-error' : 'comp-entry-fee-hint'
                    }
                    style={inputStyleFor('entryFee')}
                  />
                  <Text id="comp-entry-fee-hint" style={hintStyle}>
                    {t('compFieldEntryFeeHint')}
                  </Text>
                  <FieldError field="entryFee" />
                </Box>
                <Box style={{ flex: 1 }}>
                  <label htmlFor="comp-prize-pool" style={labelStyle}>
                    {t('compFieldPrizePool')} *
                  </label>
                  <input
                    id="comp-prize-pool"
                    type="number"
                    value={prizePool}
                    onChange={(e) => setPrizePool(e.target.value)}
                    min={0}
                    step="0.01"
                    aria-invalid={!!fieldErrors.prizePool}
                    aria-describedby={
                      fieldErrors.prizePool ? 'prizePool-error' : 'comp-prize-pool-hint'
                    }
                    style={inputStyleFor('prizePool')}
                  />
                  <Text id="comp-prize-pool-hint" style={hintStyle}>
                    {t('compFieldPrizePoolHint')}
                  </Text>
                  <FieldError field="prizePool" />
                </Box>
              </Box>

              {error && (
                <Text style={{ color: '#ef4444', fontSize: tokens.typography.fontSize.sm }}>
                  {error}
                </Text>
              )}

              <Button variant="primary" type="submit" loading={submitting} fullWidth>
                {t('compCreateSubmit')}
              </Button>
            </Box>
          </form>
        )}
      </Box>
    </Box>
  )
}
