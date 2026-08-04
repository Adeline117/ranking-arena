import { z } from 'zod'

export const UNIFIED_SEARCH_REQUEST_TIMEOUT_MS = 15_000

const SearchResultSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(['trader', 'post', 'user', 'group']),
    title: z.string().min(1),
    subtitle: z.string().optional(),
    href: z.string().startsWith('/'),
    avatar: z.string().nullable().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const UnifiedSearchResponseSchema = z
  .object({
    query: z.string(),
    results: z
      .object({
        traders: z.array(SearchResultSchema),
        posts: z.array(SearchResultSchema),
        users: z.array(SearchResultSchema),
        groups: z.array(SearchResultSchema),
      })
      .strict(),
    total: z.number().int().nonnegative(),
    suggestions: z.array(z.string()).optional(),
    matchedExchange: z.string().min(1).optional(),
    facetDistribution: z
      .record(z.string(), z.record(z.string(), z.number().finite().nonnegative()))
      .optional(),
    degraded: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const sections = [
      ['traders', 'trader'],
      ['posts', 'post'],
      ['users', 'user'],
      ['groups', 'group'],
    ] as const
    let actualTotal = 0
    for (const [section, expectedType] of sections) {
      actualTotal += value.results[section].length
      value.results[section].forEach((result, index) => {
        if (result.type !== expectedType) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${section} result has the wrong type`,
            path: ['results', section, index, 'type'],
          })
        }
      })
    }
    if (value.total !== actualTotal) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'search total does not match the returned results',
        path: ['total'],
      })
    }
  })

const UnifiedSearchEnvelopeSchema = z
  .object({
    success: z.literal(true),
    data: UnifiedSearchResponseSchema,
    meta: z.object({ timestamp: z.string().datetime() }).strict(),
  })
  .strict()

export type UnifiedSearchResponse = z.infer<typeof UnifiedSearchResponseSchema>

function expectedResponseQuery(query: string): string {
  return query.trim().replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function readUnifiedSearchResponse(
  value: unknown,
  expectedQuery: string
): UnifiedSearchResponse | null {
  const parsed = UnifiedSearchEnvelopeSchema.safeParse(value)
  if (!parsed.success || parsed.data.data.query !== expectedResponseQuery(expectedQuery))
    return null
  return parsed.data.data
}

/**
 * Fetch and consume the full search response under one physical deadline.
 * Racing both fetch and JSON parsing prevents implementations that ignore an
 * AbortSignal from leaving React Query in an endless initial-loading state.
 */
export async function fetchUnifiedSearch(
  url: string,
  expectedQuery: string,
  callerSignal?: AbortSignal
): Promise<UnifiedSearchResponse> {
  const controller = new AbortController()
  let rejectInterruption: ((reason: Error) => void) | undefined
  const interruption = new Promise<never>((_resolve, reject) => {
    rejectInterruption = reject
  })
  const interrupt = (reason: Error) => {
    if (!controller.signal.aborted) controller.abort(reason)
    rejectInterruption?.(reason)
  }
  const onCallerAbort = () => interrupt(new Error('Search request cancelled'))
  if (callerSignal?.aborted) onCallerAbort()
  else callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
  const timeout = setTimeout(
    () => interrupt(new Error('Search request timed out')),
    UNIFIED_SEARCH_REQUEST_TIMEOUT_MS
  )

  try {
    const response = await Promise.race([
      fetch(url, { cache: 'no-store', signal: controller.signal }),
      interruption,
    ])
    if (!response.ok || response.status !== 200) throw new Error(`HTTP ${response.status}`)
    const body: unknown = await Promise.race([response.json(), interruption])
    const parsed = readUnifiedSearchResponse(body, expectedQuery)
    if (!parsed) throw new Error('Search returned an invalid response')
    return parsed
  } finally {
    clearTimeout(timeout)
    callerSignal?.removeEventListener('abort', onCallerAbort)
  }
}
