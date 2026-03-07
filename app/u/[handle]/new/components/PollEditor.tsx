'use client'

import { Box, Text } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import type { PollOption } from '../types'

interface PollEditorProps {
  pollEnabled: boolean
  setPollEnabled: (v: boolean) => void
  pollOptions: PollOption[]
  setPollOptions: (v: PollOption[]) => void
  pollType: 'single' | 'multiple'
  setPollType: (v: 'single' | 'multiple') => void
  pollDuration: number
  setPollDuration: (v: number) => void
  durationOptions: { label: string; value: number }[]
  t: (key: string) => string
}

export function PollEditor({
  pollEnabled, setPollEnabled, pollOptions, setPollOptions,
  pollType, setPollType, pollDuration, setPollDuration,
  durationOptions, t,
}: PollEditorProps) {
  return (
    <>
      {/* Poll toggle */}
      <Box
        style={{
          padding: tokens.spacing[4],
          borderRadius: tokens.radius.md,
          border: ('1px solid ' + pollEnabled ? tokens.colors.accent.brand : tokens.colors.border.primary),
          background: pollEnabled ? 'var(--color-accent-primary-10)' : tokens.colors.bg.secondary,
          transition: `all ${tokens.transition.base}`,
        }}
      >
        <Box
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[3],
            cursor: 'pointer',
          }}
          onClick={() => setPollEnabled(!pollEnabled)}
        >
          <Box
            style={{
              width: 44,
              height: 24,
              borderRadius: tokens.radius.lg,
              background: pollEnabled ? tokens.colors.accent.brand : tokens.colors.border.primary,
              position: 'relative',
              transition: 'background 0.2s ease',
              flexShrink: 0,
            }}
          >
            <Box
              style={{
                width: 20,
                height: 20,
                borderRadius: '50%',
                background: tokens.colors.white,
                position: 'absolute',
                top: 2,
                left: pollEnabled ? 22 : 2,
                transition: 'left 0.2s ease',
                boxShadow: '0 1px 3px var(--color-overlay-medium)',
              }}
            />
          </Box>
          <Box>
            <Text size="sm" weight="bold" style={{ color: pollEnabled ? tokens.colors.accent.brand : tokens.colors.text.primary }}>
              {t('enablePoll')}
            </Text>
            <Text size="xs" color="tertiary">
              {t('pollDescription')}
            </Text>
          </Box>
        </Box>

        {/* Poll settings */}
        {pollEnabled && (
          <Box style={{ marginTop: tokens.spacing[4], display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
            {/* Poll options */}
            <Box>
              <Text size="xs" weight="bold" style={{ marginBottom: tokens.spacing[2], display: 'block' }}>
                {t('pollOptionsLabel')}
              </Text>
              {pollOptions.map((option, index) => (
                <Box key={index} style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[2] }}>
                  <Text size="xs" color="tertiary" style={{ width: 20 }}>{index + 1}.</Text>
                  <input
                    type="text"
                    placeholder={`${t('pollOptionPlaceholder')} ${index + 1}`}
                    value={option.text}
                    onChange={(e) => {
                      const newOptions = [...pollOptions]
                      newOptions[index].text = e.target.value
                      setPollOptions(newOptions)
                    }}
                    style={{
                      flex: 1,
                      padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                      borderRadius: tokens.radius.md,
                      border: ('1px solid ' + tokens.colors.border.primary),
                      background: tokens.colors.bg.primary,
                      color: tokens.colors.text.primary,
                      fontSize: tokens.typography.fontSize.sm,
                      outline: 'none',
                    }}
                  />
                  {pollOptions.length > 2 && (
                    <button aria-label="Close"
                      onClick={() => setPollOptions(pollOptions.filter((_, i) => i !== index))}
                      style={{
                        width: 28,
                        height: 28,
                        border: 'none',
                        background: 'var(--color-accent-error-20)',
                        color: tokens.colors.accent.error,
                        borderRadius: tokens.radius.md,
                        cursor: 'pointer',
                        fontSize: 16,
                      }}
                    >
                      {'\u00d7'}
                    </button>
                  )}
                </Box>
              ))}
              {pollOptions.length < 6 && (
                <button
                  onClick={() => setPollOptions([...pollOptions, { text: '', votes: 0 }])}
                  style={{
                    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                    border: ('1px dashed ' + tokens.colors.border.primary),
                    background: 'transparent',
                    color: tokens.colors.text.secondary,
                    borderRadius: tokens.radius.md,
                    cursor: 'pointer',
                    fontSize: tokens.typography.fontSize.sm,
                    width: '100%',
                  }}
                >
                  + {t('addPollOption')}
                </button>
              )}
            </Box>

            {/* Poll type and duration */}
            <Box style={{ display: 'flex', gap: tokens.spacing[4], flexWrap: 'wrap' }}>
              {/* Poll type */}
              <Box style={{ flex: 1, minWidth: 150 }}>
                <Text size="xs" weight="bold" style={{ marginBottom: tokens.spacing[2], display: 'block' }}>
                  {t('pollTypeLabel')}
                </Text>
                <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
                  <button
                    onClick={() => setPollType('single')}
                    style={{
                      flex: 1,
                      padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                      border: ('1px solid ' + pollType === 'single' ? tokens.colors.accent.brand : tokens.colors.border.primary),
                      background: pollType === 'single' ? 'var(--color-accent-primary-20)' : 'transparent',
                      color: pollType === 'single' ? tokens.colors.accent.brand : tokens.colors.text.secondary,
                      borderRadius: tokens.radius.md,
                      cursor: 'pointer',
                      fontSize: tokens.typography.fontSize.xs,
                      fontWeight: 600,
                    }}
                  >
                    {t('singleChoice')}
                  </button>
                  <button
                    onClick={() => setPollType('multiple')}
                    style={{
                      flex: 1,
                      padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                      border: ('1px solid ' + pollType === 'multiple' ? tokens.colors.accent.brand : tokens.colors.border.primary),
                      background: pollType === 'multiple' ? 'var(--color-accent-primary-20)' : 'transparent',
                      color: pollType === 'multiple' ? tokens.colors.accent.brand : tokens.colors.text.secondary,
                      borderRadius: tokens.radius.md,
                      cursor: 'pointer',
                      fontSize: tokens.typography.fontSize.xs,
                      fontWeight: 600,
                    }}
                  >
                    {t('multipleChoice')}
                  </button>
                </Box>
              </Box>

              {/* Duration */}
              <Box style={{ flex: 1, minWidth: 150 }}>
                <Text size="xs" weight="bold" style={{ marginBottom: tokens.spacing[2], display: 'block' }}>
                  {t('pollDurationLabel')}
                </Text>
                <select
                  value={pollDuration}
                  onChange={(e) => setPollDuration(Number(e.target.value))}
                  style={{
                    width: '100%',
                    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                    borderRadius: tokens.radius.md,
                    border: ('1px solid ' + tokens.colors.border.primary),
                    background: tokens.colors.bg.primary,
                    color: tokens.colors.text.primary,
                    fontSize: tokens.typography.fontSize.sm,
                    outline: 'none',
                    cursor: 'pointer',
                  }}
                >
                  {durationOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </Box>
            </Box>

            <Text size="xs" color="tertiary">
              {t('pollResultsNote')}
            </Text>
          </Box>
        )}
      </Box>
    </>
  )
}
