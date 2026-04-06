'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { ContentPreviewPanel } from './ContentPreview'

const TITLE_MAX_LENGTH = 100
const CONTENT_MAX_LENGTH = 10000

interface EditorFormProps {
  title: string
  content: string
  showPreview: boolean
  saving: boolean
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  onTitleChange: (value: string) => void
  onContentChange: (value: string) => void
  onTogglePreview: (show: boolean) => void
  onTextareaSelect: () => void
  onSubmit: () => void
  moveImageInContent: (url: string, direction: 'up' | 'down') => void
  removeImageFromContent: (url: string) => void
  t: (key: string) => string
}

export function EditorForm({
  title,
  content,
  showPreview,
  saving,
  textareaRef,
  onTitleChange,
  onContentChange,
  onTogglePreview,
  onTextareaSelect,
  onSubmit,
  moveImageInContent,
  removeImageFromContent,
  t,
}: EditorFormProps) {
  return (
    <>
      {/* Title */}
      <Box>
        <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[2] }}>
          <Text size="sm" weight="bold">
            {t('titleLabel')}
          </Text>
          <Text
            size="xs"
            style={{ color: title.length > TITLE_MAX_LENGTH ? tokens.colors.accent.error : tokens.colors.text.tertiary }}
          >
            {title.length}/{TITLE_MAX_LENGTH}
          </Text>
        </Box>
        <input
          type="text"
          placeholder={t('enterTitle')}
          value={title}
          onChange={(e) => onTitleChange(e.target.value.slice(0, TITLE_MAX_LENGTH))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && title.trim()) {
              e.preventDefault()
              textareaRef.current?.focus()
            }
          }}
          maxLength={TITLE_MAX_LENGTH}
          autoFocus
          style={{
            width: '100%',
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            borderRadius: tokens.radius.md,
            border: '1px solid ' + (title.length > TITLE_MAX_LENGTH ? tokens.colors.accent.error : tokens.colors.border.primary),
            background: tokens.colors.bg.secondary,
            color: tokens.colors.text.primary,
            fontSize: tokens.typography.fontSize.base,
            outline: 'none',
            fontFamily: tokens.typography.fontFamily.sans.join(', '),
          }}
        />
      </Box>

      {/* Content */}
      <Box>
        <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[2] }}>
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
            <Text size="sm" weight="bold">
              {t('contentLabel')}
            </Text>
            <Box style={{ display: 'flex', borderRadius: tokens.radius.md, overflow: 'hidden', border: ('1px solid ' + tokens.colors.border.primary) }}>
              <button
                type="button"
                onClick={() => onTogglePreview(false)}
                style={{
                  padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                  border: 'none',
                  background: !showPreview ? tokens.colors.accent.brand : 'transparent',
                  color: !showPreview ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
                  fontSize: tokens.typography.fontSize.xs,
                  cursor: 'pointer',
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                {t('edit')}
              </button>
              <button
                type="button"
                onClick={() => onTogglePreview(true)}
                style={{
                  padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                  border: 'none',
                  borderLeft: ('1px solid ' + tokens.colors.border.primary),
                  background: showPreview ? tokens.colors.accent.brand : 'transparent',
                  color: showPreview ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
                  fontSize: tokens.typography.fontSize.xs,
                  cursor: 'pointer',
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                {t('preview')}
              </button>
            </Box>
          </Box>
          <Text
            size="xs"
            style={{ color: content.length > CONTENT_MAX_LENGTH ? tokens.colors.accent.error : tokens.colors.text.tertiary }}
          >
            {content.length}/{CONTENT_MAX_LENGTH}
          </Text>
        </Box>

        {showPreview ? (
          <ContentPreviewPanel
            content={content}
            moveImageInContent={moveImageInContent}
            removeImageFromContent={removeImageFromContent}
            t={t}
          />
        ) : (
          <textarea
            ref={textareaRef}
            placeholder={t('enterContent')}
            value={content}
            onChange={(e) => {
              onContentChange(e.target.value.slice(0, CONTENT_MAX_LENGTH))
              onTextareaSelect()
            }}
            onSelect={onTextareaSelect}
            onClick={onTextareaSelect}
            onKeyUp={onTextareaSelect}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && title.trim() && !saving) {
                e.preventDefault()
                onSubmit()
              }
            }}
            maxLength={CONTENT_MAX_LENGTH}
            rows={12}
            style={{
              width: '100%',
              padding: tokens.spacing[4],
              borderRadius: tokens.radius.md,
              border: '1px solid ' + (content.length > CONTENT_MAX_LENGTH ? tokens.colors.accent.error : tokens.colors.border.primary),
              background: tokens.colors.bg.secondary,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.base,
              outline: 'none',
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
              resize: 'vertical',
              lineHeight: 1.6,
            }}
          />
        )}
      </Box>
    </>
  )
}
