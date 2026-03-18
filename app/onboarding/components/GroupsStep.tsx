'use client'

import Image from 'next/image'
import { Box, Text } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import type { OnboardingTheme, Group } from './types'

interface GroupsStepProps {
  theme: OnboardingTheme
  language: string
  groups: Group[]
  joinedGroups: Set<string>
  loadingGroups: boolean
  saving: boolean
  tr: (key: string) => string
  onJoinGroup: (groupId: string) => void
  onBack: () => void
  onComplete: () => void
}

export default function GroupsStep({ theme, language, groups, joinedGroups, loadingGroups, saving, tr, onJoinGroup, onBack, onComplete }: GroupsStepProps) {
  return (
    <div key="groups" className="step-content">
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
        {tr('onboardingGroupTitle')}
      </Text>
      <Text style={{ marginBottom: 24, textAlign: 'center', color: theme.textSecondary }}>
        {tr('onboardingGroupDesc')}
      </Text>

      <Box style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 28, maxHeight: 340, overflowY: 'auto' }}>
        {loadingGroups ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} style={{ height: 60, borderRadius: 14, background: theme.optionBg }} />
          ))
        ) : groups.length === 0 ? (
          <Text style={{ textAlign: 'center', color: theme.textSecondary, padding: '20px 0' }}>
            {tr('noGroupsYet')}
          </Text>
        ) : (
          groups.map(g => {
            const isJoined = joinedGroups.has(g.id)
            const displayName = language === 'zh' ? g.name : (g.name_en || g.name)
            return (
              <Box key={g.id} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
                borderRadius: 14, border: `1px solid ${theme.optionBorder}`, background: theme.optionBg,
              }}>
                <Box style={{
                  width: 40, height: 40, borderRadius: 10, flexShrink: 0,
                  background: 'linear-gradient(135deg, var(--color-accent-primary-30), var(--color-pro-gold-glow))',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 16, fontWeight: 600, color: theme.textPrimary, overflow: 'hidden',
                }}>
                  {g.avatar_url ? (
                    <Image src={g.avatar_url} alt={displayName} width={40} height={40} loading="lazy" unoptimized style={{ width: 40, height: 40, borderRadius: 10, objectFit: 'cover' }} />
                  ) : (
                    displayName.charAt(0).toUpperCase()
                  )}
                </Box>
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Text size="sm" weight="semibold" style={{
                    color: theme.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {displayName}
                  </Text>
                  {g.member_count != null && (
                    <Text size="xs" style={{ color: theme.textSecondary }}>
                      {g.member_count} {tr('membersCount')}
                    </Text>
                  )}
                </Box>
                <button className="follow-btn" onClick={() => onJoinGroup(g.id)}
                  style={{
                    background: isJoined ? theme.optionBg : theme.brandGradient,
                    color: isJoined ? theme.textSecondary : 'var(--color-on-accent)',
                    border: isJoined ? `1px solid ${theme.optionBorder}` : 'none',
                  }}>
                  {isJoined ? tr('onboardingJoinedBtn') : tr('onboardingJoinBtn')}
                </button>
              </Box>
            )
          })
        )}
      </Box>

      <Box style={{ display: 'flex', gap: 14 }}>
        <button className="continue-btn" onClick={onComplete} disabled={saving}
          style={{
            flex: 1, padding: '14px 20px', borderRadius: tokens.radius.lg,
            border: `1px solid ${theme.optionBorder}`, background: 'transparent',
            color: theme.textSecondary, fontWeight: 600, fontSize: 16,
            cursor: saving ? 'not-allowed' : 'pointer',
          }}>
          {tr('skip')}
        </button>
        <button className="continue-btn" onClick={onComplete} disabled={saving} style={{
          flex: 2, padding: '14px 20px', borderRadius: tokens.radius.lg, border: 'none',
          background: saving ? 'var(--color-accent-primary-20)' : theme.brandGradient,
          color: tokens.colors.white, fontWeight: 700, fontSize: 16,
          cursor: saving ? 'not-allowed' : 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        }}>
          {saving && <div style={{ width: 16, height: 16, border: '2px solid var(--glass-border-heavy)', borderTopColor: 'var(--foreground)', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />}
          {saving ? tr('saving') : tr('continueButton')}
        </button>
      </Box>
    </div>
  )
}
