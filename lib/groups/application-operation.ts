'use client'

const STORAGE_KEY = 'arena:group-application-operations:v1'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256_PATTERN = /^[0-9a-f]{64}$/

type JsonPrimitive = null | boolean | number | string
type CanonicalValue = JsonPrimitive | CanonicalValue[] | { [key: string]: CanonicalValue }

export type GroupProfileEditRule = { en: string; zh: string }
export type GroupProfileEditRoleNames = {
  admin: { en: string; zh: string }
  member: { en: string; zh: string }
}

export interface GroupProfileEditPayload {
  avatar_url: string | null
  description: string | null
  description_en: string | null
  is_premium_only: boolean
  name: string
  name_en: string | null
  role_names: GroupProfileEditRoleNames | null
  rules: string | null
  rules_json: GroupProfileEditRule[] | null
}

export type GroupProfileEditPayloadInput = Omit<
  GroupProfileEditPayload,
  'name' | 'rules' | 'rules_json'
> & {
  name: string | null
  rules_json: readonly GroupProfileEditRule[] | null
}

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

export function groupProfileEditSubmitScope(actorId: string, groupId: string): string {
  return `group-profile-edit:submit:v1:${actorId}:${groupId}`
}

export function groupProfileEditReviewScope(actorId: string, applicationId: string): string {
  return `group-profile-edit:review:v1:${actorId}:${applicationId}`
}

function normalizeOptionalText(value: string | null): string | null {
  const normalized = value?.trim().normalize('NFC') ?? ''
  return normalized || null
}

/** Build the exact JSON snapshot fingerprinted by the edit-submit operation. */
export function canonicalizeGroupProfileEditPayload(
  input: GroupProfileEditPayloadInput
): GroupProfileEditPayload {
  const normalizedName = normalizeOptionalText(input.name)
  const normalizedNameEn = normalizeOptionalText(input.name_en)
  const normalizedRules =
    input.rules_json
      ?.map((rule) => ({
        en: rule.en.trim().normalize('NFC'),
        zh: rule.zh.trim().normalize('NFC'),
      }))
      .filter((rule) => rule.zh || rule.en) ?? []

  return {
    avatar_url: normalizeOptionalText(input.avatar_url),
    description: normalizeOptionalText(input.description),
    description_en: normalizeOptionalText(input.description_en),
    is_premium_only: input.is_premium_only,
    name: normalizedName ?? normalizedNameEn ?? '',
    name_en: normalizedNameEn,
    role_names: input.role_names
      ? {
          admin: {
            en: input.role_names.admin.en.trim().normalize('NFC'),
            zh: input.role_names.admin.zh.trim().normalize('NFC'),
          },
          member: {
            en: input.role_names.member.en.trim().normalize('NFC'),
            zh: input.role_names.member.zh.trim().normalize('NFC'),
          },
        }
      : null,
    rules:
      normalizedRules
        .map((rule) => rule.zh)
        .filter(Boolean)
        .join('\n') || null,
    rules_json: normalizedRules.length > 0 ? normalizedRules : null,
  }
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

export function completeGroupApplicationOperation(operation: GroupApplicationOperation): boolean {
  const entries = readStoredEntries()
  const current = entries[operation.scope]
  if (
    current?.actorId !== operation.actorId ||
    current.intentFingerprint !== operation.intentFingerprint ||
    current.operationId !== operation.operationId
  ) {
    return false
  }
  delete entries[operation.scope]
  writeStoredEntries(entries)
  return true
}

export function startGroupApplicationSingleFlight<T>(
  operation: GroupApplicationOperation,
  task: () => Promise<T>
): { promise: Promise<T>; started: boolean } {
  const existing = inFlightOperations.get(operation.operationId) as Promise<T> | undefined
  if (existing) return { promise: existing, started: false }

  const promise = task().finally(() => {
    if (inFlightOperations.get(operation.operationId) === promise) {
      inFlightOperations.delete(operation.operationId)
    }
  })
  inFlightOperations.set(operation.operationId, promise)
  return { promise, started: true }
}

export function runGroupApplicationSingleFlight<T>(
  operation: GroupApplicationOperation,
  task: () => Promise<T>
): Promise<T> {
  return startGroupApplicationSingleFlight(operation, task).promise
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

function isCanonicalJson(value: unknown): value is CanonicalValue {
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return value === value.normalize('NFC')
  if (Array.isArray(value)) return value.every(isCanonicalJson)
  if (!isRecord(value)) return false
  return Object.entries(value).every(
    ([key, nested]) =>
      key === key.normalize('NFC') && nested !== undefined && isCanonicalJson(nested)
  )
}

function isExactCanonicalJson(actual: unknown, expected: unknown): boolean {
  return (
    isCanonicalJson(actual) &&
    isCanonicalJson(expected) &&
    canonicalize(actual) === canonicalize(expected)
  )
}

function isNullableBoundedString(value: unknown, maximum: number): value is string | null {
  return value === null || (typeof value === 'string' && codePointLength(value) <= maximum)
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname)
  } catch {
    return false
  }
}

function isStrictIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

function isValidProfileEditRoleNames(value: unknown): value is GroupProfileEditRoleNames | null {
  if (value === null) return true
  if (!isRecord(value) || !hasExactKeys(value, ['admin', 'member'])) return false
  return ['admin', 'member'].every((role) => {
    const names = value[role]
    return (
      isRecord(names) &&
      hasExactKeys(names, ['en', 'zh']) &&
      typeof names.en === 'string' &&
      typeof names.zh === 'string' &&
      codePointLength(names.en) <= 50 &&
      codePointLength(names.zh) <= 50
    )
  })
}

function isValidProfileEditRules(value: unknown): value is GroupProfileEditRule[] | null {
  if (value === null) return true
  return (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every(
      (rule) =>
        isRecord(rule) &&
        hasExactKeys(rule, ['en', 'zh']) &&
        typeof rule.en === 'string' &&
        typeof rule.zh === 'string' &&
        Boolean(rule.en || rule.zh) &&
        codePointLength(rule.en) <= 2_000 &&
        codePointLength(rule.zh) <= 2_000
    )
  )
}

function isValidGroupProfileEditSnapshot(value: Record<string, unknown>): boolean {
  return (
    typeof value.name === 'string' &&
    codePointLength(value.name) >= 1 &&
    codePointLength(value.name) <= 50 &&
    isNullableBoundedString(value.name_en, 50) &&
    isNullableBoundedString(value.description, 500) &&
    isNullableBoundedString(value.description_en, 500) &&
    isNullableBoundedString(value.avatar_url, 2_048) &&
    (value.avatar_url === null || isAbsoluteHttpUrl(value.avatar_url)) &&
    isValidProfileEditRoleNames(value.role_names) &&
    isValidProfileEditRules(value.rules_json) &&
    isNullableBoundedString(value.rules, 10_000) &&
    typeof value.is_premium_only === 'boolean'
  )
}

function isExactProfileEditRoot(
  value: unknown,
  operation: GroupApplicationOperation
): value is Record<string, unknown> & { application: Record<string, unknown> } {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['success', 'message', 'operation_id', 'application']) &&
    value.success === true &&
    value.operation_id === operation.operationId &&
    typeof value.message === 'string' &&
    value.message === value.message.normalize('NFC') &&
    isRecord(value.application)
  )
}

export function isExactSubmitGroupProfileEditAck(
  value: unknown,
  operation: GroupApplicationOperation,
  expectedGroupId: string,
  expectedPayload: GroupProfileEditPayload
): boolean {
  if (
    !isUuid(expectedGroupId) ||
    operation.scope !== groupProfileEditSubmitScope(operation.actorId, expectedGroupId) ||
    !isExactProfileEditRoot(value, operation)
  ) {
    return false
  }

  const application = value.application
  return (
    hasExactKeys(application, [
      'id',
      'group_id',
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
    application.group_id === expectedGroupId &&
    application.applicant_id === operation.actorId &&
    application.status === 'pending' &&
    isStrictIsoTimestamp(application.created_at) &&
    isValidGroupProfileEditSnapshot(application) &&
    isExactCanonicalJson(application.name, expectedPayload.name) &&
    isExactCanonicalJson(application.name_en, expectedPayload.name_en) &&
    isExactCanonicalJson(application.description, expectedPayload.description) &&
    isExactCanonicalJson(application.description_en, expectedPayload.description_en) &&
    isExactCanonicalJson(application.avatar_url, expectedPayload.avatar_url) &&
    isExactCanonicalJson(application.role_names, expectedPayload.role_names) &&
    isExactCanonicalJson(application.rules_json, expectedPayload.rules_json) &&
    isExactCanonicalJson(application.rules, expectedPayload.rules) &&
    application.is_premium_only === expectedPayload.is_premium_only
  )
}

function isExactReviewGroupProfileEditAck(
  value: unknown,
  operation: GroupApplicationOperation,
  expectedApplicationId: string,
  expectedGroupId: string,
  decision: 'approve' | 'reject',
  expectedReason: string | null
): boolean {
  if (
    !isUuid(expectedApplicationId) ||
    !isUuid(expectedGroupId) ||
    operation.scope !== groupProfileEditReviewScope(operation.actorId, expectedApplicationId) ||
    !isExactProfileEditRoot(value, operation)
  ) {
    return false
  }

  const application = value.application
  const expectedKeys =
    decision === 'approve'
      ? ['id', 'group_id', 'status']
      : ['id', 'group_id', 'status', 'reject_reason']
  return (
    hasExactKeys(application, expectedKeys) &&
    application.id === expectedApplicationId &&
    application.group_id === expectedGroupId &&
    application.status === (decision === 'approve' ? 'approved' : 'rejected') &&
    (decision === 'approve' || isExactCanonicalJson(application.reject_reason, expectedReason))
  )
}

export function isExactApproveGroupProfileEditAck(
  value: unknown,
  operation: GroupApplicationOperation,
  expectedApplicationId: string,
  expectedGroupId: string
): boolean {
  return isExactReviewGroupProfileEditAck(
    value,
    operation,
    expectedApplicationId,
    expectedGroupId,
    'approve',
    null
  )
}

export function isExactRejectGroupProfileEditAck(
  value: unknown,
  operation: GroupApplicationOperation,
  expectedApplicationId: string,
  expectedGroupId: string,
  expectedReason: string | null
): boolean {
  return isExactReviewGroupProfileEditAck(
    value,
    operation,
    expectedApplicationId,
    expectedGroupId,
    'reject',
    expectedReason
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
