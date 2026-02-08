'use client'

import { tokens } from '@/lib/design-tokens'
import { ARENA_PURPLE } from '@/lib/utils/content'

interface PollOption {
  text: string
  votes: number | null
}

interface CustomPoll {
  id: string
  question: string
  options: PollOption[]
  type: 'single' | 'multiple'
  endAt: string | null
  isExpired: boolean
  showResults: boolean
  totalVotes: number | null
}

interface CustomPollCardProps {
  poll: CustomPoll | null
  loading: boolean
  userVotes: number[]
  selectedOptions: number[]
  onSelectOption: (index: number) => void
  onSubmitVote: () => void
  votingInProgress: boolean
  language: string
  t: (key: string) => string
}

export function CustomPollCard({
  poll,
  loading,
  userVotes,
  selectedOptions,
  onSelectOption,
  onSubmitVote,
  votingInProgress,
  language,
  t,
}: CustomPollCardProps) {
  if (loading) {
    return (
      <div style={{
        marginTop: 16,
        padding: 16,
        background: tokens.colors.bg.secondary,
        borderRadius: 12,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}>
        <div style={{ color: tokens.colors.text.tertiary, fontSize: 13 }}>{t('loadingPoll')}</div>
      </div>
    )
  }

  if (!poll) {
    return (
      <div style={{
        marginTop: 16,
        padding: 16,
        background: tokens.colors.bg.secondary,
        borderRadius: 12,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}>
        <div style={{ color: tokens.colors.text.tertiary, fontSize: 13 }}>{t('noPoll')}</div>
      </div>
    )
  }

  return (
    <div style={{
      marginTop: 16,
      padding: 16,
      background: tokens.colors.bg.secondary,
      borderRadius: 12,
      border: `1px solid ${tokens.colors.border.primary}`,
    }}>
      {/* Poll header */}
      <div style={{ fontWeight: 700, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
        {poll.question || t('poll')}
        {poll.endAt && (
          <span style={{
            fontSize: 11,
            color: poll.isExpired ? tokens.colors.accent.error : tokens.colors.text.tertiary,
            fontWeight: 400,
          }}>
            {poll.isExpired
              ? t('pollEnded')
              : t('pollDeadline').replace('{date}', new Date(poll.endAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US'))
            }
          </span>
        )}
        {!poll.endAt && (
          <span style={{ fontSize: 11, color: ARENA_PURPLE, fontWeight: 400 }}>{t('pollPermanent')}</span>
        )}
      </div>

      {/* Poll options */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {poll.options.map((option, index) => {
          const isSelected = selectedOptions.includes(index)
          const hasVoted = userVotes.includes(index)
          const votePercentage = poll.showResults && poll.totalVotes && option.votes !== null
            ? Math.round((option.votes / poll.totalVotes) * 100)
            : 0

          return (
            <button
              key={index}
              onClick={() => {
                if (poll.isExpired) return
                onSelectOption(index)
              }}
              disabled={poll.isExpired}
              style={{
                position: 'relative',
                padding: '10px 14px',
                borderRadius: 8,
                border: isSelected || hasVoted
                  ? `2px solid ${ARENA_PURPLE}`
                  : `1px solid ${tokens.colors.border.primary}`,
                background: tokens.colors.bg.primary,
                color: tokens.colors.text.primary,
                cursor: poll.isExpired ? 'default' : 'pointer',
                textAlign: 'left',
                fontSize: 13,
                fontWeight: hasVoted ? 600 : 400,
                overflow: 'hidden',
              }}
            >
              {/* Vote percentage bar */}
              {poll.showResults && (
                <div style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: `${votePercentage}%`,
                  background: hasVoted
                    ? 'rgba(139, 111, 168, 0.2)'
                    : 'rgba(139, 111, 168, 0.1)',
                  transition: 'width 0.3s ease',
                }} />
              )}
              <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>
                  {poll.type === 'multiple' && (
                    <span style={{ marginRight: 8 }}>
                      {isSelected ? '[x]' : '[ ]'}
                    </span>
                  )}
                  {option.text}
                  {hasVoted && ' (voted)'}
                </span>
                {poll.showResults && option.votes !== null && (
                  <span style={{ fontSize: 12, color: tokens.colors.text.secondary }}>
                    {t('votes').replace('{n}', String(option.votes)).replace('{pct}', String(votePercentage))}
                  </span>
                )}
              </div>
            </button>
          )
        })}
      </div>

      {/* Submit vote button */}
      {!poll.isExpired && userVotes.length === 0 && (
        <button
          onClick={onSubmitVote}
          disabled={selectedOptions.length === 0 || votingInProgress}
          style={{
            marginTop: 12,
            padding: '8px 16px',
            background: selectedOptions.length > 0 && !votingInProgress
              ? ARENA_PURPLE
              : 'rgba(139, 111, 168, 0.3)',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            cursor: selectedOptions.length > 0 && !votingInProgress ? 'pointer' : 'not-allowed',
            fontWeight: 600,
            fontSize: 13,
          }}
        >
          {votingInProgress ? t('submittingVote') : t('submitVote')}
        </button>
      )}

      {/* Total votes */}
      {poll.showResults && poll.totalVotes !== null && (
        <div style={{ marginTop: 10, fontSize: 12, color: tokens.colors.text.tertiary }}>
          {t('totalVoters').replace('{n}', String(poll.totalVotes))}
        </div>
      )}

      {/* Vote to see results hint */}
      {!poll.showResults && !poll.isExpired && (
        <div style={{ marginTop: 10, fontSize: 12, color: tokens.colors.text.tertiary }}>
          {t('voteToSeeResults')}
        </div>
      )}
    </div>
  )
}
