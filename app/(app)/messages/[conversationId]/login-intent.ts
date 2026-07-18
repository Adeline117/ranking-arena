const DIRECT_MESSAGES_INBOX = '/inbox?tab=messages&chat=direct'

export function buildConversationReturnPath(conversationId: string): string {
  const normalizedId = conversationId.trim()
  return normalizedId ? `/messages/${encodeURIComponent(normalizedId)}` : DIRECT_MESSAGES_INBOX
}

export function buildConversationLoginHref(conversationId: string): string {
  return `/login?returnUrl=${encodeURIComponent(buildConversationReturnPath(conversationId))}`
}
