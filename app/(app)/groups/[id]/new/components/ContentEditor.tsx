'use client'

import { useRef, useState, useCallback } from 'react'
import { Box, Text } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import { renderContentWithLinks } from '@/lib/utils/content'
import { DynamicStickerPicker } from '@/app/components/ui/Dynamic'
import { MentionAutocomplete } from '@/app/components/post/components/MentionAutocomplete'
import type { Sticker } from '@/lib/stickers'
import Image from 'next/image'
import { CharCount, inputStyle } from './FormControls'
import type { LinkPreview } from '../types'
import { CONTENT_MAX_LENGTH } from '../types'

interface ContentEditorProps {
  content: string
  setContent: (content: string) => void
  showPreview: boolean
  setShowPreview: (show: boolean) => void
  showStickerPicker: boolean
  setShowStickerPicker: (show: boolean | ((prev: boolean) => boolean)) => void
  draftSaved: boolean
  linkPreview: LinkPreview | null
  setLinkPreview: (preview: LinkPreview | null) => void
  linkPreviewLoading: boolean
  linkPreviewUrlRef: React.MutableRefObject<string | null>
  language: string
  t: (key: string) => string
  accessToken?: string | null
}

export function ContentEditor({
  content, setContent,
  showPreview, setShowPreview,
  showStickerPicker, setShowStickerPicker,
  draftSaved,
  linkPreview, setLinkPreview, linkPreviewLoading, linkPreviewUrlRef,
  language: _language, t,
  accessToken,
}: ContentEditorProps): React.ReactElement {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [cursorPos, setCursorPos] = useState(0)
  const [showMention, setShowMention] = useState(false)

  const handleContentChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newContent = e.target.value.slice(0, CONTENT_MAX_LENGTH)
    setContent(newContent)
    const pos = e.target.selectionStart || 0
    setCursorPos(pos)
    // Check if in @mention context
    const before = newContent.slice(0, pos)
    setShowMention(/@\w{0,30}$/.test(before))
  }, [setContent])

  const handleMentionSelect = useCallback((handle: string, start: number, end: number) => {
    const newText = content.slice(0, start) + `@${handle} ` + content.slice(end)
    setContent(newText)
    setShowMention(false)
    // Focus back and set cursor after the inserted mention
    setTimeout(() => {
      if (textareaRef.current) {
        const newPos = start + handle.length + 2 // @handle + space
        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(newPos, newPos)
      }
    }, 0)
  }, [content, setContent])

  return (
    <Box>
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[2] }}>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
          <Text size="sm" weight="bold">
            {t('contentLabel')}
          </Text>
          <Box style={{ display: 'flex', borderRadius: tokens.radius.md, overflow: 'hidden', border: ('1px solid ' + tokens.colors.border.primary) }}>
            <button
              type="button"
              onClick={() => setShowPreview(false)}
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
              onClick={() => setShowPreview(true)}
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
          {draftSaved && (
            <Text size="xs" color="tertiary" style={{ color: tokens.colors.accent.success }}>
              {t('draftSaved')}
            </Text>
          )}
        </Box>
        <CharCount current={content.length} max={CONTENT_MAX_LENGTH} />
      </Box>

      {showPreview ? (
        <Box
          style={{
            width: '100%',
            minHeight: 288,
            padding: tokens.spacing[4],
            borderRadius: tokens.radius.md,
            border: ('2px solid ' + tokens.colors.accent.brand),
            background: `linear-gradient(135deg, var(--color-accent-primary-08) 0%, var(--color-accent-primary-10) 100%)`,
            color: tokens.colors.text.primary,
            fontSize: tokens.typography.fontSize.base,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            position: 'relative',
          }}
        >
          <Box
            style={{
              position: 'absolute',
              top: -12,
              left: 12,
              background: tokens.colors.accent.brand,
              color: tokens.colors.white,
              padding: '2px 10px',
              borderRadius: tokens.radius.full,
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            {t('previewMode')}
          </Box>
          {content ? renderContentWithLinks(content) : <Text color="tertiary">{t('previewPlaceholder')}</Text>}
        </Box>
      ) : (
        <div style={{ position: 'relative' }}>
          <textarea
            ref={textareaRef}
            placeholder={t('enterContent')}
            value={content}
            onChange={handleContentChange}
            onSelect={(e) => setCursorPos((e.target as HTMLTextAreaElement).selectionStart || 0)}
            maxLength={CONTENT_MAX_LENGTH}
            rows={12}
            aria-label={t('contentLabel')}
            className="post-editor-input"
            style={{ ...inputStyle, padding: tokens.spacing[4], resize: 'vertical', lineHeight: 1.7, transition: 'border-color 0.2s, box-shadow 0.2s', minHeight: 240 }}
          />
          {showMention && (
            <MentionAutocomplete
              text={content}
              cursorPosition={cursorPos}
              onSelect={handleMentionSelect}
              onClose={() => setShowMention(false)}
              accessToken={accessToken ?? null}
              style={{ bottom: 'auto', top: '100%', marginTop: 4, marginBottom: 0 }}
            />
          )}
        </div>
      )}

      {/* UF15: Link Preview Card */}
      {linkPreviewLoading && (
        <Box style={{ marginTop: tokens.spacing[2], padding: tokens.spacing[3], borderRadius: tokens.radius.md, background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.border.primary}` }}>
          <Text size="xs" color="tertiary">{t('fetchingLinkPreview')}</Text>
        </Box>
      )}
      {linkPreview && !linkPreviewLoading && (
        <Box style={{
          marginTop: tokens.spacing[2], padding: tokens.spacing[3], borderRadius: tokens.radius.md,
          background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.border.primary}`,
          display: 'flex', gap: tokens.spacing[3], alignItems: 'flex-start',
        }}>
          {linkPreview.image && (
            <Image src={linkPreview.image} alt={linkPreview.title || 'Link preview'} width={80} height={60} loading="lazy" unoptimized style={{ width: 80, height: 60, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />
          )}
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Text size="sm" weight="bold" style={{ marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {linkPreview.title}
            </Text>
            {linkPreview.description && (
              <Text size="xs" color="secondary" style={{ overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const }}>
                {linkPreview.description}
              </Text>
            )}
            <Text size="xs" color="tertiary" style={{ marginTop: 2 }}>{new URL(linkPreview.url).hostname}</Text>
          </Box>
          <button aria-label="Close" onClick={() => { setLinkPreview(null); linkPreviewUrlRef.current = 'dismissed' }}
            style={{ background: 'none', border: 'none', color: tokens.colors.text.tertiary, cursor: 'pointer', fontSize: 16, padding: 2 }}>x</button>
        </Box>
      )}

      {/* Sticker button */}
      <div style={{ position: 'relative', marginTop: tokens.spacing[2] }}>
        <button
          type="button"
          onClick={() => setShowStickerPicker((prev: boolean) => !prev)}
          style={{
            background: 'transparent',
            border: ('1px solid ' + tokens.colors.border.primary),
            cursor: 'pointer',
            padding: '4px 10px',
            borderRadius: tokens.radius.md,
            color: showStickerPicker ? tokens.colors.accent.brand : tokens.colors.text.tertiary,
            fontSize: 13,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z" />
            <path d="M14 3v4a2 2 0 0 0 2 2h4" />
          </svg>
          {t('stickerButton')}
        </button>
        <DynamicStickerPicker
          isOpen={showStickerPicker}
          onClose={() => setShowStickerPicker(false)}
          onSelect={(sticker: Sticker) => {
            setContent(content + ('[sticker:' + sticker.id + ']'))
            setShowStickerPicker(false)
          }}
        />
      </div>
      <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[1] }}>
        {t('mentionTip')}
      </Text>
    </Box>
  )
}
