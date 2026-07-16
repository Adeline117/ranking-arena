import type { SupabaseClient } from '@supabase/supabase-js'
import { getPosts } from '../posts'

type QueryResult = { data: unknown; error: Error | null }

function query(result: QueryResult) {
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'order', 'range', 'neq', 'is', 'eq', 'in', 'not', 'or']) {
    builder[method] = jest.fn(() => builder)
  }
  builder.then = (
    resolve: (value: QueryResult) => unknown,
    reject?: (reason: unknown) => unknown
  ) => Promise.resolve(result).then(resolve, reject)
  return builder
}

describe('getPosts service-role fail-closed boundary', () => {
  it.each([
    ['group_ids', { group_ids: [] }],
    ['author_ids', { author_ids: [] }],
    ['post_ids', { post_ids: [] }],
  ])('treats an explicit empty %s scope as terminal empty', async (_label, options) => {
    const from = jest.fn()

    await expect(getPosts({ from } as unknown as SupabaseClient, options)).resolves.toEqual([])
    expect(from).not.toHaveBeenCalled()
  })

  it('always constrains list candidates to non-deleted rows', async () => {
    const postsQuery = query({ data: [], error: null })
    const client = {
      from: jest.fn((table: string) => {
        if (table !== 'posts') throw new Error(`unexpected table ${table}`)
        return postsQuery
      }),
    } as unknown as SupabaseClient

    await expect(getPosts(client)).resolves.toEqual([])
    expect(postsQuery.neq).toHaveBeenCalledWith('status', 'deleted')
    expect(postsQuery.is).toHaveBeenCalledWith('deleted_at', null)
  })

  it('propagates block lookup failure before serving viewer rows', async () => {
    const accessError = new Error('blocked_users unavailable')
    const postsQuery = query({ data: [], error: null })
    const blockQuery = query({ data: null, error: accessError })
    ;(blockQuery.or as jest.Mock).mockReturnValue(blockQuery)
    const client = {
      from: jest.fn((table: string) => {
        if (table === 'posts') return postsQuery
        if (table === 'blocked_users') return blockQuery
        throw new Error(`unexpected table ${table}`)
      }),
    } as unknown as SupabaseClient

    await expect(getPosts(client, { viewer_id: 'viewer-1' })).rejects.toThrow(accessError)
  })
})
