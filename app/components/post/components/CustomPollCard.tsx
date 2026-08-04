'use client'

import { getLocaleFromLanguage } from '@/lib/utils/format'
import { tokens } from '@/lib/design-tokens'
import { ARENA_PURPLE } from '@/lib/utils/content'
import type { PostCustomPollLoadState } from '@/lib/polls/post-vote-client-contract'

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
  loadState: PostCustomPollLoadState
  userVotes: number[]
  selectedOptions: number[]
  onSelectOption: (index: number) => void
  onSubmitVote: () => void
  onRetry: () => void
  votingInProgress: boolean
  language: string
  t: (key: string) => string
}

export function CustomPollCard({
  poll,
  loadState,
  userVotes,
  selectedOptions,
  onSelectOption,
  onSubmitVote,
  onRetry,
  votingInProgress,
  language,
  t,
}: CustomPollCardProps) {
  if (!poll && (loadState === 'idle' || loadState === 'loading')) {
    return (
      <div
        role="status"
        aria-live="polite"
        style={{
          marginTop: 16,
          padding: 16,
          background: tokens.colors.bg.secondary,
          borderRadius: tokens.radius.lg,
          border: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <div
          style={{ color: tokens.colors.text.tertiary, fontSize: tokens.typography.fontSize.sm }}
        >
          {t('loadingPoll')}
        </div>
      </div>
    )
  }

  if (!poll && loadState === 'error') {
    return (
      <div
        role="alert"
        style={{
          marginTop: 16,
          padding: 16,
          background: tokens.colors.bg.secondary,
          borderRadius: tokens.radius.lg,
          border: `1px solid ${tokens.colors.border.primary}`,
          color: tokens.colors.accent.error,
          fontSize: tokens.typography.fontSize.sm,
        }}
      >
        <div>{t('operationFailed')}</div>
        <button
          type="button"
          onClick={onRetry}
          style={{
            marginTop: 12,
            minHeight: 44,
            minWidth: 44,
            padding: '8px 16px',
            borderRadius: tokens.radius.md,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.primary,
            color: tokens.colors.text.primary,
            cursor: 'pointer',
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: tokens.typography.fontWeight.semibold,
          }}
        >
          {t('retry')}
        </button>
      </div>
    )
  }

  if (!poll) {
    return (
      <div
        role="status"
        style={{
          marginTop: 16,
          padding: 16,
          background: tokens.colors.bg.secondary,
          borderRadius: tokens.radius.lg,
          border: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <div
          style={{ color: tokens.colors.text.tertiary, fontSize: tokens.typography.fontSize.sm }}
        >
          {t('noPoll')}
        </div>
      </div>
    )
  }

  const interactionDisabled =
    poll.isExpired ||
    userVotes.length > 0 ||
    votingInProgress ||
    loadState === 'loading' ||
    loadState === 'error'

  return (
    <div
      style={{
        marginTop: 16,
        padding: 16,
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}
    >
      {loadState === 'loading' && (
        <div
          role="status"
          aria-live="polite"
          style={{
            color: tokens.colors.text.tertiary,
            fontSize: tokens.typography.fontSize.xs,
            marginBottom: 8,
          }}
        >
          {t('loadingPoll')}
        </div>
      )}
      {loadState === 'error' && (
        <div role="alert" style={{ marginBottom: 8 }}>
          <div
            style={{
              color: tokens.colors.accent.error,
              fontSize: tokens.typography.fontSize.xs,
            }}
          >
            {t('operationFailed')}
          </div>
          <button
            type="button"
            onClick={onRetry}
            style={{
              marginTop: 8,
              minHeight: 44,
              minWidth: 44,
              padding: '8px 16px',
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
              cursor: 'pointer',
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: tokens.typography.fontWeight.semibold,
            }}
          >
            {t('retry')}
          </button>
        </div>
      )}
      {/* Poll header */}
      <div
        style={{
          fontWeight: tokens.typography.fontWeight.bold,
          marginBottom: 12,
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 8,
          overflowWrap: 'anywhere',
        }}
      >
        {poll.question || t('poll')}
        {poll.endAt && (
          <span
            style={{
              fontSize: tokens.typography.fontSize.xs,
              color: poll.isExpired ? tokens.colors.accent.error : tokens.colors.text.tertiary,
              fontWeight: tokens.typography.fontWeight.normal,
            }}
          >
            {poll.isExpired
              ? t('pollEnded')
              : t('pollDeadline').replace(
                  '{date}',
                  new Date(poll.endAt).toLocaleString(getLocaleFromLanguage(language))
                )}
          </span>
        )}
        {!poll.endAt && (
          <span
            style={{
              fontSize: tokens.typography.fontSize.xs,
              color: ARENA_PURPLE,
              fontWeight: tokens.typography.fontWeight.normal,
            }}
          >
            {t('pollPermanent')}
          </span>
        )}
      </div>

      {/* Poll options */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {poll.options.map((option, index) => {
          const isSelected = selectedOptions.includes(index)
          const hasVoted = userVotes.includes(index)
          const votePercentage =
            poll.showResults &&
            poll.totalVotes !== null &&
            poll.totalVotes > 0 &&
            option.votes !== null
              ? Math.round((option.votes / poll.totalVotes) * 100)
              : 0

          return (
            <button
              type="button"
              key={option.text}
              aria-pressed={isSelected}
              onClick={() => {
                if (interactionDisabled) return
                onSelectOption(index)
              }}
              disabled={interactionDisabled}
              style={{
                position: 'relative',
                padding: '10px 14px',
                minHeight: 44,
                minWidth: 44,
                width: '100%',
                borderRadius: tokens.radius.md,
                border:
                  isSelected || hasVoted
                    ? `2px solid ${ARENA_PURPLE}`
                    : `1px solid ${tokens.colors.border.primary}`,
                background: tokens.colors.bg.primary,
                color: tokens.colors.text.primary,
                cursor: interactionDisabled ? 'not-allowed' : 'pointer',
                textAlign: 'left',
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: hasVoted
                  ? tokens.typography.fontWeight.semibold
                  : tokens.typography.fontWeight.normal,
                overflow: 'hidden',
              }}
            >
              {/* Vote percentage bar */}
              {poll.showResults && (
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: `${votePercentage}%`,
                    background: hasVoted
                      ? 'var(--color-accent-primary-20)'
                      : 'var(--color-accent-primary-10)',
                    transition: 'width 0.3s ease',
                  }}
                />
              )}
              <div
                style={{
                  position: 'relative',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 8,
                }}
              >
                <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  {poll.type === 'multiple' && (
                    <span
                      aria-hidden="true"
                      style={{
                        width: 18,
                        height: 18,
                        marginRight: 8,
                        borderRadius: tokens.radius.sm,
                        border: `1px solid ${isSelected ? ARENA_PURPLE : tokens.colors.border.secondary}`,
                        background: isSelected ? ARENA_PURPLE : 'transparent',
                        color: tokens.colors.white,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: tokens.typography.fontSize.xs,
                        fontWeight: tokens.typography.fontWeight.bold,
                        verticalAlign: 'middle',
                      }}
                    >
                      {isSelected ? '✓' : ''}
                    </span>
                  )}
                  {option.text}
                  {hasVoted && ` (${t('voted')})`}
                </span>
                {poll.showResults && option.votes !== null && (
                  <span
                    style={{
                      fontSize: tokens.typography.fontSize.xs,
                      color: tokens.colors.text.secondary,
                      flexShrink: 0,
                    }}
                  >
                    {t('votes')
                      .replace('{n}', String(option.votes))
                      .replace('{pct}', String(votePercentage))}
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
          type="button"
          onClick={onSubmitVote}
          disabled={selectedOptions.length === 0 || interactionDisabled}
          style={{
            marginTop: 12,
            padding: '8px 16px',
            minHeight: 44,
            minWidth: 44,
            background:
              selectedOptions.length > 0 && !interactionDisabled
                ? ARENA_PURPLE
                : 'var(--color-accent-primary-30)',
            color: tokens.colors.white,
            border: 'none',
            borderRadius: tokens.radius.md,
            cursor: selectedOptions.length > 0 && !interactionDisabled ? 'pointer' : 'not-allowed',
            fontWeight: tokens.typography.fontWeight.semibold,
            fontSize: tokens.typography.fontSize.sm,
          }}
        >
          {votingInProgress ? t('submittingVote') : t('submitVote')}
        </button>
      )}

      {/* Total votes */}
      {poll.type === 'single' && poll.showResults && poll.totalVotes !== null && (
        <div
          style={{
            marginTop: 10,
            fontSize: tokens.typography.fontSize.xs,
            color: tokens.colors.text.tertiary,
          }}
        >
          {t('totalVoters').replace('{n}', String(poll.totalVotes))}
        </div>
      )}

      {/* Vote to see results hint */}
      {!poll.showResults && !poll.isExpired && (
        <div
          style={{
            marginTop: 10,
            fontSize: tokens.typography.fontSize.xs,
            color: tokens.colors.text.tertiary,
          }}
        >
          {t('voteToSeeResults')}
        </div>
      )}
    </div>
  )
}
