'use client'

import { localizedLabel } from '@/lib/utils/format'
import { Box, Text } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import type { PollOption } from '../types'
import { POLL_DURATION_OPTIONS } from '../types'

interface PollEditorProps {
  pollOptions: PollOption[]
  setPollOptions: (options: PollOption[]) => void
  pollType: 'single' | 'multiple'
  setPollType: (type: 'single' | 'multiple') => void
  pollDuration: number
  setPollDuration: (duration: number) => void
  language: string
  t: (key: string) => string
}

export function PollEditor({
  pollOptions, setPollOptions,
  pollType, setPollType,
  pollDuration, setPollDuration,
  language, t,
}: PollEditorProps): React.ReactElement {
  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
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
              aria-label={`${t('pollOptionPlaceholder')} ${index + 1}`}
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
                x
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
            + {t('addOption')}
          </button>
        )}
      </Box>

      <Box style={{ display: 'flex', gap: tokens.spacing[4], flexWrap: 'wrap' }}>
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
                borderRadius: tokens.radius.md,
                border: `1px solid ${pollType === 'single' ? tokens.colors.accent.brand : tokens.colors.border.primary}`,
                background: pollType === 'single' ? 'var(--color-accent-primary-20)' : 'transparent',
                color: pollType === 'single' ? tokens.colors.accent.brand : tokens.colors.text.secondary,
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.sm,
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
                borderRadius: tokens.radius.md,
                border: `1px solid ${pollType === 'multiple' ? tokens.colors.accent.brand : tokens.colors.border.primary}`,
                background: pollType === 'multiple' ? 'var(--color-accent-primary-20)' : 'transparent',
                color: pollType === 'multiple' ? tokens.colors.accent.brand : tokens.colors.text.secondary,
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: 600,
              }}
            >
              {t('multipleChoice')}
            </button>
          </Box>
        </Box>

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
            {POLL_DURATION_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{localizedLabel(opt.label_zh, opt.label_en, language)}</option>
            ))}
          </select>
        </Box>
      </Box>
    </Box>
  )
}
