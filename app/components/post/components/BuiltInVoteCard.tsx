'use client'

import { alpha, tokens } from '@/lib/design-tokens'
import type { PollChoice } from '@/lib/types'

const CHOICES: PollChoice[] = ['bull', 'bear', 'wait']

function choiceColor(choice: PollChoice): string {
  if (choice === 'bull') return tokens.colors.sentiment.bull
  if (choice === 'bear') return tokens.colors.sentiment.bear
  return tokens.colors.sentiment.neutral
}

function choiceLabel(choice: PollChoice, t: (key: string) => string): string {
  if (choice === 'bull') return t('bullish')
  if (choice === 'bear') return t('bearish')
  return t('wait')
}

export default function BuiltInVoteCard({
  postId,
  counts,
  selectedChoice,
  onVote,
  t,
}: {
  postId: string
  counts: { bull: number; bear: number; wait: number }
  selectedChoice: PollChoice | null
  onVote: (postId: string, choice: PollChoice) => Promise<void>
  t: (key: string) => string
}) {
  const total = counts.bull + counts.bear + counts.wait

  return (
    <section
      aria-label={t('poll')}
      style={{
        marginTop: tokens.spacing[4],
        padding: tokens.spacing[3],
        border: `1px solid ${tokens.colors.border.primary}`,
        borderRadius: tokens.radius.lg,
        background: tokens.colors.bg.tertiary,
      }}
    >
      <div
        style={{
          marginBottom: tokens.spacing[2],
          color: tokens.colors.text.secondary,
          fontSize: tokens.typography.fontSize.xs,
          fontWeight: tokens.typography.fontWeight.semibold,
        }}
      >
        {t('poll')}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: tokens.spacing[2],
        }}
      >
        {CHOICES.map((choice) => {
          const color = choiceColor(choice)
          const count = counts[choice]
          const percent = total > 0 ? Math.round((count / total) * 100) : 0
          const selected = selectedChoice === choice

          return (
            <button
              key={choice}
              type="button"
              aria-pressed={selected}
              aria-label={`${choiceLabel(choice, t)} ${percent}%`}
              onClick={() => void onVote(postId, choice)}
              style={{
                position: 'relative',
                minWidth: 0,
                minHeight: 52,
                overflow: 'hidden',
                padding: `${tokens.spacing[2]} ${tokens.spacing[2]}`,
                border: `1px solid ${selected ? color : tokens.colors.border.primary}`,
                borderRadius: tokens.radius.md,
                background: selected ? alpha(color, 14) : tokens.colors.bg.secondary,
                color,
                cursor: 'pointer',
                textAlign: 'left',
                transition: tokens.transition.all,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  inset: 'auto 0 0',
                  width: `${percent}%`,
                  height: 3,
                  background: color,
                  opacity: selected ? 0.9 : 0.45,
                  transition: 'width 180ms ease',
                }}
              />
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: tokens.spacing[1],
                }}
              >
                <span
                  style={{
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: tokens.typography.fontSize.xs,
                    fontWeight: selected
                      ? tokens.typography.fontWeight.bold
                      : tokens.typography.fontWeight.medium,
                  }}
                >
                  {choiceLabel(choice, t)}
                </span>
                <span style={{ flexShrink: 0, fontSize: tokens.typography.fontSize.xs }}>
                  {percent}%
                </span>
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
