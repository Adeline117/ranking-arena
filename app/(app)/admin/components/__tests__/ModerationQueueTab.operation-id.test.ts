import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const componentSource = readFileSync(
  join(process.cwd(), 'app/(app)/admin/components/ModerationQueueTab.tsx'),
  'utf8'
)
const routeSource = readFileSync(
  join(process.cwd(), 'app/api/admin/moderation-queue/route.ts'),
  'utf8'
)

describe('moderation queue operation-ID lifecycle contract', () => {
  it('creates/replaces an intent operation inside the caught boundary and sends no client authority', () => {
    const actionTry = componentSource.indexOf(
      'try {',
      componentSource.indexOf('const handleAction')
    )
    const randomUuid = componentSource.indexOf('crypto.randomUUID()', actionTry)
    const operationMapWrite = componentSource.indexOf(
      'operationByTarget.current.set(key, { action, operationId })',
      actionTry
    )

    expect(actionTry).toBeGreaterThan(-1)
    expect(randomUuid).toBeGreaterThan(actionTry)
    expect(operationMapWrite).toBeGreaterThan(randomUuid)
    expect(componentSource).toContain(
      'existingOperation?.action === action ? existingOperation.operationId : crypto.randomUUID()'
    )
    expect(componentSource).toContain('operation_id: operationId')
    expect(componentSource).toContain('content_id: canonicalContentId')
    expect(componentSource).toContain('contentId: canonicalContentId')
    expect(componentSource).not.toContain('author_id: authorId')
  })

  it('retains uncertainty until an HTTP body parses, including a malformed 200 acknowledgement', () => {
    const fetchCall = componentSource.indexOf("await fetch('/api/admin/moderation-queue'")
    const parseBody = componentSource.indexOf('const data = await res.json()', fetchCall)
    const deterministicClear = componentSource.indexOf(
      'clearOperation = res.status < 500',
      fetchCall
    )
    const boundValidator = componentSource.indexOf(
      '!isBoundModerationAcknowledgement(data, {',
      parseBody
    )
    const successClear = componentSource.indexOf('clearOperation = true', boundValidator)
    const caughtBoundary = componentSource.indexOf('} catch (err) {', parseBody)
    const conditionalDelete = componentSource.indexOf('clearOperation &&', caughtBoundary)

    expect(fetchCall).toBeGreaterThan(-1)
    expect(parseBody).toBeGreaterThan(fetchCall)
    expect(deterministicClear).toBeGreaterThan(parseBody)
    expect(boundValidator).toBeGreaterThan(deterministicClear)
    expect(successClear).toBeGreaterThan(boundValidator)
    expect(caughtBoundary).toBeGreaterThan(successClear)
    expect(conditionalDelete).toBeGreaterThan(caughtBoundary)
    expect(componentSource.match(/clearOperation = res\.status < 500/g)).toHaveLength(1)
    expect(componentSource.match(/clearOperation = true/g)).toHaveLength(1)
    expect(componentSource).toContain('result.result_operation_id !== expected.operationId')
  })

  it('requires an exact four-key request and binds the ACK to operation_id', () => {
    expect(routeSource).toContain(
      "const MODERATION_REQUEST_KEYS = ['action', 'content_id', 'content_type', 'operation_id']"
    )
    expect(routeSource).toContain('requestKeys.length !== MODERATION_REQUEST_KEYS.length')
    expect(routeSource).toContain('candidate.result_operation_id !== expected.operationId')
    expect(routeSource).toContain('p_operation_id: expected.operationId')
  })

  it('silently reconciles the queue after every successful acknowledgement', () => {
    expect(componentSource).toContain(
      'async (pageNum: number = 1, options: { silent?: boolean } = {})'
    )
    expect(componentSource).toContain('if (!silent) setLoading(true)')
    expect(componentSource).toContain('if (!silent) setLoading(false)')
    expect(componentSource).toContain('await loadQueue(page, { silent: true })')
  })

  it('drops actor-bound operation IDs only when the access token changes', () => {
    expect(componentSource).toContain(
      'useEffect(() => {\n    operationByTarget.current.clear()\n  }, [accessToken])'
    )
  })
})
