'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import Avatar from '@/app/components/ui/Avatar'
import { getSafeProfileUrl } from '@/lib/utils/profile-navigation'
import { MessageErrorCode } from '@/lib/auth'
import VoiceMessage from '@/app/components/chat/VoiceMessage'
import { renderWithStickers, hasStickers } from '@/app/components/ui/StickerRenderer'
import { getBubbleBorderRadius, renderTextWithLinks } from './types'
import type { Message, OtherUser } from './types'

interface MessageBubbleProps {
  msg: Message
  isMine: boolean
  isSameSenderAsPrev: boolean
  isSameSenderAsNext: boolean
  showTime: boolean
  showOtherAvatar: boolean
  otherUser: OtherUser | null
  userId: string | null
  highlightedMessageId: string | null
  onRetry: (msg: Message) => void
  onDelete?: (msgId: string) => void
  onPreviewOpen: (preview: { type: 'image' | 'video' | 'file'; url: string; fileName?: string }) => void
  formatTime: (dateString: string) => string
  t: (key: string) => string
  messageRef: (el: HTMLDivElement | null) => void
}

export default function MessageBubble({
  msg,
  isMine,
  isSameSenderAsPrev,
  isSameSenderAsNext,
  showTime,
  showOtherAvatar,
  otherUser,
  userId,
  highlightedMessageId,
  onRetry,
  onDelete,
  onPreviewOpen,
  formatTime,
  t,
  messageRef,
}: MessageBubbleProps) {
  const otherProfileUrl = !isMine ? getSafeProfileUrl(otherUser, userId) : null
  const [showContextMenu, setShowContextMenu] = useState(false)
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 })
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close context menu on outside click
  useEffect(() => {
    if (!showContextMenu) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowContextMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showContextMenu])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (msg._status === 'sending') return
    e.preventDefault()
    setContextMenuPos({ x: e.clientX, y: e.clientY })
    setShowContextMenu(true)
  }, [msg._status])

  const handleTouchStart = useCallback(() => {
    if (msg._status === 'sending') return
    longPressTimer.current = setTimeout(() => {
      setShowContextMenu(true)
      setContextMenuPos({ x: 0, y: 0 }) // centered for mobile
    }, 500)
  }, [msg._status])

  const handleTouchEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }, [])

  const handleCopyText = useCallback(() => {
    setShowContextMenu(false)
    if (msg.content) {
      navigator.clipboard.writeText(msg.content).catch(() => { /* clipboard write may fail in some browsers */ }) // eslint-disable-line no-restricted-syntax -- fire-and-forget
    }
  }, [msg.content])

  const handleDelete = useCallback(() => {
    setShowContextMenu(false)
    onDelete?.(msg.id)
  }, [msg.id, onDelete])

  return (
    <div
      ref={messageRef}
      onContextMenu={handleContextMenu}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      style={{
        position: 'relative',
        display: 'flex', flexDirection: 'column',
        alignItems: isMine ? 'flex-end' : 'flex-start',
        marginBottom: isSameSenderAsNext ? '3px' : tokens.spacing[4],
        transition: 'background 0.3s', borderRadius: tokens.radius.lg,
        background: highlightedMessageId === msg.id ? 'var(--color-accent-primary-15)' : 'transparent',
        padding: highlightedMessageId === msg.id ? '4px' : '0px',
      }}
    >
      {/* Message row with avatar */}
      <Box style={{
        display: 'flex', alignItems: 'flex-end', gap: 8,
        maxWidth: '80%', flexDirection: isMine ? 'row-reverse' : 'row',
      }}>
        {/* Other user's avatar */}
        {!isMine && (
          <Box style={{ width: 28, flexShrink: 0 }}>
            {showOtherAvatar && otherUser && (
              otherProfileUrl ? (
                <Link href={otherProfileUrl} style={{ textDecoration: 'none', display: 'block' }} onClick={(e) => e.stopPropagation()}>
                  <Avatar userId={otherUser.id} name={otherUser.handle || `User ${otherUser.id.slice(0, 8)}`} avatarUrl={otherUser.avatar_url} size={28} />
                </Link>
              ) : (
                <Avatar userId={otherUser.id} name={otherUser.handle || `User ${otherUser.id.slice(0, 8)}`} avatarUrl={otherUser.avatar_url} size={28} />
              )
            )}
          </Box>
        )}

        {/* Message bubble */}
        <Box
          className="msg-bubble"
          style={{
            maxWidth: '75%', minWidth: 48,
            padding: (msg.media_url && msg.media_type !== 'file') ? '4px' : '11px 16px',
            borderRadius: getBubbleBorderRadius(isMine, isSameSenderAsPrev, isSameSenderAsNext),
            background: isMine ? tokens.gradient.primary : tokens.colors.bg.secondary,
            color: isMine ? 'var(--color-on-accent)' : tokens.colors.text.primary,
            border: isMine
              ? msg._status === 'failed' ? `1px solid ${tokens.colors.accent.error}99` : 'none'
              : `1px solid ${tokens.colors.border.primary}`,
            boxShadow: isMine
              ? `${tokens.shadow.sm}, 0 2px 8px var(--color-accent-primary-15)`
              : tokens.shadow.sm,
            opacity: msg._status === 'sending' ? 0.65 : 1,
            transition: `opacity ${tokens.transition.fast}, transform ${tokens.transition.fast}`,
            overflow: 'hidden',
          }}
        >
          {/* Media content */}
          {msg.media_url && msg.media_type === 'image' && (
            <Image
              src={msg.media_url} alt="Shared image" width={400} height={300}
              onClick={() => onPreviewOpen({ type: 'image', url: msg.media_url! })}
              style={{ maxWidth: '100%', maxHeight: 300, borderRadius: 14, cursor: 'pointer', display: 'block', objectFit: 'contain' }}
              unoptimized
            />
          )}
          {msg.media_url && msg.media_type === 'video' && (
            <Box onClick={() => onPreviewOpen({ type: 'video', url: msg.media_url! })} style={{ position: 'relative', cursor: 'pointer', borderRadius: 14, overflow: 'hidden' }}>
              <video src={msg.media_url} style={{ maxWidth: '100%', maxHeight: 300, display: 'block' }} />
              <Box style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-overlay-medium)' }}>
                <Box style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--glass-bg-heavy)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill={tokens.colors.text.secondary}><polygon points="5 3 19 12 5 21 5 3" /></svg>
                </Box>
              </Box>
            </Box>
          )}
          {msg.media_url && msg.media_type === 'file' && msg.media_name?.endsWith('.webm') && msg.content?.startsWith('[Voice]') && (
            <VoiceMessage
              url={msg.media_url}
              duration={(() => { const match = msg.content.match(/(\d+):(\d+)\)/); return match ? parseInt(match[1]) * 60 + parseInt(match[2]) : 0 })()}
            />
          )}
          {msg.media_url && msg.media_type === 'file' && !(msg.media_name?.endsWith('.webm') && msg.content?.startsWith('[Voice]')) && (
            <Box
              onClick={(e: React.MouseEvent) => { e.stopPropagation(); onPreviewOpen({ type: 'file', url: msg.media_url!, fileName: msg.media_name || undefined }) }}
              style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', color: 'inherit' }}
            >
              <Box style={{ width: 40, height: 40, borderRadius: tokens.radius.md, background: isMine ? 'var(--glass-border-heavy)' : tokens.colors.bg.tertiary, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
              </Box>
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Text size="sm" style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{msg.media_name || t('file')}</Text>
                <Text size="xs" style={{ opacity: 0.7 }}>{t('clickToPreview') || t('clickToDownload')}</Text>
              </Box>
            </Box>
          )}
          {/* Text content */}
          {msg.content && !msg.content.startsWith('[') && (
            <Text size="sm" style={{
              whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5,
              marginTop: msg.media_url ? 8 : 0,
              padding: msg.media_url && msg.media_type !== 'file' ? '0 10px 6px' : 0,
            }}>
              {hasStickers(msg.content)
                ? renderWithStickers(msg.content, 64)
                : renderTextWithLinks(msg.content, isMine ? 'var(--color-brand-accent)' : 'var(--color-accent-primary)')}
            </Text>
          )}
        </Box>
      </Box>

      {/* Failed state */}
      {isMine && msg._status === 'failed' && (
        <Box style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, marginTop: 4 }}>
          <Text size="xs" style={{ color: tokens.colors.accent.error, fontSize: 11, fontWeight: 500 }}>
            {msg._errorMessage || t('sendFailed')}
          </Text>
          {msg._errorCode !== MessageErrorCode.PERMISSION_DENIED && (
            <button onClick={() => onRetry(msg)} style={{
              padding: '2px 8px', background: 'var(--color-accent-error-15)',
              border: '1px solid var(--color-accent-error-20)', borderRadius: 6,
              color: tokens.colors.accent.error, fontSize: 11, fontWeight: 600,
              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
            }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
              </svg>
              {msg._errorCode === MessageErrorCode.NOT_AUTHENTICATED ? t('relogin') : t('clickToRetry')}
            </button>
          )}
        </Box>
      )}

      {/* Context menu for message actions */}
      {showContextMenu && (
        <div
          ref={menuRef}
          style={{
            position: 'fixed',
            top: contextMenuPos.y || '50%',
            left: contextMenuPos.x || '50%',
            transform: contextMenuPos.x ? 'none' : 'translate(-50%, -50%)',
            zIndex: tokens.zIndex.max,
            background: tokens.colors.bg.secondary,
            border: `1px solid ${tokens.colors.border.primary}`,
            borderRadius: tokens.radius.lg,
            boxShadow: tokens.shadow.xl,
            overflow: 'hidden',
            minWidth: 140,
          }}
        >
          {/* Copy text - available for all messages with content */}
          {msg.content && !msg.content.startsWith('[') && (
            <button
              onClick={handleCopyText}
              aria-label="Copy text"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '10px 16px',
                border: 'none',
                background: 'transparent',
                color: tokens.colors.text.primary,
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                textAlign: 'left',
              }}
              className="hover-bg-tertiary"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              {t('copyText') || 'Copy'}
            </button>
          )}
          {/* Delete - only for own messages */}
          {isMine && onDelete && (
            <button
              onClick={handleDelete}
              aria-label="Delete message"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '10px 16px',
                border: 'none',
                background: 'transparent',
                color: 'var(--color-accent-error)',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                textAlign: 'left',
              }}
              className="hover-bg-tertiary"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              {t('deleteMessage') || (typeof window !== 'undefined' && navigator.language.startsWith('zh') ? '删除消息' : 'Delete')}
            </button>
          )}
        </div>
      )}

      {/* Timestamp */}
      {showTime && msg._status !== 'failed' && (
        <Text size="xs" color="tertiary" className="msg-timestamp" style={{
          marginTop: 5, opacity: 0.5, transition: `opacity ${tokens.transition.fast}`,
          paddingLeft: isMine ? 0 : 36, paddingRight: isMine ? 4 : 0, fontSize: 11,
          display: 'flex', alignItems: 'center', gap: 3,
        }}>
          {msg._status === 'sending' ? (
            <span style={{ opacity: 0.6 }}>{t('sending')}</span>
          ) : (
            <>
              {formatTime(msg.created_at)}
              {isMine && (
                <span style={{ marginLeft: 3, display: 'inline-flex', alignItems: 'center' }}>
                  {msg.read ? (
                    <svg width="16" height="10" viewBox="0 0 16 10" fill="none" style={{ opacity: 0.9 }}>
                      <path d="M1 5l3 3L10 1" stroke={tokens.colors.accent.success} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      <path d="M5 5l3 3L14 1" stroke={tokens.colors.accent.success} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  ) : (
                    <svg width="12" height="10" viewBox="0 0 12 10" fill="none" style={{ opacity: 0.5 }}>
                      <path d="M1 5l3 3L10 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </span>
              )}
            </>
          )}
        </Text>
      )}
    </div>
  )
}
