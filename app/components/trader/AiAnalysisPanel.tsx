'use client'

import { useState, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

type Verdict = 'strong_buy' | 'buy' | 'neutral' | 'caution' | 'avoid'

interface AiAnalysis {
  summary: string
  strengths: string[]
  risks: string[]
  verdict: Verdict
}

interface AiAnalysisPanelProps {
  handle: string
  platform?: string
}

const VERDICT_CONFIG: Record<Verdict, { color: string; bgColor: string; labelEn: string; labelZh: string }> = {
  strong_buy: { color: '#22c55e', bgColor: 'rgba(34,197,94,0.15)', labelEn: 'Strong Buy', labelZh: '强烈看好' },
  buy: { color: '#4ade80', bgColor: 'rgba(74,222,128,0.15)', labelEn: 'Buy', labelZh: '看好' },
  neutral: { color: '#facc15', bgColor: 'rgba(250,204,21,0.15)', labelEn: 'Neutral', labelZh: '中性' },
  caution: { color: '#fb923c', bgColor: 'rgba(251,146,60,0.15)', labelEn: 'Caution', labelZh: '谨慎' },
  avoid: { color: '#ef4444', bgColor: 'rgba(239,68,68,0.15)', labelEn: 'Avoid', labelZh: '规避' },
}

export default function AiAnalysisPanel({ handle, platform }: AiAnalysisPanelProps) {
  const [analysis, setAnalysis] = useState<AiAnalysis | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const { t, language } = useLanguage()

  const fetchAnalysis = useCallback(async () => {
    if (analysis) {
      // Toggle collapse if already loaded
      setExpanded(prev => !prev)
      return
    }

    setLoading(true)
    setError(null)
    setExpanded(true)

    try {
      const params = new URLSearchParams()
      if (platform) params.set('platform', platform)
      params.set('lang', language)

      const res = await fetch(`/api/traders/${encodeURIComponent(handle)}/ai-analyze?${params.toString()}`)
      const json = await res.json()

      if (!res.ok) {
        throw new Error(json.error?.message || json.error || t('aiAnalyzeError'))
      }

      setAnalysis(json.data)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('aiAnalyzeError'))
    } finally {
      setLoading(false)
    }
  }, [analysis, handle, platform, language, t])

  const verdictConfig = analysis ? VERDICT_CONFIG[analysis.verdict] : null
  const verdictLabel = verdictConfig
    ? (language === 'zh' ? verdictConfig.labelZh : verdictConfig.labelEn)
    : ''

  return (
    <Box style={{ marginBottom: tokens.spacing[3] }}>
      {/* AI Analyze trigger button */}
      <button
        onClick={fetchAnalysis}
        disabled={loading}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
          borderRadius: tokens.radius.lg,
          background: expanded && analysis
            ? `${tokens.colors.accent.primary}20`
            : tokens.colors.bg.tertiary,
          border: `1px solid ${expanded && analysis ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
          color: tokens.colors.text.primary,
          fontSize: tokens.typography.fontSize.sm,
          fontWeight: tokens.typography.fontWeight.medium,
          cursor: loading ? 'wait' : 'pointer',
          transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
          opacity: loading ? 0.7 : 1,
        }}
        onMouseEnter={(e) => {
          if (!loading) {
            e.currentTarget.style.background = `${tokens.colors.accent.primary}15`
            e.currentTarget.style.borderColor = `${tokens.colors.accent.primary}60`
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = expanded && analysis
            ? `${tokens.colors.accent.primary}20`
            : tokens.colors.bg.tertiary
          e.currentTarget.style.borderColor = expanded && analysis
            ? tokens.colors.accent.primary
            : tokens.colors.border.primary
        }}
      >
        {/* Sparkles icon */}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3l1.912 5.813a2 2 0 001.275 1.275L21 12l-5.813 1.912a2 2 0 00-1.275 1.275L12 21l-1.912-5.813a2 2 0 00-1.275-1.275L3 12l5.813-1.912a2 2 0 001.275-1.275L12 3z" />
        </svg>
        {loading ? (t('aiAnalyzeLoading') || 'Analyzing...') : (t('aiAnalyze') || 'AI Analyze')}
        {analysis && !loading && (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 0.2s ease',
            }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>

      {/* Loading skeleton */}
      {loading && (
        <Box
          style={{
            marginTop: tokens.spacing[3],
            padding: tokens.spacing[4],
            background: tokens.glass.bg.secondary,
            backdropFilter: tokens.glass.blur.lg,
            WebkitBackdropFilter: tokens.glass.blur.lg,
            border: tokens.glass.border.light,
            borderRadius: tokens.radius.lg,
          }}
        >
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
            <Box style={{ width: '100%', height: 14, borderRadius: 4, background: 'var(--color-bg-tertiary)', animation: 'pulse 1.5s ease-in-out infinite' }} />
            <Box style={{ width: '85%', height: 14, borderRadius: 4, background: 'var(--color-bg-tertiary)', animation: 'pulse 1.5s ease-in-out infinite', animationDelay: '0.1s' }} />
            <Box style={{ width: '60%', height: 14, borderRadius: 4, background: 'var(--color-bg-tertiary)', animation: 'pulse 1.5s ease-in-out infinite', animationDelay: '0.2s' }} />
          </Box>
        </Box>
      )}

      {/* Error state */}
      {error && !loading && (
        <Box
          style={{
            marginTop: tokens.spacing[3],
            padding: tokens.spacing[3],
            background: 'rgba(239, 68, 68, 0.08)',
            border: '1px solid rgba(239, 68, 68, 0.2)',
            borderRadius: tokens.radius.md,
          }}
        >
          <Text size="sm" style={{ color: tokens.colors.accent.error }}>
            {error}
          </Text>
        </Box>
      )}

      {/* Analysis result */}
      {analysis && expanded && !loading && (
        <Box
          style={{
            marginTop: tokens.spacing[3],
            padding: tokens.spacing[4],
            background: tokens.glass.bg.secondary,
            backdropFilter: tokens.glass.blur.lg,
            WebkitBackdropFilter: tokens.glass.blur.lg,
            border: tokens.glass.border.light,
            borderRadius: tokens.radius.lg,
            animation: 'fadeIn 0.3s ease',
          }}
        >
          {/* Verdict badge */}
          {verdictConfig && (
            <Box
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: `4px 12px`,
                borderRadius: tokens.radius.full,
                background: verdictConfig.bgColor,
                border: `1px solid ${verdictConfig.color}40`,
                marginBottom: tokens.spacing[3],
              }}
            >
              <Box
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: verdictConfig.color,
                }}
              />
              <Text
                size="sm"
                weight="bold"
                style={{ color: verdictConfig.color, letterSpacing: '0.3px' }}
              >
                {verdictLabel}
              </Text>
            </Box>
          )}

          {/* Summary */}
          <Text
            size="sm"
            style={{
              color: tokens.colors.text.primary,
              lineHeight: 1.6,
              marginBottom: tokens.spacing[4],
            }}
          >
            {analysis.summary}
          </Text>

          {/* Strengths & Risks grid */}
          <Box
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: tokens.spacing[4],
            }}
          >
            {/* Strengths */}
            <Box>
              <Text
                size="xs"
                weight="bold"
                style={{
                  color: tokens.colors.accent.success,
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  marginBottom: tokens.spacing[2],
                }}
              >
                {t('aiAnalyzeStrengths') || 'Strengths'}
              </Text>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {analysis.strengths.map((s, i) => (
                  <Box key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                    <Box
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: tokens.colors.accent.success,
                        marginTop: 6,
                        flexShrink: 0,
                      }}
                    />
                    <Text size="xs" style={{ color: tokens.colors.text.secondary, lineHeight: 1.5 }}>
                      {s}
                    </Text>
                  </Box>
                ))}
              </Box>
            </Box>

            {/* Risks */}
            <Box>
              <Text
                size="xs"
                weight="bold"
                style={{
                  color: tokens.colors.accent.error,
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  marginBottom: tokens.spacing[2],
                }}
              >
                {t('aiAnalyzeRisks') || 'Risks'}
              </Text>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {analysis.risks.map((r, i) => (
                  <Box key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                    <Box
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: tokens.colors.accent.error,
                        marginTop: 6,
                        flexShrink: 0,
                      }}
                    />
                    <Text size="xs" style={{ color: tokens.colors.text.secondary, lineHeight: 1.5 }}>
                      {r}
                    </Text>
                  </Box>
                ))}
              </Box>
            </Box>
          </Box>

          {/* Disclaimer */}
          <Text
            size="xs"
            style={{
              color: tokens.colors.text.tertiary,
              marginTop: tokens.spacing[4],
              paddingTop: tokens.spacing[3],
              borderTop: `1px solid ${tokens.colors.border.primary}`,
              fontStyle: 'italic',
              opacity: 0.7,
            }}
          >
            {t('aiAnalyzeDisclaimer') || 'AI-generated analysis. Not financial advice.'}
          </Text>
        </Box>
      )}
    </Box>
  )
}
