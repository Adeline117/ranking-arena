'use client'

import Image from 'next/image'
import { Box, Text } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import type { OnboardingTheme, Trader } from './types'

interface TradersStepProps {
  theme: OnboardingTheme
  language: string
  traders: Trader[]
  followedTraders: Set<string>
  loadingTraders: boolean
  tr: (key: string) => string
  onFollowTrader: (traderId: string) => void
  onBack: () => void
  onContinue: () => void
}

function formatTraderName(t: Trader) {
  const isAddress = (s: string) => /^0x[0-9a-fA-F]{10,}$/.test(s)
  const isLong = (s: string) => /^\d{10,}$/.test(s)
  const name = t.handle || t.source_trader_id
  if (isAddress(name)) return `${name.slice(0, 6)}...${name.slice(-4)}`
  if (isLong(name)) return `ID ${name.slice(-6)}`
  return name
}

export default function TradersStep({ theme, language: _language, traders, followedTraders, loadingTraders, tr, onFollowTrader, onBack, onContinue }: TradersStepProps) {
  return (
    <div key="traders" className="step-content">
      <button onClick={onBack} style={{
        background: 'none', border: 'none', color: theme.textSecondary, cursor: 'pointer',
        fontSize: 13, fontWeight: 600, padding: '4px 0', marginBottom: 12,
        display: 'flex', alignItems: 'center', gap: 4,
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        {tr('back')}
      </button>
      <Text size="2xl" weight="black" style={{
        marginBottom: 8, textAlign: 'center',
        background: `linear-gradient(135deg, ${theme.textPrimary} 0%, var(--color-brand-accent) 100%)`,
        WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
      }}>
        {tr('onboardingFollowTitle')}
      </Text>
      <Text style={{ marginBottom: 24, textAlign: 'center', color: theme.textSecondary }}>
        {tr('onboardingFollowDesc')}
      </Text>

      <Box style={{ display: 'flex', flexDirection: 'column', gap: 0, marginBottom: 28, maxHeight: 340, overflowY: 'auto' }}>
        {loadingTraders ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} style={{ height: 52, borderRadius: 10, background: theme.optionBg, marginBottom: 4 }} />
          ))
        ) : traders.length === 0 ? (
          <Text style={{ textAlign: 'center', color: theme.textSecondary, padding: '20px 0' }}>
            {tr('noDataShort')}
          </Text>
        ) : (
          traders.slice(0, 10).map((t, idx) => {
            const tid = `${t.source}:${t.source_trader_id}`
            const isFollowed = followedTraders.has(tid)
            return (
              <Box key={tid} className="trader-row" style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                borderRadius: 10,
              }}>
                <span style={{
                  fontSize: 13, fontWeight: 800, minWidth: 20, textAlign: 'right',
                  color: idx < 3 ? ['var(--color-accent-warning)', 'var(--color-text-tertiary)', 'var(--color-medal-bronze)'][idx] : theme.textSecondary,
                }}>
                  {idx + 1}
                </span>
                <Box style={{
                  width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                  background: 'linear-gradient(135deg, var(--color-accent-primary-30), var(--color-pro-gold-glow))',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 14, fontWeight: 600, color: theme.textPrimary, overflow: 'hidden',
                }}>
                  {t.avatar_url ? (
                    <Image src={t.avatar_url} alt={formatTraderName(t)} width={36} height={36} loading="lazy" unoptimized style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }} />
                  ) : (
                    (formatTraderName(t)).charAt(0).toUpperCase()
                  )}
                </Box>
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Text size="sm" weight="semibold" style={{
                    color: theme.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {formatTraderName(t)}
                  </Text>
                  <Text size="xs" style={{ color: theme.textSecondary }}>
                    {t.arena_score != null ? `${tr('scoreLabel')} ${t.arena_score.toFixed(0)}` : t.source}
                  </Text>
                </Box>
                <button className="follow-btn" onClick={() => onFollowTrader(tid)}
                  style={{
                    background: isFollowed ? theme.optionBg : theme.brandGradient,
                    color: isFollowed ? theme.textSecondary : 'var(--color-on-accent)',
                    border: isFollowed ? `1px solid ${theme.optionBorder}` : 'none',
                  }}>
                  {isFollowed ? tr('onboardingFollowedBtn') : tr('onboardingFollowBtn')}
                </button>
              </Box>
            )
          })
        )}
      </Box>

      <Box style={{ display: 'flex', gap: 14 }}>
        <button className="continue-btn" onClick={onContinue}
          style={{
            flex: 1, padding: '14px 20px', borderRadius: tokens.radius.lg,
            border: `1px solid ${theme.optionBorder}`, background: 'transparent',
            color: theme.textSecondary, fontWeight: 600, fontSize: 16, cursor: 'pointer',
          }}>
          {tr('skip')}
        </button>
        <button className="continue-btn" onClick={onContinue} style={{
          flex: 2, padding: '14px 20px', borderRadius: tokens.radius.lg, border: 'none',
          background: theme.brandGradient,
          color: tokens.colors.white, fontWeight: 700, fontSize: 16, cursor: 'pointer',
        }}>
          {tr('continueButton')}
        </button>
      </Box>
    </div>
  )
}
