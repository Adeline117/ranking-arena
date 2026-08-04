export type ChatSettings = {
  remark: string | null
  is_muted: boolean
  is_pinned: boolean
  is_blocked: boolean
  cleared_before: string | null
  updated_at: string | null
}

export type ChatSettingsPatch = {
  remark?: string | null
  is_muted?: boolean
  is_pinned?: boolean
  is_blocked?: boolean
  clear_history?: true
}

type SettingsField = keyof ChatSettingsPatch

const SETTINGS_KEYS = [
  'remark',
  'is_muted',
  'is_pinned',
  'is_blocked',
  'cleared_before',
  'updated_at',
] as const

const PATCH_KEYS: SettingsField[] = [
  'remark',
  'is_muted',
  'is_pinned',
  'is_blocked',
  'clear_history',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const canonical = [...expected].sort()
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  )
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function readSettings(value: unknown, allowMissingRevision: boolean): ChatSettings | null {
  if (!isRecord(value) || !hasExactKeys(value, SETTINGS_KEYS)) return null
  if (
    (value.remark !== null && typeof value.remark !== 'string') ||
    typeof value.is_muted !== 'boolean' ||
    typeof value.is_pinned !== 'boolean' ||
    typeof value.is_blocked !== 'boolean' ||
    (value.cleared_before !== null && !isTimestamp(value.cleared_before)) ||
    (value.updated_at !== null && !isTimestamp(value.updated_at)) ||
    (!allowMissingRevision && value.updated_at === null)
  ) {
    return null
  }
  return value as ChatSettings
}

export function readChatSettingsLoadAcknowledgement(
  value: unknown,
  identity: { actorId: string; targetId: string; conversationId: string }
): ChatSettings | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['actor_id', 'conversation_id', 'settings', 'target_id']) ||
    value.actor_id !== identity.actorId ||
    value.target_id !== identity.targetId ||
    value.conversation_id !== identity.conversationId
  ) {
    return null
  }
  return readSettings(value.settings, true)
}

export function readChatSettingsMutationAcknowledgement(
  value: unknown,
  identity: { actorId: string; targetId: string; conversationId: string },
  updates: ChatSettingsPatch
): ChatSettings | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'actor_id',
      'applied_fields',
      'block_status',
      'conversation_id',
      'settings',
      'target_id',
    ]) ||
    value.actor_id !== identity.actorId ||
    value.target_id !== identity.targetId ||
    value.conversation_id !== identity.conversationId ||
    !Array.isArray(value.applied_fields)
  ) {
    return null
  }

  const expectedFields = PATCH_KEYS.filter((field) =>
    Object.prototype.hasOwnProperty.call(updates, field)
  )
  if (
    value.applied_fields.length !== expectedFields.length ||
    value.applied_fields.some((field, index) => field !== expectedFields[index])
  ) {
    return null
  }

  const settings = readSettings(value.settings, false)
  if (!settings) return null
  const blockStatus = value.block_status
  if (blockStatus !== null && typeof blockStatus !== 'string') return null
  if ('remark' in updates && settings.remark !== updates.remark) return null
  if ('is_muted' in updates && settings.is_muted !== updates.is_muted) return null
  if ('is_pinned' in updates && settings.is_pinned !== updates.is_pinned) return null
  if ('is_blocked' in updates) {
    const validStatuses = updates.is_blocked
      ? new Set(['blocked', 'already_blocked'])
      : new Set(['unblocked', 'already_unblocked'])
    if (
      settings.is_blocked !== updates.is_blocked ||
      typeof blockStatus !== 'string' ||
      !validStatuses.has(blockStatus)
    ) {
      return null
    }
  } else if (blockStatus !== null) {
    return null
  }
  if (
    updates.clear_history &&
    (settings.cleared_before === null || settings.cleared_before !== settings.updated_at)
  ) {
    return null
  }
  return settings
}
