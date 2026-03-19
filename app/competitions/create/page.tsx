'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
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
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

    setSubmitting(true)
    setError(null)

    try {
      const res = await fetch('/api/competitions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || null,
          metric,
          start_at: new Date(startAt).toISOString(),
          end_at: new Date(endAt).toISOString(),
          max_participants: parseInt(maxParticipants) || 100,
        }),
      })
      const json = await res.json()
      if (!json.success) {
        setError(json.error || 'Failed to create competition')
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
    fontWeight: 500 as const,
    marginBottom: tokens.spacing[1],
    color: tokens.colors.text.secondary,
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={null} />
      <Box style={{ maxWidth: 640, margin: '0 auto', padding: `${tokens.spacing[6]} ${tokens.spacing[4]}` }}>
        {/* Breadcrumb */}
        <Box style={{ marginBottom: tokens.spacing[4] }}>
          <Link href="/competitions" style={{ color: tokens.colors.text.secondary, textDecoration: 'none', fontSize: tokens.typography.fontSize.sm }}>
            {t('compPageTitle')}
          </Link>
          <Text as="span" style={{ color: tokens.colors.text.tertiary, margin: `0 ${tokens.spacing[2]}` }}>/</Text>
          <Text as="span" style={{ fontSize: tokens.typography.fontSize.sm }}>{t('compCreateTitle')}</Text>
        </Box>

        <Text as="h1" style={{ fontSize: tokens.typography.fontSize['2xl'], fontWeight: 700, marginBottom: tokens.spacing[5] }}>
          {t('compCreateTitle')}
        </Text>

        {!isLoggedIn ? (
          <Box style={{ padding: tokens.spacing[6], textAlign: 'center', background: tokens.colors.bg.secondary, borderRadius: tokens.radius.lg, border: `1px solid ${tokens.colors.border.primary}` }}>
            <Text style={{ color: tokens.colors.text.secondary }}>{t('compLoginRequired')}</Text>
          </Box>
        ) : (
          <form onSubmit={handleSubmit}>
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
              {/* Title */}
              <Box>
                <label style={labelStyle}>{t('compFieldTitle')} *</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t('compFieldTitlePlaceholder')}
                  required
                  maxLength={100}
                  style={inputStyle}
                />
              </Box>

              {/* Description */}
              <Box>
                <label style={labelStyle}>{t('compFieldDescription')}</label>
                <textarea
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
                <label style={labelStyle}>{t('compFieldMetric')} *</label>
                <select
                  value={metric}
                  onChange={(e) => setMetric(e.target.value)}
                  style={inputStyle}
                >
                  {metrics.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </Box>

              {/* Dates */}
              <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
                <Box style={{ flex: 1 }}>
                  <label style={labelStyle}>{t('compStartDate')} *</label>
                  <input
                    type="datetime-local"
                    value={startAt}
                    onChange={(e) => setStartAt(e.target.value)}
                    required
                    style={inputStyle}
                  />
                </Box>
                <Box style={{ flex: 1 }}>
                  <label style={labelStyle}>{t('compEndDate')} *</label>
                  <input
                    type="datetime-local"
                    value={endAt}
                    onChange={(e) => setEndAt(e.target.value)}
                    required
                    style={inputStyle}
                  />
                </Box>
              </Box>

              {/* Max Participants */}
              <Box>
                <label style={labelStyle}>{t('compFieldMaxParticipants')}</label>
                <input
                  type="number"
                  value={maxParticipants}
                  onChange={(e) => setMaxParticipants(e.target.value)}
                  min={2}
                  max={10000}
                  style={inputStyle}
                />
              </Box>

              {error && (
                <Text style={{ color: '#ef4444', fontSize: tokens.typography.fontSize.sm }}>{error}</Text>
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
