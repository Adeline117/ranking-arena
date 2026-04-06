import { MessageErrorCode } from '@/lib/auth'

export type MessageStatus = 'sending' | 'sent' | 'failed'

export type MediaAttachment = {
  url: string
  type: 'image' | 'video' | 'file'
  fileName?: string
  originalName?: string
  fileSize?: number
}

export type Message = {
  id: string
  sender_id: string
  receiver_id: string
  content: string
  read: boolean
  read_at?: string | null
  created_at: string
  media_url?: string | null
  media_type?: 'image' | 'video' | 'file' | null
  media_name?: string | null
  _status?: MessageStatus
  _tempId?: string
  _errorCode?: MessageErrorCode
  _errorMessage?: string
  _attachment?: MediaAttachment
}

export type OtherUser = {
  id: string
  handle: string | null
  avatar_url?: string | null
  bio?: string | null
}

// Helper to get media type label
export function getMediaTypeLabel(type: 'image' | 'video' | 'file', t: (key: string) => string): string {
  switch (type) {
    case 'image': return t('image')
    case 'video': return t('video')
    case 'file': return t('file')
  }
}

// Helper to calculate message bubble border radius based on grouping
export function getBubbleBorderRadius(isMine: boolean, isSameSenderAsPrev: boolean, isSameSenderAsNext: boolean): string {
  if (isMine) {
    if (isSameSenderAsPrev && isSameSenderAsNext) return '18px 6px 6px 18px'
    if (isSameSenderAsPrev) return '18px 6px 18px 18px'
    if (isSameSenderAsNext) return '18px 18px 6px 18px'
    return '18px'
  }
  if (isSameSenderAsPrev && isSameSenderAsNext) return '6px 18px 18px 6px'
  if (isSameSenderAsPrev) return '6px 18px 18px 18px'
  if (isSameSenderAsNext) return '18px 18px 18px 6px'
  return '18px'
}

// Helper to update message status in state
export function updateMessageStatus(
  messages: Message[],
  identifier: string,
  isTemp: boolean,
  status: MessageStatus,
  errorCode?: MessageErrorCode,
  errorMessage?: string
): Message[] {
  return messages.map(m => {
    const match = isTemp ? m._tempId === identifier : m.id === identifier
    if (!match) return m
    return {
      ...m,
      _status: status,
      _errorCode: errorCode,
      _errorMessage: errorMessage,
    }
  })
}

// Helper to detect URLs in text and render clickable links
export function renderTextWithLinks(text: string, linkColor?: string) {
  const urlRegex = /(https?:\/\/[^\s<>\"']+)/g
  const parts = text.split(urlRegex)
  if (parts.length === 1) return text
  return parts.map((part, i) => {
    if (urlRegex.test(part)) {
      urlRegex.lastIndex = 0
      return (
        <a
          key={i}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          style={{
            color: linkColor || 'var(--color-accent-primary)',
            textDecoration: 'underline',
            wordBreak: 'break-all',
          }}
        >
          {part}
        </a>
      )
    }
    urlRegex.lastIndex = 0
    return part
  })
}

// Helper to check if a file is a PDF
export function isPdfFile(url: string, fileName?: string): boolean {
  const lower = (fileName || url).toLowerCase()
  return lower.endsWith('.pdf')
}

// 按日期分组消息
export function groupMessagesByDate(msgs: Message[]) {
  const groups: { date: string; messages: Message[] }[] = []
  let currentDate = ''
  
  msgs.forEach(msg => {
    const msgDate = new Date(msg.created_at).toDateString()
    if (msgDate !== currentDate) {
      currentDate = msgDate
      groups.push({ date: msg.created_at, messages: [msg] })
    } else {
      groups[groups.length - 1].messages.push(msg)
    }
  })
  
  return groups
}
