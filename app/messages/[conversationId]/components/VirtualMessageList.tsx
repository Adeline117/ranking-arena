'use client'

import { useRef, useEffect, useCallback, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { groupMessagesByDate } from './types'
import type { Message, OtherUser } from './types'
import MessageBubble from './MessageBubble'

interface FlatItem {
  type: 'date-separator' | 'message'
  date?: string
  msg?: Message
  isMine?: boolean
  isSameSenderAsPrev?: boolean
  isSameSenderAsNext?: boolean
}

interface VirtualMessageListProps {
  messages: Message[]
  userId: string | null
  otherUser: OtherUser | null
  highlightedMessageId: string | null
  onRetry: (msg: Message) => void
  onDelete?: (msgId: string) => void
  onPreviewOpen: (preview: { type: 'image' | 'video' | 'file'; url: string; fileName?: string }) => void
  formatTime: (dateString: string) => string
  formatDate: (dateString: string) => string
  t: (key: string) => string
  messageRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
}

export default function VirtualMessageList({
  messages,
  userId,
  otherUser,
  highlightedMessageId,
  onRetry,
  onDelete,
  onPreviewOpen,
  formatTime,
  formatDate,
  t,
  messageRefs,
  hasMore,
  loadingMore,
  onLoadMore,
}: VirtualMessageListProps) {
  const parentRef = useRef<HTMLDivElement>(null)

  // Flatten message groups into a single array of items
  const flatItems = useMemo<FlatItem[]>(() => {
    const items: FlatItem[] = []
    const groups = groupMessagesByDate(messages)
    groups.forEach(group => {
      items.push({ type: 'date-separator', date: group.date })
      group.messages.forEach((msg, i) => {
        const prevMsg = i > 0 ? group.messages[i - 1] : null
        const nextMsg = i < group.messages.length - 1 ? group.messages[i + 1] : null
        items.push({
          type: 'message',
          msg,
          isMine: msg.sender_id === userId,
          isSameSenderAsPrev: prevMsg?.sender_id === msg.sender_id,
          isSameSenderAsNext: nextMsg?.sender_id === msg.sender_id,
        })
      })
    })
    return items
  }, [messages, userId])

  const virtualizer = useVirtualizer({ // eslint-disable-line react-hooks/incompatible-library -- by design
    count: flatItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      const item = flatItems[index]
      return item.type === 'date-separator' ? 40 : 60
    },
    overscan: 10,
  })

  // Auto-scroll to bottom on new messages
  const prevCountRef = useRef(flatItems.length)
  useEffect(() => {
    if (flatItems.length > prevCountRef.current) {
      const lastItem = flatItems[flatItems.length - 1]
      if (lastItem?.msg?.sender_id === userId) {
        virtualizer.scrollToIndex(flatItems.length - 1, { align: 'end' })
      }
    }
    prevCountRef.current = flatItems.length
  }, [flatItems, userId, virtualizer])

  // Load more on scroll to top
  const handleScroll = useCallback(() => {
    if (!parentRef.current || loadingMore || !hasMore) return
    if (parentRef.current.scrollTop < 100) {
      onLoadMore()
    }
  }, [loadingMore, hasMore, onLoadMore])

  return (
    <div
      ref={parentRef}
      onScroll={handleScroll}
      style={{
        flex: 1,
        overflow: 'auto',
        padding: `${tokens.spacing[4]} ${tokens.spacing[4]} ${tokens.spacing[6]}`,
        maxWidth: 800,
        margin: '0 auto',
        width: '100%',
      }}
    >
      {hasMore && (
        <Box style={{ textAlign: 'center', marginBottom: 12 }}>
          <button onClick={onLoadMore} disabled={loadingMore} style={{
            padding: '6px 16px', background: tokens.colors.bg.secondary,
            border: `1px solid ${tokens.colors.border.primary}`, borderRadius: tokens.radius.xl,
            color: tokens.colors.text.secondary, fontSize: 13,
            cursor: loadingMore ? 'not-allowed' : 'pointer',
            opacity: loadingMore ? 0.6 : 1,
          }}>
            {loadingMore ? t('loading') : t('loadOlderMessages')}
          </button>
        </Box>
      )}

      <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
        {virtualizer.getVirtualItems().map(virtualItem => {
          const item = flatItems[virtualItem.index]

          if (item.type === 'date-separator') {
            return (
              <div
                key={`date-${item.date}`}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualItem.start}px)`,
                }}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
              >
                <Box style={{
                  textAlign: 'center', margin: `${tokens.spacing[5]} 0`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: tokens.spacing[3],
                }}>
                  <Box style={{ flex: 1, height: 1, background: `linear-gradient(to right, transparent, ${tokens.colors.border.primary})`, maxWidth: 80 }} />
                  <Text size="xs" color="tertiary" style={{ fontSize: 11, letterSpacing: '0.5px', fontWeight: 600 }}>
                    {formatDate(item.date!)}
                  </Text>
                  <Box style={{ flex: 1, height: 1, background: `linear-gradient(to left, transparent, ${tokens.colors.border.primary})`, maxWidth: 80 }} />
                </Box>
              </div>
            )
          }

          const msg = item.msg!
          return (
            <div
              key={msg.id}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualItem.start}px)`,
              }}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
            >
              <MessageBubble
                msg={msg}
                isMine={item.isMine!}
                isSameSenderAsPrev={item.isSameSenderAsPrev!}
                isSameSenderAsNext={item.isSameSenderAsNext!}
                showTime={!item.isSameSenderAsNext}
                showOtherAvatar={!item.isMine && !item.isSameSenderAsPrev}
                otherUser={otherUser}
                userId={userId}
                highlightedMessageId={highlightedMessageId}
                onRetry={onRetry}
                onDelete={onDelete}
                onPreviewOpen={onPreviewOpen}
                formatTime={formatTime}
                t={t}
                messageRef={(el) => { messageRefs.current[msg.id] = el }}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
