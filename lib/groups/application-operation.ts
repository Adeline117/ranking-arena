'use client'

const STORAGE_KEY = 'arena:group-application-operations:v1'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256_PATTERN = /^[0-9a-f]{64}$/

type JsonPrimitive = null | boolean | number | string
type CanonicalValue = JsonPrimitive | CanonicalValue[] | { [key: string]: CanonicalValue }

export interface GroupApplicationOperation {
  actorId: string
  intentFingerprint: string
  operationId: string
  scope: string
}

interface StoredOperations {
  entries: Record<string, GroupApplicationOperation>
  version: 1
}

const memoryEntries = new Map<string, GroupApplicationOperation>()
const inFlightOperations = new Map<string, Promise<unknown>>()
let storageDegraded = false

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function isStoredOperation(value: unknown, scope: string): value is GroupApplicationOperation {
  return (
    isRecord(value) &&
    value.scope === scope &&
    isUuid(value.actorId) &&
    isUuid(value.operationId) &&
    typeof value.intentFingerprint === 'string' &&
    SHA256_PATTERN.test(value.intentFingerprint) &&
    Object.keys(value).length === 4
  )
}

function codePointCompare(left: string, right: string): number {
  const leftPoints = Array.from(left)
  const rightPoints = Array.from(right)
  const commonLength = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < commonLength; index += 1) {
    const difference = leftPoints[index].codePointAt(0)! - rightPoints[index].codePointAt(0)!
    if (difference !== 0) return difference
  }
  return leftPoints.length - rightPoints.length
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'))
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Operation intent contains a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`
  if (!isRecord(value)) throw new TypeError('Operation intent is not canonical JSON')

  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort(codePointCompare)
  return `{${keys
    .map((key) => `${JSON.stringify(key.normalize('NFC'))}:${canonicalize(value[key])}`)
    .join(',')}}`
}

function getStorage(): Storage | null {
  if (typeof window === 'undefined' || storageDegraded) return null
  try {
    return window.localStorage
  } catch {
    storageDegraded = true
    return null
  }
}

function readStoredEntries(): Record<string, GroupApplicationOperation> {
  const storage = getStorage()
  if (!storage) return Object.fromEntries(memoryEntries)

  try {
    const rawValue = storage.getItem(STORAGE_KEY)
    if (!rawValue) {
      memoryEntries.clear()
      return {}
    }
    const parsed: unknown = JSON.parse(rawValue)
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.entries)) {
      storageDegraded = true
      return Object.fromEntries(memoryEntries)
    }

    const validEntries: Record<string, GroupApplicationOperation> = {}
    for (const [scope, entry] of Object.entries(parsed.entries)) {
      if (isStoredOperation(entry, scope)) validEntries[scope] = entry
    }
    memoryEntries.clear()
    for (const [scope, entry] of Object.entries(validEntries)) {
      memoryEntries.set(scope, entry)
    }
    return validEntries
  } catch {
    storageDegraded = true
    return Object.fromEntries(memoryEntries)
  }
}

function writeStoredEntries(entries: Record<string, GroupApplicationOperation>): void {
  memoryEntries.clear()
  for (const [scope, entry] of Object.entries(entries)) memoryEntries.set(scope, entry)

  const storage = getStorage()
  if (!storage) return
  try {
    const value: StoredOperations = { version: 1, entries }
    storage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    storageDegraded = true
    // Memory is authoritative for the rest of this document after a storage
    // quota/security failure, even if localStorage still contains an older row.
  }
}

function createOperationId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20
  )}-${hex.slice(20)}`
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function codePointLength(value: string): number {
  return Array.from(value).length
}

export async function acquireGroupApplicationOperation(
  scope: string,
  actorId: string,
  intent: CanonicalValue
): Promise<GroupApplicationOperation> {
  if (!scope || !isUuid(actorId)) throw new TypeError('Invalid group-application operation scope')

  const intentFingerprint = await sha256(canonicalize(intent))
  // Re-read after the asynchronous digest. Two same-intent clicks that started
  // together therefore observe the first stored UUID instead of racing two IDs.
  const entries = readStoredEntries()
  const current = entries[scope]
  if (current && current.actorId === actorId && current.intentFingerprint === intentFingerprint) {
    return current
  }

  const operation: GroupApplicationOperation = {
    actorId,
    intentFingerprint,
    operationId: createOperationId(),
    scope,
  }
  entries[scope] = operation
  writeStoredEntries(entries)
  return operation
}

export function isCurrentGroupApplicationOperation(operation: GroupApplicationOperation): boolean {
  const current = readStoredEntries()[operation.scope]
  return (
    current?.actorId === operation.actorId &&
    current.intentFingerprint === operation.intentFingerprint &&
    current.operationId === operation.operationId
  )
}

export function completeGroupApplicationOperation(operation: GroupApplicationOperation): void {
  const entries = readStoredEntries()
  const current = entries[operation.scope]
  if (
    current?.actorId !== operation.actorId ||
    current.intentFingerprint !== operation.intentFingerprint ||
    current.operationId !== operation.operationId
  ) {
    return
  }
  delete entries[operation.scope]
  writeStoredEntries(entries)
}

export function runGroupApplicationSingleFlight<T>(
  operation: GroupApplicationOperation,
  task: () => Promise<T>
): Promise<T> {
  const existing = inFlightOperations.get(operation.operationId) as Promise<T> | undefined
  if (existing) return existing

  const promise = task().finally(() => {
    if (inFlightOperations.get(operation.operationId) === promise) {
      inFlightOperations.delete(operation.operationId)
    }
  })
  inFlightOperations.set(operation.operationId, promise)
  return promise
}

export function __resetGroupApplicationOperationsForTests(): void {
  memoryEntries.clear()
  inFlightOperations.clear()
  storageDegraded = false
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(codePointCompare)
  const canonicalExpected = [...expected].sort(codePointCompare)
  return (
    actual.length === canonicalExpected.length &&
    actual.every((key, index) => key === canonicalExpected[index])
  )
}

export function isExactSubmitGroupApplicationAck(
  value: unknown,
  operation: GroupApplicationOperation
): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['success', 'message', 'operation_id', 'application']) ||
    value.success !== true ||
    value.operation_id !== operation.operationId ||
    typeof value.message !== 'string' ||
    !isRecord(value.application)
  ) {
    return false
  }
  const application = value.application
  return (
    hasExactKeys(application, [
      'id',
      'applicant_id',
      'name',
      'name_en',
      'description',
      'description_en',
      'avatar_url',
      'role_names',
      'rules_json',
      'rules',
      'is_premium_only',
      'status',
      'created_at',
    ]) &&
    isUuid(application.id) &&
    application.applicant_id === operation.actorId &&
    typeof application.name === 'string' &&
    codePointLength(application.name) >= 1 &&
    codePointLength(application.name) <= 50 &&
    application.status === 'pending' &&
    typeof application.created_at === 'string' &&
    Number.isFinite(Date.parse(application.created_at))
  )
}

export function isExactApproveGroupApplicationAck(
  value: unknown,
  operation: GroupApplicationOperation
): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['success', 'message', 'operation_id', 'group']) &&
    value.success === true &&
    value.operation_id === operation.operationId &&
    typeof value.message === 'string' &&
    isRecord(value.group) &&
    hasExactKeys(value.group, ['id']) &&
    isUuid(value.group.id)
  )
}

export function isExactRejectGroupApplicationAck(
  value: unknown,
  operation: GroupApplicationOperation
): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['success', 'message', 'operation_id']) &&
    value.success === true &&
    value.operation_id === operation.operationId &&
    typeof value.message === 'string'
  )
}
