/**
 * Test double for the two reads countPublicRankedTradersBySource makes: the
 * served-source RPC and exact head counts over the public ranked view.
 */

export interface FakePublicRankedCounts {
  /** Sources arena_visible_sources reports as served. */
  served: string[]
  /** Non-idle ranked traders per source, as the view would count them. */
  nonIdleBySource: Record<string, number>
  /** Season total; defaults to the sum of nonIdleBySource. */
  total?: number
  rpcError?: boolean
  /**
   * Publication record time per arena_visible_sources call (first, second,
   * ...). Different values model a publication switch while counting.
   */
  recordedAtByCall?: string[]
  /** Sources whose count request fails; 'total' fails the season count. */
  failCountFor?: string[]
}

export function fakePublicRankedCountClient(state: FakePublicRankedCounts) {
  const filters: Array<Record<string, unknown>> = []
  const relations: string[] = []
  const selects: unknown[][] = []

  const from = (relation: string) => {
    relations.push(relation)
    const applied: Record<string, unknown> = {}
    filters.push(applied)
    const builder = {
      select: (...args: unknown[]) => {
        selects.push(args)
        return builder
      },
      eq: (column: string, value: unknown) => {
        applied[column] = value
        return builder
      },
      not: (column: string, operator: string, value: unknown) => {
        applied[`not:${column}:${operator}`] = value
        return builder
      },
      then: (
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown
      ): Promise<unknown> => {
        const source = typeof applied.source === 'string' ? applied.source : 'total'
        const failed = state.failCountFor?.includes(source) ?? false
        const sum = Object.values(state.nonIdleBySource).reduce((a, b) => a + b, 0)
        const count =
          source === 'total' ? (state.total ?? sum) : (state.nonIdleBySource[source] ?? 0)
        return Promise.resolve(
          failed
            ? { data: null, count: null, error: { message: 'count failed' } }
            : { data: null, count, error: null }
        ).then(resolve, reject)
      },
    }
    return builder
  }

  const rpcCalls: Array<[string, unknown]> = []
  const rpc = async (name: string, args: unknown) => {
    rpcCalls.push([name, args])
    if (name !== 'arena_visible_sources') throw new Error(`Unexpected rpc ${name}`)
    return state.rpcError
      ? { data: null, error: { message: 'rpc failed' } }
      : {
          data: state.served.map((source) => ({
            filter_source: source,
            trader_count: 0,
            cache_updated_at:
              state.recordedAtByCall?.[rpcCalls.length - 1] ?? '2026-11-27T00:00:00Z',
          })),
          error: null,
        }
  }

  return { client: { from, rpc }, from, rpc, rpcCalls, filters, relations, selects }
}
