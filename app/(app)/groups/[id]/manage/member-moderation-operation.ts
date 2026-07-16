import { jwtSubject } from '@/lib/auth/token-subject'
import { isViewerScopeCurrent, type ViewerKey } from '@/lib/auth/viewer-scope'

export const MAX_PENDING_GROUP_MODERATION_OPERATIONS = 500

export type GroupMemberModerationAction = 'mute' | 'unmute'

type OperationBase = {
  actorId: string
  viewerKey: ViewerKey
  sessionGeneration: number
  action: GroupMemberModerationAction
  groupId: string
  targetUserId: string
  operationId: string
  fingerprint: string
}

export type GroupMemberModerationOperation =
  | (OperationBase & {
      action: 'mute'
      body: {
        muted_until: string
        reason: string
      }
    })
  | (OperationBase & {
      action: 'unmute'
      body: null
    })

type MuteIntent = {
  actorId: string
  viewerKey?: ViewerKey
  sessionGeneration?: number
  action: 'mute'
  groupId: string
  targetUserId: string
  durationMs: number
  reason: string
  nowMs: number
}

type UnmuteIntent = {
  actorId: string
  viewerKey?: ViewerKey
  sessionGeneration?: number
  action: 'unmute'
  groupId: string
  targetUserId: string
}

type GroupMemberModerationIntent = MuteIntent | UnmuteIntent

type OperationIdFactory = () => string

export type GroupMemberModerationViewerScope = {
  actorId: string | null
  viewerKey: ViewerKey
  sessionGeneration: number
}

export function isGroupMemberModerationViewerCurrent(
  expected: GroupMemberModerationViewerScope,
  rendered: GroupMemberModerationViewerScope,
  accessToken: string | null
): boolean {
  const actorId = expected.actorId?.toLowerCase() ?? null
  return (
    actorId !== null &&
    expected.viewerKey === `user:${actorId}` &&
    rendered.actorId?.toLowerCase() === actorId &&
    rendered.viewerKey === expected.viewerKey &&
    rendered.sessionGeneration === expected.sessionGeneration &&
    jwtSubject(accessToken) === actorId &&
    isViewerScopeCurrent({
      userId: actorId,
      viewerKey: expected.viewerKey,
      sessionGeneration: expected.sessionGeneration,
    })
  )
}

function browserOperationId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('Secure UUID generation is unavailable')
  }
  return globalThis.crypto.randomUUID()
}

function intentFingerprint(intent: GroupMemberModerationIntent): string {
  return JSON.stringify(
    intent.action === 'mute'
      ? [
          intent.actorId.toLowerCase(),
          intent.action,
          intent.groupId.toLowerCase(),
          intent.targetUserId.toLowerCase(),
          intent.durationMs,
          intent.reason,
        ]
      : [
          intent.actorId.toLowerCase(),
          intent.action,
          intent.groupId.toLowerCase(),
          intent.targetUserId.toLowerCase(),
        ]
  )
}

function operationKey(actorId: string, groupId: string, targetUserId: string): string {
  return `${actorId.toLowerCase()}:${groupId.toLowerCase()}:${targetUserId.toLowerCase()}`
}

function canonicalViewerScope(scope: GroupMemberModerationViewerScope): string {
  return JSON.stringify([
    scope.actorId?.toLowerCase() ?? null,
    scope.viewerKey,
    scope.sessionGeneration,
  ])
}

/**
 * Keeps one unresolved moderation intent per canonical actor/group/target edge.
 * Changed payload/action replaces only that target's intent; other targets keep
 * their uncertain operations. Exact retries reuse both UUID and mute timestamp.
 * Map insertion order gives deterministic oldest-first eviction.
 */
export class GroupMemberModerationOperationLedger {
  private readonly operations = new Map<string, GroupMemberModerationOperation>()
  private viewerScope: string | null = null

  constructor(
    private readonly operationIdFactory: OperationIdFactory = browserOperationId,
    private readonly maxEntries = MAX_PENDING_GROUP_MODERATION_OPERATIONS
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error('maxEntries must be a positive integer')
    }
  }

  acquire(intent: MuteIntent): Extract<GroupMemberModerationOperation, { action: 'mute' }>
  acquire(intent: UnmuteIntent): Extract<GroupMemberModerationOperation, { action: 'unmute' }>
  acquire(intent: GroupMemberModerationIntent): GroupMemberModerationOperation
  acquire(intent: GroupMemberModerationIntent): GroupMemberModerationOperation {
    const actorId = intent.actorId.toLowerCase()
    const viewerKey: ViewerKey = intent.viewerKey ?? `user:${actorId}`
    const sessionGeneration = intent.sessionGeneration ?? 0
    this.scope({ actorId, viewerKey, sessionGeneration })
    const key = operationKey(actorId, intent.groupId, intent.targetUserId)
    const fingerprint = intentFingerprint(intent)
    const existing = this.operations.get(key)
    if (existing?.fingerprint === fingerprint) return existing

    const base: OperationBase = {
      actorId,
      viewerKey,
      sessionGeneration,
      action: intent.action,
      groupId: intent.groupId.toLowerCase(),
      targetUserId: intent.targetUserId.toLowerCase(),
      operationId: this.operationIdFactory(),
      fingerprint,
    }
    const operation: GroupMemberModerationOperation =
      intent.action === 'mute'
        ? {
            ...base,
            action: 'mute',
            body: {
              muted_until: new Date(intent.nowMs + intent.durationMs).toISOString(),
              reason: intent.reason,
            },
          }
        : { ...base, action: 'unmute', body: null }

    // Deleting first makes replacement order explicit and deterministic.
    this.operations.delete(key)
    this.operations.set(key, operation)
    while (this.operations.size > this.maxEntries) {
      const oldestKey = this.operations.keys().next().value as string | undefined
      if (oldestKey === undefined) break
      this.operations.delete(oldestKey)
    }
    return operation
  }

  complete(operation: GroupMemberModerationOperation): boolean {
    if (
      this.viewerScope !==
      canonicalViewerScope({
        actorId: operation.actorId,
        viewerKey: operation.viewerKey,
        sessionGeneration: operation.sessionGeneration,
      })
    ) {
      return false
    }
    const key = operationKey(operation.actorId, operation.groupId, operation.targetUserId)
    if (this.operations.get(key)?.operationId !== operation.operationId) return false
    this.operations.delete(key)
    return true
  }

  isCurrent(operation: GroupMemberModerationOperation): boolean {
    if (
      this.viewerScope !==
      canonicalViewerScope({
        actorId: operation.actorId,
        viewerKey: operation.viewerKey,
        sessionGeneration: operation.sessionGeneration,
      })
    ) {
      return false
    }
    const key = operationKey(operation.actorId, operation.groupId, operation.targetUserId)
    return this.operations.get(key)?.operationId === operation.operationId
  }

  /**
   * Changes identity scope on a principal generation transition. Token
   * refreshes that retain viewerKey and sessionGeneration keep unresolved
   * operation keys, while even an A -> A reauthentication invalidates them.
   * acquire() calls this synchronously as well, closing the render/effect gap.
   */
  scope(scope: GroupMemberModerationViewerScope): void {
    const nextScope = canonicalViewerScope(scope)
    if (this.viewerScope === nextScope) return
    this.operations.clear()
    this.viewerScope = nextScope
  }

  get size(): number {
    return this.operations.size
  }
}

type FetchResponse = {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
}

type FetchMemberModeration = (
  input: string,
  init: {
    method: 'POST' | 'DELETE'
    headers: Record<string, string>
    body?: string
  }
) => Promise<FetchResponse>

export type GroupMemberModerationRequestResult =
  | { ok: true; completedCurrentIntent: boolean }
  | { ok: false; kind: 'http'; error?: string }
  | { ok: false; kind: 'invalid-ack' }
  | { ok: false; kind: 'network'; error: unknown }

export class GroupMemberModerationRequestSingleFlight {
  private readonly requests = new Map<string, Promise<GroupMemberModerationRequestResult>>()

  run(
    operationId: string,
    start: () => Promise<GroupMemberModerationRequestResult>
  ): { promise: Promise<GroupMemberModerationRequestResult>; started: boolean } {
    const existing = this.requests.get(operationId)
    if (existing) return { promise: existing, started: false }

    const promise = start().finally(() => {
      if (this.requests.get(operationId) === promise) this.requests.delete(operationId)
    })
    this.requests.set(operationId, promise)
    return { promise, started: true }
  }

  get size(): number {
    return this.requests.size
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

export function isExactGroupMemberModerationAcknowledgement(
  action: GroupMemberModerationAction,
  operationId: string,
  value: unknown
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const acknowledgement = value as Record<string, unknown>
  const replayKey = action === 'mute' ? 'already_muted' : 'already_unmuted'
  const baseKeys = ['operation_id', 'success']
  const exactShape =
    hasExactKeys(acknowledgement, baseKeys) ||
    (hasExactKeys(acknowledgement, [...baseKeys, replayKey]) && acknowledgement[replayKey] === true)

  return (
    exactShape && acknowledgement.success === true && acknowledgement.operation_id === operationId
  )
}

async function readHttpError(response: FetchResponse): Promise<string | undefined> {
  if (!response.headers.get('content-type')?.includes('application/json')) return undefined
  try {
    const value = await response.json()
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const error = (value as Record<string, unknown>).error
    return typeof error === 'string' ? error : undefined
  } catch {
    return undefined
  }
}

export async function runGroupMemberModerationRequest(input: {
  operation: GroupMemberModerationOperation
  ledger: GroupMemberModerationOperationLedger
  accessToken: string
  csrfHeaders: Record<string, string>
  fetcher?: FetchMemberModeration
  onAcknowledged?: () => void
  isViewerCurrent: () => boolean
  reconcileTarget: (targetUserId: string) => Promise<void>
  onReconcileError?: (error: unknown) => void
}): Promise<GroupMemberModerationRequestResult> {
  const { operation } = input
  const fetcher: FetchMemberModeration =
    input.fetcher ?? ((requestInput, init) => fetch(requestInput, init))
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.accessToken}`,
    'Idempotency-Key': operation.operationId,
    ...input.csrfHeaders,
  }
  if (operation.action === 'mute') headers['Content-Type'] = 'application/json'

  let response: FetchResponse
  try {
    response = await fetcher(
      `/api/groups/${operation.groupId}/members/${operation.targetUserId}/mute`,
      {
        method: operation.action === 'mute' ? 'POST' : 'DELETE',
        headers,
        ...(operation.action === 'mute' ? { body: JSON.stringify(operation.body) } : {}),
      }
    )
  } catch (error) {
    return { ok: false, kind: 'network', error }
  }

  if (!response.ok) {
    const error = await readHttpError(response)
    return { ok: false, kind: 'http', error }
  }

  let acknowledgement: unknown
  try {
    acknowledgement = await response.json()
  } catch {
    return { ok: false, kind: 'invalid-ack' }
  }
  if (
    !isExactGroupMemberModerationAcknowledgement(
      operation.action,
      operation.operationId,
      acknowledgement
    )
  ) {
    return { ok: false, kind: 'invalid-ack' }
  }

  // A committed response from a previous principal generation must not read
  // into, reconcile, or complete state owned by the current viewer.
  if (!input.isViewerCurrent()) {
    return { ok: true, completedCurrentIntent: false }
  }

  try {
    await input.reconcileTarget(operation.targetUserId)
  } catch (error) {
    if (input.isViewerCurrent()) input.onReconcileError?.(error)
  }

  // Reconciliation is authoritative but asynchronous. A newer intent or
  // viewer can replace this operation while the read is in flight, so the
  // final completion is a CAS performed only after the read settles.
  if (!input.isViewerCurrent()) {
    return { ok: true, completedCurrentIntent: false }
  }
  const completedCurrentIntent = input.ledger.complete(operation)
  if (!completedCurrentIntent || !input.isViewerCurrent()) {
    return { ok: true, completedCurrentIntent: false }
  }
  input.onAcknowledged?.()
  return { ok: true, completedCurrentIntent: true }
}
