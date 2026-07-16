import {
  advanceGroupMemberModerationResourceScope,
  GroupMemberModerationOperationLedger,
  GroupMemberModerationRequestSingleFlight,
  MAX_PENDING_GROUP_MODERATION_OPERATIONS,
  isGroupMemberModerationViewerCurrent,
  isExactGroupMemberModerationAcknowledgement,
  runGroupMemberModerationRequest,
} from '../member-moderation-operation'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const GROUP_ID = '10000000-0000-4000-8000-000000000001'
const OTHER_GROUP_ID = '11000000-0000-4000-8000-000000000011'
const ACTOR_ID = '90000000-0000-4000-8000-000000000009'
const OTHER_ACTOR_ID = '80000000-0000-4000-8000-000000000008'
const TARGET_ID = '20000000-0000-4000-8000-000000000002'
const OTHER_TARGET_ID = '30000000-0000-4000-8000-000000000003'
const OPERATION_ID = '40000000-0000-4000-8000-000000000004'
const OTHER_OPERATION_ID = '50000000-0000-4000-8000-000000000005'
const NOW = Date.parse('2026-07-16T00:00:00.000Z')

function accessTokenFor(subject: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')
  return `header.${payload}.signature`
}

function response(
  body: unknown,
  options: { ok?: boolean; status?: number; jsonRejects?: boolean } = {}
) {
  const ok = options.ok ?? true
  return {
    ok,
    status: options.status ?? (ok ? 200 : 500),
    headers: { get: () => 'application/json' },
    json: options.jsonRejects
      ? jest.fn().mockRejectedValue(new Error('invalid JSON'))
      : jest.fn().mockResolvedValue(body),
  }
}

describe('group member moderation operation ledger', () => {
  it('reuses one operation UUID and exact timestamp for a real mute double-click', () => {
    const operationIds = jest.fn(() => OPERATION_ID)
    const ledger = new GroupMemberModerationOperationLedger(operationIds)
    const first = ledger.acquire({
      actorId: ACTOR_ID,
      action: 'mute',
      groupId: GROUP_ID,
      targetUserId: TARGET_ID,
      durationMs: 3 * 60 * 60 * 1000,
      reason: 'spam',
      nowMs: NOW,
    })
    const doubleClick = ledger.acquire({
      actorId: ACTOR_ID,
      action: 'mute',
      groupId: GROUP_ID,
      targetUserId: TARGET_ID,
      durationMs: 3 * 60 * 60 * 1000,
      reason: 'spam',
      nowMs: NOW + 137,
    })

    expect(doubleClick).toBe(first)
    expect(doubleClick.operationId).toBe(OPERATION_ID)
    expect(doubleClick.body).toEqual({
      muted_until: '2026-07-16T03:00:00.000Z',
      reason: 'spam',
    })
    expect(operationIds).toHaveBeenCalledTimes(1)
  })

  it('replaces changed intent only on the same target edge', () => {
    const operationIds = jest
      .fn()
      .mockReturnValueOnce(OPERATION_ID)
      .mockReturnValueOnce(OTHER_OPERATION_ID)
      .mockReturnValueOnce('60000000-0000-4000-8000-000000000006')
      .mockReturnValueOnce('70000000-0000-4000-8000-000000000007')
    const ledger = new GroupMemberModerationOperationLedger(operationIds)
    const first = ledger.acquire({
      actorId: ACTOR_ID,
      action: 'mute',
      groupId: GROUP_ID,
      targetUserId: TARGET_ID,
      durationMs: 3_600_000,
      reason: '',
      nowMs: NOW,
    })
    const changedPayload = ledger.acquire({
      actorId: ACTOR_ID,
      action: 'mute',
      groupId: GROUP_ID,
      targetUserId: TARGET_ID,
      durationMs: 7_200_000,
      reason: '',
      nowMs: NOW,
    })
    const changedTarget = ledger.acquire({
      actorId: ACTOR_ID,
      action: 'mute',
      groupId: GROUP_ID,
      targetUserId: OTHER_TARGET_ID,
      durationMs: 7_200_000,
      reason: '',
      nowMs: NOW,
    })
    const oppositeAction = ledger.acquire({
      actorId: ACTOR_ID,
      action: 'unmute',
      groupId: GROUP_ID,
      targetUserId: OTHER_TARGET_ID,
    })

    expect(changedPayload.operationId).toBe(OTHER_OPERATION_ID)
    expect(changedTarget.operationId).not.toBe(changedPayload.operationId)
    expect(oppositeAction.operationId).not.toBe(changedTarget.operationId)
    expect(ledger.complete(first)).toBe(false)
    expect(ledger.complete(oppositeAction)).toBe(true)
    expect(ledger.size).toBe(1)
    expect(ledger.complete(changedPayload)).toBe(true)
    expect(ledger.size).toBe(0)
  })

  it('keeps uncertain intents for multiple targets in the same group', () => {
    const operationIds = jest
      .fn()
      .mockReturnValueOnce(OPERATION_ID)
      .mockReturnValueOnce(OTHER_OPERATION_ID)
    const ledger = new GroupMemberModerationOperationLedger(operationIds)
    const firstTarget = ledger.acquire({
      actorId: ACTOR_ID,
      action: 'unmute',
      groupId: GROUP_ID.toUpperCase(),
      targetUserId: TARGET_ID,
    })
    const secondTarget = ledger.acquire({
      actorId: ACTOR_ID,
      action: 'unmute',
      groupId: GROUP_ID,
      targetUserId: OTHER_TARGET_ID,
    })

    expect(ledger.size).toBe(2)
    expect(
      ledger.acquire({
        actorId: ACTOR_ID,
        action: 'unmute',
        groupId: GROUP_ID,
        targetUserId: TARGET_ID,
      })
    ).toBe(firstTarget)
    expect(
      ledger.acquire({
        actorId: ACTOR_ID,
        action: 'unmute',
        groupId: GROUP_ID,
        targetUserId: OTHER_TARGET_ID,
      })
    ).toBe(secondTarget)
  })

  it('retains unresolved operations across same-actor token refresh and clears synchronously on actor change', () => {
    const operationIds = jest
      .fn()
      .mockReturnValueOnce(OPERATION_ID)
      .mockReturnValueOnce(OTHER_OPERATION_ID)
    const ledger = new GroupMemberModerationOperationLedger(operationIds)
    const beforeTokenRefresh = ledger.acquire({
      actorId: ACTOR_ID.toUpperCase(),
      action: 'unmute',
      groupId: GROUP_ID,
      targetUserId: TARGET_ID,
    })

    ledger.scope({
      actorId: ACTOR_ID,
      viewerKey: `user:${ACTOR_ID}`,
      sessionGeneration: 0,
      groupId: GROUP_ID,
      resourceGeneration: 0,
    })

    expect(
      ledger.acquire({
        actorId: ACTOR_ID,
        action: 'unmute',
        groupId: GROUP_ID,
        targetUserId: TARGET_ID,
      })
    ).toBe(beforeTokenRefresh)
    expect(ledger.size).toBe(1)

    const afterActorSwap = ledger.acquire({
      actorId: OTHER_ACTOR_ID,
      action: 'unmute',
      groupId: GROUP_ID,
      targetUserId: TARGET_ID,
    })
    expect(afterActorSwap.operationId).toBe(OTHER_OPERATION_ID)
    expect(afterActorSwap.actorId).toBe(OTHER_ACTOR_ID)
    expect(afterActorSwap).not.toBe(beforeTokenRefresh)
    expect(ledger.complete(beforeTokenRefresh)).toBe(false)
    expect(ledger.size).toBe(1)
  })

  it('invalidates unresolved operations across an A-to-A generation change', () => {
    const operationIds = jest
      .fn()
      .mockReturnValueOnce(OPERATION_ID)
      .mockReturnValueOnce(OTHER_OPERATION_ID)
    const ledger = new GroupMemberModerationOperationLedger(operationIds)
    const first = ledger.acquire({
      actorId: ACTOR_ID,
      viewerKey: `user:${ACTOR_ID}`,
      sessionGeneration: 7,
      action: 'unmute',
      groupId: GROUP_ID,
      targetUserId: TARGET_ID,
    })

    ledger.scope({
      actorId: ACTOR_ID,
      viewerKey: `user:${ACTOR_ID}`,
      sessionGeneration: 8,
      groupId: GROUP_ID,
      resourceGeneration: 0,
    })
    const replacement = ledger.acquire({
      actorId: ACTOR_ID,
      viewerKey: `user:${ACTOR_ID}`,
      sessionGeneration: 8,
      action: 'unmute',
      groupId: GROUP_ID,
      targetUserId: TARGET_ID,
    })

    expect(replacement.operationId).toBe(OTHER_OPERATION_ID)
    expect(ledger.complete(first)).toBe(false)
    expect(ledger.isCurrent(replacement)).toBe(true)
  })

  it('evicts oldest target-edge intents deterministically at the 500-entry bound', () => {
    let sequence = 0
    const ledger = new GroupMemberModerationOperationLedger(
      () => `40000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`
    )
    let oldestOperation = ''
    for (let index = 0; index <= MAX_PENDING_GROUP_MODERATION_OPERATIONS; index += 1) {
      const operation = ledger.acquire({
        actorId: ACTOR_ID,
        action: 'unmute',
        groupId: GROUP_ID,
        targetUserId: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      })
      if (index === 0) oldestOperation = operation.operationId
    }

    expect(ledger.size).toBe(MAX_PENDING_GROUP_MODERATION_OPERATIONS)
    const recreatedOldest = ledger.acquire({
      actorId: ACTOR_ID,
      action: 'unmute',
      groupId: GROUP_ID,
      targetUserId: '20000000-0000-4000-8000-000000000000',
    })
    expect(recreatedOldest.operationId).not.toBe(oldestOperation)
    expect(ledger.size).toBe(MAX_PENDING_GROUP_MODERATION_OPERATIONS)
  })
})

describe('group member moderation request', () => {
  it('single-flights a double-click by operation id and acknowledges it once', async () => {
    const ledger = new GroupMemberModerationOperationLedger(() => OPERATION_ID)
    const operation = ledger.acquire({
      actorId: ACTOR_ID,
      action: 'unmute',
      groupId: GROUP_ID,
      targetUserId: TARGET_ID,
    })
    let resolveResponse!: (value: ReturnType<typeof response>) => void
    const fetcher = jest.fn(
      () =>
        new Promise<ReturnType<typeof response>>((resolve) => {
          resolveResponse = resolve
        })
    )
    const onAcknowledged = jest.fn()
    const reconcileTarget = jest.fn().mockResolvedValue(undefined)
    const requests = new GroupMemberModerationRequestSingleFlight()
    const start = () =>
      runGroupMemberModerationRequest({
        operation,
        ledger,
        accessToken: 'token',
        csrfHeaders: {},
        isViewerCurrent: () => true,
        fetcher,
        onAcknowledged,
        reconcileTarget,
      })

    const first = requests.run(operation.operationId, start)
    const doubleClick = requests.run(operation.operationId, start)

    expect(first.started).toBe(true)
    expect(doubleClick.started).toBe(false)
    expect(doubleClick.promise).toBe(first.promise)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(requests.size).toBe(1)

    resolveResponse(response({ success: true, operation_id: OPERATION_ID }))
    await expect(first.promise).resolves.toEqual({ ok: true, completedCurrentIntent: true })
    await expect(doubleClick.promise).resolves.toEqual({ ok: true, completedCurrentIntent: true })
    expect(onAcknowledged).toHaveBeenCalledTimes(1)
    expect(reconcileTarget).toHaveBeenCalledTimes(1)
    expect(requests.size).toBe(0)
  })

  it('uses one Idempotency-Key and silently reconciles the target after an exact ACK', async () => {
    const ledger = new GroupMemberModerationOperationLedger(() => OPERATION_ID)
    const operation = ledger.acquire({
      actorId: ACTOR_ID,
      action: 'mute',
      groupId: GROUP_ID,
      targetUserId: TARGET_ID,
      durationMs: 3 * 60 * 60 * 1000,
      reason: 'spam',
      nowMs: NOW,
    })
    const fetcher = jest
      .fn()
      .mockResolvedValue(response({ success: true, operation_id: OPERATION_ID }))
    const onAcknowledged = jest.fn()
    const reconcileTarget = jest.fn().mockResolvedValue(undefined)

    const result = await runGroupMemberModerationRequest({
      operation,
      ledger,
      accessToken: 'token',
      csrfHeaders: { 'x-csrf-token': 'csrf' },
      isViewerCurrent: () => true,
      fetcher,
      onAcknowledged,
      reconcileTarget,
    })

    expect(result).toEqual({ ok: true, completedCurrentIntent: true })
    expect(fetcher).toHaveBeenCalledWith(`/api/groups/${GROUP_ID}/members/${TARGET_ID}/mute`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
        'Idempotency-Key': OPERATION_ID,
        'x-csrf-token': 'csrf',
      },
      body: JSON.stringify(operation.body),
    })
    expect(onAcknowledged).toHaveBeenCalledTimes(1)
    expect(reconcileTarget).toHaveBeenCalledWith(TARGET_ID)
    expect(ledger.size).toBe(0)
  })

  it.each([
    ['5xx', response({ error: 'down' }, { ok: false, status: 503 })],
    ['malformed JSON 200', response(null, { jsonRejects: true })],
    ['wrong-operation ACK', response({ success: true, operation_id: OTHER_OPERATION_ID })],
    ['extra-field ACK', response({ success: true, operation_id: OPERATION_ID, extra: true })],
  ])('retains the exact operation after %s', async (_label, fetchResponse) => {
    const ledger = new GroupMemberModerationOperationLedger(() => OPERATION_ID)
    const operation = ledger.acquire({
      actorId: ACTOR_ID,
      action: 'unmute',
      groupId: GROUP_ID,
      targetUserId: TARGET_ID,
    })
    const reconcileTarget = jest.fn()

    const result = await runGroupMemberModerationRequest({
      operation,
      ledger,
      accessToken: 'token',
      csrfHeaders: {},
      isViewerCurrent: () => true,
      fetcher: jest.fn().mockResolvedValue(fetchResponse),
      onAcknowledged: jest.fn(),
      reconcileTarget,
    })

    expect(result.ok).toBe(false)
    expect(ledger.size).toBe(1)
    expect(
      ledger.acquire({
        actorId: ACTOR_ID,
        action: 'unmute',
        groupId: GROUP_ID,
        targetUserId: TARGET_ID,
      })
    ).toBe(operation)
    expect(reconcileTarget).not.toHaveBeenCalled()
  })

  it.each([401, 403, 409, 429, 503])(
    'retains the current operation after non-acknowledging HTTP %s',
    async (status) => {
      const operationIds = jest
        .fn()
        .mockReturnValueOnce(OPERATION_ID)
        .mockReturnValueOnce(OTHER_OPERATION_ID)
      const ledger = new GroupMemberModerationOperationLedger(operationIds)
      const operation = ledger.acquire({
        actorId: ACTOR_ID,
        action: 'unmute',
        groupId: GROUP_ID,
        targetUserId: TARGET_ID,
      })

      const result = await runGroupMemberModerationRequest({
        operation,
        ledger,
        accessToken: 'token',
        csrfHeaders: {},
        isViewerCurrent: () => true,
        fetcher: jest
          .fn()
          .mockResolvedValue(response({ error: 'determined' }, { ok: false, status })),
        onAcknowledged: jest.fn(),
        reconcileTarget: jest.fn(),
      })

      expect(result).toEqual({ ok: false, kind: 'http', error: 'determined' })
      expect(ledger.size).toBe(1)
      expect(
        ledger.acquire({
          actorId: ACTOR_ID,
          action: 'unmute',
          groupId: GROUP_ID,
          targetUserId: TARGET_ID,
        }).operationId
      ).toBe(OPERATION_ID)
    }
  )

  it('a response for a replaced stale operation only drives authoritative reconciliation', async () => {
    const operationIds = jest
      .fn()
      .mockReturnValueOnce(OPERATION_ID)
      .mockReturnValueOnce(OTHER_OPERATION_ID)
    const ledger = new GroupMemberModerationOperationLedger(operationIds)
    const staleMute = ledger.acquire({
      actorId: ACTOR_ID,
      action: 'mute',
      groupId: GROUP_ID,
      targetUserId: TARGET_ID,
      durationMs: 3_600_000,
      reason: 'old state',
      nowMs: NOW,
    })
    const currentUnmute = ledger.acquire({
      actorId: ACTOR_ID,
      action: 'unmute',
      groupId: GROUP_ID,
      targetUserId: TARGET_ID,
    })
    const onAcknowledged = jest.fn()
    const reconcileTarget = jest.fn().mockResolvedValue(undefined)

    const result = await runGroupMemberModerationRequest({
      operation: staleMute,
      ledger,
      accessToken: 'token',
      csrfHeaders: {},
      isViewerCurrent: () => true,
      fetcher: jest
        .fn()
        .mockResolvedValue(
          response({ success: true, operation_id: OPERATION_ID, already_muted: true })
        ),
      onAcknowledged,
      reconcileTarget,
    })

    expect(result).toEqual({ ok: true, completedCurrentIntent: false })
    expect(onAcknowledged).not.toHaveBeenCalled()
    expect(reconcileTarget).toHaveBeenCalledWith(TARGET_ID)
    expect(
      ledger.acquire({
        actorId: ACTOR_ID,
        action: 'unmute',
        groupId: GROUP_ID,
        targetUserId: TARGET_ID,
      })
    ).toBe(currentUnmute)
  })

  it('does not let a lost response for target A overwrite target B intent', async () => {
    const operationIds = jest
      .fn()
      .mockReturnValueOnce(OPERATION_ID)
      .mockReturnValueOnce(OTHER_OPERATION_ID)
    const ledger = new GroupMemberModerationOperationLedger(operationIds)
    const targetA = ledger.acquire({
      actorId: ACTOR_ID,
      action: 'unmute',
      groupId: GROUP_ID,
      targetUserId: TARGET_ID,
    })
    const targetB = ledger.acquire({
      actorId: ACTOR_ID,
      action: 'unmute',
      groupId: GROUP_ID,
      targetUserId: OTHER_TARGET_ID,
    })

    await runGroupMemberModerationRequest({
      operation: targetA,
      ledger,
      accessToken: 'token',
      csrfHeaders: {},
      isViewerCurrent: () => true,
      fetcher: jest.fn().mockRejectedValue(new Error('response lost')),
      onAcknowledged: jest.fn(),
      reconcileTarget: jest.fn(),
    })

    expect(ledger.size).toBe(2)
    expect(
      ledger.acquire({
        actorId: ACTOR_ID,
        action: 'unmute',
        groupId: GROUP_ID,
        targetUserId: TARGET_ID,
      })
    ).toBe(targetA)
    expect(
      ledger.acquire({
        actorId: ACTOR_ID,
        action: 'unmute',
        groupId: GROUP_ID,
        targetUserId: OTHER_TARGET_ID,
      })
    ).toBe(targetB)
  })

  it('retains the exact operation after a network failure', async () => {
    const ledger = new GroupMemberModerationOperationLedger(() => OPERATION_ID)
    const operation = ledger.acquire({
      actorId: ACTOR_ID,
      action: 'unmute',
      groupId: GROUP_ID,
      targetUserId: TARGET_ID,
    })

    const result = await runGroupMemberModerationRequest({
      operation,
      ledger,
      accessToken: 'token',
      csrfHeaders: {},
      isViewerCurrent: () => true,
      fetcher: jest.fn().mockRejectedValue(new Error('offline')),
      onAcknowledged: jest.fn(),
      reconcileTarget: jest.fn(),
    })

    expect(result).toEqual({ ok: false, kind: 'network', error: expect.any(Error) })
    expect(ledger.size).toBe(1)
  })

  it('keeps refresh failures silent after a committed acknowledgement', async () => {
    const ledger = new GroupMemberModerationOperationLedger(() => OPERATION_ID)
    const operation = ledger.acquire({
      actorId: ACTOR_ID,
      action: 'unmute',
      groupId: GROUP_ID,
      targetUserId: TARGET_ID,
    })
    const refreshError = new Error('read failed')
    const onReconcileError = jest.fn()

    const result = await runGroupMemberModerationRequest({
      operation,
      ledger,
      accessToken: 'token',
      csrfHeaders: {},
      isViewerCurrent: () => true,
      fetcher: jest
        .fn()
        .mockResolvedValue(
          response({ success: true, operation_id: OPERATION_ID, already_unmuted: true })
        ),
      onAcknowledged: jest.fn(),
      reconcileTarget: jest.fn().mockRejectedValue(refreshError),
      onReconcileError,
    })

    expect(result).toEqual({ ok: true, completedCurrentIntent: true })
    expect(onReconcileError).toHaveBeenCalledWith(refreshError)
    expect(ledger.size).toBe(0)
  })

  it('does not complete or acknowledge A when B replaces it during reconciliation', async () => {
    const operationIds = jest
      .fn()
      .mockReturnValueOnce(OPERATION_ID)
      .mockReturnValueOnce(OTHER_OPERATION_ID)
    const ledger = new GroupMemberModerationOperationLedger(operationIds)
    const staleMute = ledger.acquire({
      actorId: ACTOR_ID,
      action: 'mute',
      groupId: GROUP_ID,
      targetUserId: TARGET_ID,
      durationMs: 3_600_000,
      reason: 'A',
      nowMs: NOW,
    })
    let finishReconcile!: () => void
    const reconcileTarget = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishReconcile = resolve
        })
    )
    const onAcknowledged = jest.fn()
    const pending = runGroupMemberModerationRequest({
      operation: staleMute,
      ledger,
      accessToken: 'token',
      csrfHeaders: {},
      isViewerCurrent: () => true,
      fetcher: jest.fn().mockResolvedValue(response({ success: true, operation_id: OPERATION_ID })),
      reconcileTarget,
      onAcknowledged,
    })
    await Promise.resolve()
    await Promise.resolve()
    const currentUnmute = ledger.acquire({
      actorId: ACTOR_ID,
      action: 'unmute',
      groupId: GROUP_ID,
      targetUserId: TARGET_ID,
    })
    finishReconcile()

    await expect(pending).resolves.toEqual({ ok: true, completedCurrentIntent: false })
    expect(onAcknowledged).not.toHaveBeenCalled()
    expect(ledger.isCurrent(currentUnmute)).toBe(true)
  })

  it('skips reconciliation and completion when the viewer changes before ACK handling', async () => {
    const ledger = new GroupMemberModerationOperationLedger(() => OPERATION_ID)
    const operation = ledger.acquire({
      actorId: ACTOR_ID,
      action: 'unmute',
      groupId: GROUP_ID,
      targetUserId: TARGET_ID,
    })
    const reconcileTarget = jest.fn()
    const onAcknowledged = jest.fn()

    const result = await runGroupMemberModerationRequest({
      operation,
      ledger,
      accessToken: 'token',
      csrfHeaders: {},
      isViewerCurrent: () => false,
      fetcher: jest.fn().mockResolvedValue(response({ success: true, operation_id: OPERATION_ID })),
      reconcileTarget,
      onAcknowledged,
    })

    expect(result).toEqual({ ok: true, completedCurrentIntent: false })
    expect(reconcileTarget).not.toHaveBeenCalled()
    expect(onAcknowledged).not.toHaveBeenCalled()
    expect(ledger.isCurrent(operation)).toBe(true)
  })
})

describe('group member moderation viewer guard', () => {
  afterEach(() => __resetViewerScopeForTests())

  it('accepts same-user token refresh and rejects transition-before-render plus A-to-A', () => {
    __resetViewerScopeForTests()
    const current = synchronizeViewerScope(true, ACTOR_ID)
    const rendered = {
      actorId: ACTOR_ID,
      viewerKey: current.viewerKey,
      sessionGeneration: current.sessionGeneration,
      groupId: GROUP_ID,
      resourceGeneration: 1,
    }

    expect(isGroupMemberModerationViewerCurrent(rendered, rendered, accessTokenFor(ACTOR_ID))).toBe(
      true
    )
    expect(
      isGroupMemberModerationViewerCurrent(rendered, rendered, accessTokenFor(OTHER_ACTOR_ID))
    ).toBe(false)

    const transitionGeneration = beginViewerTransition(ACTOR_ID)
    expect(isGroupMemberModerationViewerCurrent(rendered, rendered, accessTokenFor(ACTOR_ID))).toBe(
      false
    )

    expect(commitViewerTransition(transitionGeneration, ACTOR_ID)).not.toBeNull()
    expect(isGroupMemberModerationViewerCurrent(rendered, rendered, accessTokenFor(ACTOR_ID))).toBe(
      false
    )
  })

  it('increments the resource generation across G1 to G2 to G1 transitions', () => {
    const empty = { groupId: null, resourceGeneration: 0 }
    const groupOne = advanceGroupMemberModerationResourceScope(empty, GROUP_ID.toUpperCase())
    const sameGroup = advanceGroupMemberModerationResourceScope(groupOne, GROUP_ID)
    const groupTwo = advanceGroupMemberModerationResourceScope(groupOne, OTHER_GROUP_ID)
    const groupOneAgain = advanceGroupMemberModerationResourceScope(groupTwo, GROUP_ID)

    expect(groupOne).toEqual({ groupId: GROUP_ID, resourceGeneration: 1 })
    expect(sameGroup).toBe(groupOne)
    expect(groupTwo).toEqual({ groupId: OTHER_GROUP_ID, resourceGeneration: 2 })
    expect(groupOneAgain).toEqual({ groupId: GROUP_ID, resourceGeneration: 3 })
  })

  it('drops a G1 late ACK after same-viewer navigation to G2', async () => {
    __resetViewerScopeForTests()
    const identity = synchronizeViewerScope(true, ACTOR_ID)
    const groupOneScope = {
      actorId: ACTOR_ID,
      viewerKey: identity.viewerKey,
      sessionGeneration: identity.sessionGeneration,
      groupId: GROUP_ID,
      resourceGeneration: 1,
    }
    let renderedScope = groupOneScope
    const ledger = new GroupMemberModerationOperationLedger(() => OPERATION_ID)
    const operation = ledger.acquire({
      actorId: ACTOR_ID,
      viewerKey: identity.viewerKey,
      sessionGeneration: identity.sessionGeneration,
      resourceGeneration: groupOneScope.resourceGeneration,
      action: 'unmute',
      groupId: GROUP_ID,
      targetUserId: TARGET_ID,
    })
    let resolveAck!: (value: ReturnType<typeof response>) => void
    const fetcher = jest.fn(
      () =>
        new Promise<ReturnType<typeof response>>((resolve) => {
          resolveAck = resolve
        })
    )
    const reconcileTarget = jest.fn()
    const onAcknowledged = jest.fn()
    const pending = runGroupMemberModerationRequest({
      operation,
      ledger,
      accessToken: accessTokenFor(ACTOR_ID),
      csrfHeaders: {},
      fetcher,
      isViewerCurrent: () =>
        isGroupMemberModerationViewerCurrent(
          groupOneScope,
          renderedScope,
          accessTokenFor(ACTOR_ID)
        ),
      reconcileTarget,
      onAcknowledged,
    })
    await Promise.resolve()

    renderedScope = {
      ...groupOneScope,
      groupId: OTHER_GROUP_ID,
      resourceGeneration: 2,
    }
    ledger.scope(renderedScope)
    resolveAck(response({ success: true, operation_id: OPERATION_ID }))

    await expect(pending).resolves.toEqual({ ok: true, completedCurrentIntent: false })
    expect(reconcileTarget).not.toHaveBeenCalled()
    expect(onAcknowledged).not.toHaveBeenCalled()
    expect(ledger.isCurrent(operation)).toBe(false)
    expect(ledger.size).toBe(0)
  })
})

describe('group management integration', () => {
  it('scopes at render time, single-flights by operation and never optimistically rewrites mute state', () => {
    const page = readFileSync(join(process.cwd(), 'app/(app)/groups/[id]/manage/page.tsx'), 'utf8')
    expect(page).toContain('moderationViewerScopeRef.current = moderationViewerScope')
    expect(page).toContain('moderationOperationsRef.current.scope(moderationViewerScope)')
    expect(page).toContain('advanceGroupMemberModerationResourceScope(')
    expect(page).toContain('resourceGeneration: requestScope.resourceGeneration')
    expect(page).toContain('requestScope.groupId !== requestGroupId')
    expect(page).toContain('isGroupMemberModerationViewerCurrent(')
    expect(page).toContain('moderationAccessTokenRef.current')
    expect(page).toContain('moderationRequestsRef.current.run(requestedOperation.operationId')
    expect(page).toContain('if (!request.started) return')
    expect(page).toContain('result.completedCurrentIntent &&')
    expect(page).toContain('isModerationViewerScopeCurrent(requestScope)')
    expect(page).toContain('moderationOperationsRef.current.isCurrent(operation)')
    const moderationHandlers = page.match(/const handleMute =[\s\S]*?const handleNotify =/)?.[0]
    expect(moderationHandlers).toBeDefined()
    expect(moderationHandlers).not.toContain('setMembers(')
    expect(moderationHandlers).not.toContain('finally')
    expect(moderationHandlers).toContain(
      '(!operation || moderationOperationsRef.current.isCurrent(operation))'
    )
    expect(moderationHandlers).toContain(
      'reconcileTarget: (target) => reconcileMemberModeration(target, requestScope)'
    )
  })
})

describe('strict moderation acknowledgement parser', () => {
  it.each([
    ['mute first application', 'mute', { success: true, operation_id: OPERATION_ID }, true],
    [
      'mute replay',
      'mute',
      { success: true, operation_id: OPERATION_ID, already_muted: true },
      true,
    ],
    [
      'unmute replay',
      'unmute',
      { success: true, operation_id: OPERATION_ID, already_unmuted: true },
      true,
    ],
    ['wrong id', 'mute', { success: true, operation_id: OTHER_OPERATION_ID }, false],
    [
      'wrong replay key',
      'mute',
      { success: true, operation_id: OPERATION_ID, already_unmuted: true },
      false,
    ],
    [
      'false replay flag',
      'unmute',
      { success: true, operation_id: OPERATION_ID, already_unmuted: false },
      false,
    ],
  ])('%s', (_label, action, value, expected) => {
    expect(
      isExactGroupMemberModerationAcknowledgement(action as 'mute' | 'unmute', OPERATION_ID, value)
    ).toBe(expected)
  })
})
