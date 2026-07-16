export const NOTIFICATION_PREFERENCE_FIELDS = [
  'notify_follow',
  'notify_like',
  'notify_comment',
  'notify_mention',
  'notify_message',
  'notify_trader_events',
] as const

export type NotificationPreferenceField = (typeof NOTIFICATION_PREFERENCE_FIELDS)[number]

export const EMAIL_DIGEST_VALUES = ['none', 'daily', 'weekly'] as const
export type EmailDigestValue = (typeof EMAIL_DIGEST_VALUES)[number]

export const NOTIFICATION_PREFERENCE_INITIAL_KEYS: Record<
  NotificationPreferenceField,
  | 'notifyFollow'
  | 'notifyLike'
  | 'notifyComment'
  | 'notifyMention'
  | 'notifyMessage'
  | 'notifyTraderEvents'
> = {
  notify_follow: 'notifyFollow',
  notify_like: 'notifyLike',
  notify_comment: 'notifyComment',
  notify_mention: 'notifyMention',
  notify_message: 'notifyMessage',
  notify_trader_events: 'notifyTraderEvents',
}
