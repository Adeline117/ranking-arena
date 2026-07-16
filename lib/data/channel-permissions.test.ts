import type { SupabaseClient } from '@supabase/supabase-js'
import {
  ChannelPermissionReadError,
  filterChannelAddableUsers,
  MAX_CHANNEL_ADD_CANDIDATES,
} from './channel-permissions'

type QueryResult = { data: unknown; error: unknown }

function queryResult(result: QueryResult | Error) {
  const calls = {
    select: [] as string[],
    eq: [] as Array<[string, unknown]>,
    in: [] as Array<[string, readonly unknown[]]>,
  }
  const query = {
    select(selection: string) {
      calls.select.push(selection)
      return query
    },
    eq(column: string, value: unknown) {
      calls.eq.push([column, value])
      return query
    },
    in(column: string, values: readonly unknown[]) {
      calls.in.push([column, [...values]])
      return query
    },
    then(resolve: (value: QueryResult) => unknown, reject: (error: unknown) => unknown) {
      return (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)).then(
        resolve,
        reject
      )
    },
  }
  return { query, calls }
}

function fakeClient(results: Array<QueryResult | Error>) {
  const queries = results.map(queryResult)
  const tables: string[] = []
  let index = 0
  const client = {
    from(table: string) {
      tables.push(table)
      const next = queries[index++]
      if (!next) throw new Error('Unexpected query')
      return next.query
    },
  } as unknown as SupabaseClient
  return { client, queries, tables }
}

const actor = '11111111-1111-4111-8111-111111111111'
const all = '22222222-2222-4222-8222-222222222222'
const none = '33333333-3333-4333-8333-333333333333'
const mutual = '44444444-4444-4444-8444-444444444444'
const oneWay = '55555555-5555-4555-8555-555555555555'
const actorBlocked = '66666666-6666-4666-8666-666666666666'
const blockedActor = '77777777-7777-4777-8777-777777777777'
const missing = '88888888-8888-4888-8888-888888888888'

describe('filterChannelAddableUsers', () => {
  it('honors blocks and all/mutual/none preferences without raw filter interpolation', async () => {
    const { client, queries, tables } = fakeClient([
      {
        data: [{ blocker_id: actor, blocked_id: actorBlocked }],
        error: null,
      },
      {
        data: [{ blocker_id: blockedActor, blocked_id: actor }],
        error: null,
      },
      {
        data: [
          { id: all, dm_permission: 'all' },
          { id: none, dm_permission: 'none' },
          { id: mutual, dm_permission: 'mutual' },
          { id: oneWay, dm_permission: 'mutual' },
        ],
        error: null,
      },
      {
        data: [
          { follower_id: actor, following_id: mutual },
          { follower_id: actor, following_id: oneWay },
        ],
        error: null,
      },
      {
        data: [{ follower_id: mutual, following_id: actor }],
        error: null,
      },
    ])

    await expect(
      filterChannelAddableUsers(client, actor.toUpperCase(), [
        missing,
        blockedActor,
        actorBlocked,
        oneWay,
        mutual,
        none,
        all.toUpperCase(),
        all,
        actor,
      ])
    ).resolves.toEqual({
      allowed: [mutual, all],
      blocked: [missing, blockedActor, actorBlocked, oneWay, none],
    })

    expect(tables).toEqual([
      'blocked_users',
      'blocked_users',
      'user_profiles',
      'user_follows',
      'user_follows',
    ])
    expect(queries[0].calls.eq).toEqual([['blocker_id', actor]])
    expect(queries[0].calls.in[0][0]).toBe('blocked_id')
    expect(queries[1].calls.eq).toEqual([['blocked_id', actor]])
    expect(queries[1].calls.in[0][0]).toBe('blocker_id')
  })

  it.each([
    [
      [
        { data: null, error: { code: 'XX001' } },
        { data: [], error: null },
      ],
      [all],
    ],
    [
      [
        { data: [], error: null },
        { data: [], error: null },
        { data: null, error: { code: '42501' } },
      ],
      [all],
    ],
    [
      [
        { data: [], error: null },
        { data: [], error: null },
        { data: [{ id: mutual, dm_permission: 'mutual' }], error: null },
        new Error('follow lookup failed'),
        { data: [], error: null },
      ],
      [mutual],
    ],
  ])('fails closed when a required privacy query fails %#', async (results, candidates) => {
    const { client } = fakeClient(results as Array<QueryResult | Error>)

    await expect(filterChannelAddableUsers(client, actor, candidates)).rejects.toBeInstanceOf(
      ChannelPermissionReadError
    )
  })

  it('rejects malformed inputs before issuing a database query', async () => {
    const { client, tables } = fakeClient([])

    await expect(filterChannelAddableUsers(client, 'not-a-uuid', [all])).rejects.toBeInstanceOf(
      ChannelPermissionReadError
    )
    await expect(filterChannelAddableUsers(client, actor, ['not-a-uuid'])).rejects.toBeInstanceOf(
      ChannelPermissionReadError
    )
    await expect(
      filterChannelAddableUsers(
        client,
        actor,
        Array.from(
          { length: MAX_CHANNEL_ADD_CANDIDATES + 1 },
          (_, index) => `${(index + 1).toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`
        )
      )
    ).rejects.toBeInstanceOf(ChannelPermissionReadError)
    await expect(
      filterChannelAddableUsers(client, actor, 'not-an-array' as unknown as string[])
    ).rejects.toBeInstanceOf(ChannelPermissionReadError)
    expect(tables).toEqual([])
  })

  it.each([
    [
      [
        { data: [{ blocker_id: actor, blocked_id: missing }], error: null },
        { data: [], error: null },
      ],
      [all],
    ],
    [
      [
        { data: [], error: null },
        { data: [], error: null },
        { data: [{ id: all, dm_permission: 'future-mode' }], error: null },
      ],
      [all],
    ],
    [
      [
        { data: [], error: null },
        { data: [], error: null },
        {
          data: [
            { id: all, dm_permission: 'all' },
            { id: all, dm_permission: 'all' },
          ],
          error: null,
        },
      ],
      [all],
    ],
  ])('rejects malformed or out-of-scope database rows %#', async (results, candidates) => {
    const { client } = fakeClient(results as Array<QueryResult | Error>)

    await expect(filterChannelAddableUsers(client, actor, candidates)).rejects.toBeInstanceOf(
      ChannelPermissionReadError
    )
  })
})
