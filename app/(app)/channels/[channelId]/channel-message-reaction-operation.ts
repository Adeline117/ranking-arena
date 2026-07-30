'use client'

const STORAGE_KEY = 'arena:channel-message-reaction-operations:v1'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256_PATTERN = /^[0-9a-f]{64}$/

export type ChannelMessageReactionIntent = {
  actorId: string
  channelId: string
  messageId: string
  emoji: string
}

export type ChannelMessageReactionOperation = {
  operationId: string
  fingerprint: string
}

export type ChannelMessageReactionAcquisition = {
  operation: ChannelMessageReactionOperation
  reused: boolean
}

type OperationIdFactory = () => string
type OperationStorage = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): OperationStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function browserOperationId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('Secure UUID generation is unavailable')
  }
  return globalThis.crypto.randomUUID()
}

function isStoredOperation(value: unknown): value is ChannelMessageReactionOperation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.operationId === 'string' &&
    UUID_PATTERN.test(record.operationId) &&
    typeof record.fingerprint === 'string' &&
    SHA256_PATTERN.test(record.fingerprint) &&
    Object.keys(record).length === 2
  )
}

function canonicalIntent(intent: ChannelMessageReactionIntent): string {
  if (
    !UUID_PATTERN.test(intent.actorId) ||
    !UUID_PATTERN.test(intent.channelId) ||
    !UUID_PATTERN.test(intent.messageId)
  ) {
    throw new Error('Invalid channel-message reaction operation scope')
  }
  const emoji = intent.emoji.normalize('NFC')
  if (!emoji || emoji !== intent.emoji || Array.from(emoji).length > 10) {
    throw new Error('Invalid channel-message reaction emoji')
  }
  return JSON.stringify([
    'channel-message-reaction:v1',
    intent.actorId.toLowerCase(),
    intent.channelId.toLowerCase(),
    intent.messageId.toLowerCase(),
    emoji,
  ])
}

async function intentFingerprint(intent: ChannelMessageReactionIntent): Promise<string> {
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') {
    throw new Error('Secure operation fingerprinting is unavailable')
  }
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalIntent(intent))
  )
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export class ChannelMessageReactionOperationLedger {
  private readonly pending = new Map<string, ChannelMessageReactionOperation>()
  private storage: OperationStorage | null

  constructor(
    private readonly createOperationId: OperationIdFactory = browserOperationId,
    storage: OperationStorage | null = browserStorage()
  ) {
    this.storage = storage
  }

  private readPending(): void {
    if (!this.storage) return
    try {
      const raw = this.storage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
      const record = parsed as Record<string, unknown>
      if (record.version !== 1 || typeof record.entries !== 'object' || record.entries === null) {
        return
      }
      for (const operation of Object.values(record.entries as Record<string, unknown>)) {
        if (isStoredOperation(operation)) this.pending.set(operation.fingerprint, operation)
      }
    } catch {
      this.storage = null
    }
  }

  private writePending(): void {
    if (!this.storage) return
    try {
      this.storage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: 1, entries: Object.fromEntries(this.pending) })
      )
    } catch {
      this.storage = null
    }
  }

  async acquire(intent: ChannelMessageReactionIntent): Promise<ChannelMessageReactionAcquisition> {
    const fingerprint = await intentFingerprint(intent)
    this.readPending()
    const existing = this.pending.get(fingerprint)
    if (existing) return { operation: existing, reused: true }

    const operationId = this.createOperationId().toLowerCase()
    if (!UUID_PATTERN.test(operationId)) throw new Error('Secure UUID generation failed')
    const operation = { operationId, fingerprint }
    this.pending.set(fingerprint, operation)
    this.writePending()
    return { operation, reused: false }
  }

  complete(operation: ChannelMessageReactionOperation): void {
    this.readPending()
    const pending = this.pending.get(operation.fingerprint)
    if (pending?.operationId === operation.operationId) {
      this.pending.delete(operation.fingerprint)
      this.writePending()
    }
  }
}
