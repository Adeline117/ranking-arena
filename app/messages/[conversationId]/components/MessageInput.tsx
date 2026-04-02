'use client'

import { useRef } from 'react'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import VoiceRecorder from '@/app/components/chat/VoiceRecorder'
import { DynamicStickerPicker } from '@/app/components/ui/Dynamic'
import { getCsrfHeaders } from '@/lib/api/client'
import { getMediaTypeLabel } from './types'
import type { MediaAttachment } from './types'
import type { Sticker } from '@/lib/stickers'

interface MessageInputProps {
  newMessage: string
  setNewMessage: (msg: string) => void
  pendingAttachment: MediaAttachment | null
  setPendingAttachment: (a: MediaAttachment | null) => void
  sending: boolean
  uploading: boolean
  setUploading: (v: boolean) => void
  userId: string | null
  conversationId: string
  showStickerPicker: boolean
  setShowStickerPicker: (v: boolean) => void
  onSend: () => void
  onVoiceSent: (url: string, duration: number) => void
  onPreviewOpen: (preview: { type: 'image' | 'video' | 'file'; url: string; fileName?: string }) => void
  showToast: (msg: string, type: 'error' | 'success' | 'warning' | 'info') => void
  t: (key: string) => string
  language: string
  inputRef: React.RefObject<HTMLTextAreaElement | null>
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function MessageInput({
  newMessage,
  setNewMessage,
  pendingAttachment,
  setPendingAttachment,
  sending,
  uploading,
  setUploading,
  userId,
  conversationId,
  showStickerPicker,
  setShowStickerPicker,
  onSend,
  onVoiceSent,
  onPreviewOpen,
  showToast,
  t,
  language: _language,
  inputRef,
}: MessageInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !userId || !conversationId) return
    if (fileInputRef.current) fileInputRef.current.value = ''
    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('userId', userId)
      formData.append('conversationId', conversationId)
      const res = await fetch('/api/chat/upload', { method: 'POST', headers: getCsrfHeaders(), body: formData })
      const data = await res.json()
      if (!res.ok) { showToast(data.error || t('uploadFailed'), 'error'); return }
      setPendingAttachment({ url: data.url, type: data.category, fileName: data.fileName, originalName: data.originalName, fileSize: data.fileSize })
    } catch { showToast(t('uploadFailedRetry'), 'error') }
    finally { setUploading(false) }
  }

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items || !userId || !conversationId) return
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (!file) return
        setUploading(true)
        try {
          const formData = new FormData()
          formData.append('file', file)
          formData.append('userId', userId)
          formData.append('conversationId', conversationId)
          const res = await globalThis.fetch('/api/chat/upload', { method: 'POST', headers: getCsrfHeaders(), body: formData })
          const data = await res.json()
          if (res.ok) {
            setPendingAttachment({ url: data.url, type: data.category, fileName: data.fileName, originalName: data.originalName || 'pasted-image.png', fileSize: data.fileSize })
          } else { showToast(data.error || t('uploadFailed'), 'error') }
        } catch { showToast(t('uploadFailedRetry'), 'error') }
        finally { setUploading(false) }
        break
      }
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend() }
  }

  return (
    <Box style={{
      padding: `${tokens.spacing[3]} ${tokens.spacing[4]} ${tokens.spacing[4]}`,
      background: tokens.colors.bg.secondary,
      borderTop: `1px solid ${tokens.colors.border.primary}`,
      boxShadow: '0 -2px 12px var(--color-overlay-subtle)',
    }}>
      {/* Attachment preview */}
      {pendingAttachment && (
        <Box style={{ maxWidth: 800, margin: '0 auto', marginBottom: 8, padding: 8, background: tokens.colors.bg.tertiary, borderRadius: tokens.radius.lg, display: 'flex', alignItems: 'center', gap: 10 }}>
          {pendingAttachment.type === 'image' ? (
            <Image src={pendingAttachment.url} alt="" width={60} height={60} style={{ width: 60, height: 60, objectFit: 'cover', borderRadius: tokens.radius.md, cursor: 'pointer' }} onClick={() => onPreviewOpen({ type: 'image', url: pendingAttachment.url })} unoptimized />
          ) : pendingAttachment.type === 'video' ? (
            <Box onClick={() => onPreviewOpen({ type: 'video', url: pendingAttachment.url })} style={{ width: 60, height: 60, borderRadius: tokens.radius.md, background: tokens.colors.bg.primary, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.secondary} strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3" /></svg>
            </Box>
          ) : (
            <Box style={{ width: 60, height: 60, borderRadius: tokens.radius.md, background: tokens.colors.bg.primary, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.secondary} strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
            </Box>
          )}
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Text size="sm" style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pendingAttachment.originalName}</Text>
            <Text size="xs" color="tertiary">{pendingAttachment.fileSize ? formatFileSize(pendingAttachment.fileSize) : ''} • {getMediaTypeLabel(pendingAttachment.type, t)}</Text>
          </Box>
          <button onClick={() => setPendingAttachment(null)} aria-label="Remove attachment" style={{ width: 28, height: 28, borderRadius: '50%', border: 'none', background: 'var(--color-accent-error-15)', color: tokens.colors.accent.error, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </Box>
      )}

      {/* Character counter */}
      {newMessage.length > 1800 && (
        <Box style={{ maxWidth: 800, margin: '0 auto', marginBottom: 4, textAlign: 'right', paddingRight: 8 }}>
          <Text size="xs" style={{
            color: newMessage.length > 2000 ? tokens.colors.accent.error : newMessage.length > 1900 ? tokens.colors.accent.warning : tokens.colors.text.tertiary,
            fontSize: 11, fontWeight: newMessage.length > 2000 ? 700 : 400,
          }}>{newMessage.length}/2000</Text>
        </Box>
      )}

      <Box style={{
        maxWidth: 800, margin: '0 auto', display: 'flex', gap: tokens.spacing[2], alignItems: 'flex-end',
        background: tokens.colors.bg.primary, borderRadius: 28, padding: '8px 8px 8px 14px',
        border: `1px solid ${tokens.colors.border.primary}`, boxShadow: tokens.shadow.inner,
        transition: `border-color ${tokens.transition.fast}, box-shadow ${tokens.transition.fast}`,
      }}>
        {/* Hidden file input */}
        <input ref={fileInputRef} type="file" accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.zip,.rar" onChange={handleFileSelect} style={{ display: 'none' }} />

        {/* File upload button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          style={{
            width: 36, height: 36, borderRadius: '50%', border: 'none', background: 'transparent',
            color: tokens.colors.text.tertiary, cursor: uploading ? 'not-allowed' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            opacity: uploading ? 0.5 : 1, transition: 'all 0.2s',
          }}
          title={t('sendMediaFile')}
        >
          {uploading ? (
            <Box style={{ width: 18, height: 18, border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          )}
        </button>

        <textarea
          ref={inputRef}
          value={newMessage}
          onChange={(e) => {
            setNewMessage(e.target.value)
            const el = e.target
            el.style.height = 'auto'
            el.style.height = `${Math.min(el.scrollHeight, 100)}px`
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={t('enterMessage')}
          rows={1}
          style={{
            flex: 1, padding: '8px 0', border: 'none', background: 'transparent',
            color: tokens.colors.text.primary, fontSize: tokens.typography.fontSize.sm,
            fontFamily: tokens.typography.fontFamily.sans.join(', '), outline: 'none',
            resize: 'none', minHeight: 24, maxHeight: 100, lineHeight: 1.5,
          }}
          onFocus={(e) => {
            const container = e.currentTarget.parentElement
            if (container) { container.style.borderColor = tokens.colors.accent.brand; container.style.boxShadow = '0 0 0 2px var(--color-accent-primary-20)' }
          }}
          onBlur={(e) => {
            const container = e.currentTarget.parentElement
            if (container) { container.style.borderColor = tokens.colors.border.primary; container.style.boxShadow = 'none' }
          }}
        />

        {/* Sticker button */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setShowStickerPicker(!showStickerPicker)}
            style={{
              width: 36, height: 36, borderRadius: '50%', border: 'none', background: 'transparent',
              color: showStickerPicker ? tokens.colors.accent.brand : tokens.colors.text.tertiary,
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s',
            }}
            title={t('stickersButton')}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z" />
              <path d="M14 3v4a2 2 0 0 0 2 2h4" />
            </svg>
          </button>
          <DynamicStickerPicker
            isOpen={showStickerPicker}
            onClose={() => setShowStickerPicker(false)}
            onSelect={(sticker: Sticker) => {
              setNewMessage(newMessage + `[sticker:${sticker.id}]`)
              setShowStickerPicker(false)
              inputRef.current?.focus()
            }}
          />
        </div>

        <VoiceRecorder onVoiceSent={onVoiceSent} disabled={sending} />

        {/* Send button */}
        <button
          onClick={onSend}
          disabled={(!newMessage.trim() && !pendingAttachment) || sending || newMessage.length > 2000}
          style={{
            width: 42, height: 42, borderRadius: '50%', border: 'none',
            background: (newMessage.trim() || pendingAttachment) && newMessage.length <= 2000 ? tokens.gradient.primary : tokens.colors.bg.tertiary || 'var(--glass-border-light)',
            color: (newMessage.trim() || pendingAttachment) && newMessage.length <= 2000 ? 'var(--color-on-accent)' : tokens.colors.text.tertiary,
            cursor: (newMessage.trim() || pendingAttachment) && !sending && newMessage.length <= 2000 ? 'pointer' : 'default',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: `all ${tokens.transition.fast}`, flexShrink: 0,
            opacity: sending ? 0.6 : 1,
            boxShadow: (newMessage.trim() || pendingAttachment) && newMessage.length <= 2000 ? tokens.shadow.glow : 'none',
          }}
          onMouseEnter={(e) => {
            if ((newMessage.trim() || pendingAttachment) && newMessage.length <= 2000) {
              e.currentTarget.style.transform = 'scale(1.08)'; e.currentTarget.style.background = tokens.gradient.primaryHover; e.currentTarget.style.boxShadow = tokens.shadow.glowLg
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'scale(1)'
            if ((newMessage.trim() || pendingAttachment) && newMessage.length <= 2000) {
              e.currentTarget.style.background = tokens.gradient.primary; e.currentTarget.style.boxShadow = tokens.shadow.glow
            }
          }}
        >
          {sending ? (
            <Box style={{ width: 18, height: 18, border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          )}
        </button>
      </Box>
    </Box>
  )
}
