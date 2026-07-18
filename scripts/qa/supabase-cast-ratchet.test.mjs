import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RUNTIME_BASELINES,
  evaluateRuntimeCounts,
  isTestFile,
  scanSupabaseCasts,
  summarizeScans,
} from './supabase-cast-ratchet.mjs'

function countsFor(source, file = 'app/api/example/route.ts') {
  return summarizeScans([scanSupabaseCasts(source, file)])
}

test('detects bare SupabaseClient casts but accepts generated-schema generics', () => {
  const summary = countsFor(`
    const untyped = admin as SupabaseClient
    const typed = admin as SupabaseClient<Database>
    const spaced = admin as SupabaseClient < Database >
    const qualified = admin as Supabase.SupabaseClient
    const text = "admin as SupabaseClient"
    // admin as SupabaseClient
  `)

  assert.equal(summary.runtime.counts.bareSupabaseClient, 2)
  assert.deepEqual(
    summary.runtime.hits.map((hit) => hit.text),
    ['admin as SupabaseClient', 'admin as Supabase.SupabaseClient']
  )
})

test('detects multiline receivers, query arguments, and whole-query any casts', () => {
  const summary = countsFor(`
    const rows = (readDb as any)
      .from('leaderboard_ranks')
      .select('*')
    await supabase.from('items').insert((payload as any))
    const query = (supabase
      .from('items')
      .select('*') as any)
    const unrelatedRequest = request as any
    sendToR2(client as any)
  `)

  assert.equal(summary.runtime.counts.dbAny, 3)
  assert.equal(summary.runtime.counts.bareSupabaseClient, 0)
})

test('counts each RPC name and args never cast node, including parenthesized multiline args', () => {
  const summary = countsFor(`
    supabase.rpc('one' as never, { value: 1 } as never)
    supabase.rpc(
      ('two' as never),
      ({ value: 2 } as never)
    )
    supabase.rpc('typed', { value: 3 })
    consume(value as never)
  `)

  assert.equal(summary.runtime.counts.rpcNever, 4)
  assert.equal(summary.runtime.hits.filter((hit) => hit.category === 'rpcNever').length, 4)
})

test('separates test fixtures from runtime budgets', () => {
  const castSource = `
    const client = mock as SupabaseClient
    ;(client as any).from('rows').select('*')
    client.rpc('fn' as never, {} as never)
  `
  const summary = summarizeScans([
    scanSupabaseCasts(castSource, 'app/api/example/route.ts'),
    scanSupabaseCasts(castSource, 'app/api/example/__tests__/route.test.ts'),
  ])

  assert.deepEqual(summary.runtime.counts, {
    bareSupabaseClient: 1,
    dbAny: 1,
    rpcNever: 2,
  })
  assert.deepEqual(summary.test.counts, summary.runtime.counts)
  assert.equal(isTestFile('lib/data/posts.test.ts'), true)
  assert.equal(isTestFile('app/api/example/__tests__/route.ts'), true)
  assert.equal(isTestFile('app/api/example/route.ts'), false)
})

test('independent category baselines cannot offset a regression', () => {
  const evaluation = evaluateRuntimeCounts(
    {
      bareSupabaseClient: RUNTIME_BASELINES.bareSupabaseClient - 10,
      dbAny: RUNTIME_BASELINES.dbAny + 1,
      rpcNever: RUNTIME_BASELINES.rpcNever,
    },
    RUNTIME_BASELINES
  )

  assert.equal(evaluation.ok, false)
  assert.deepEqual(
    evaluation.failures.map(({ category }) => category),
    ['dbAny']
  )
  assert.deepEqual(
    evaluation.improvements.map(({ category }) => category),
    ['bareSupabaseClient']
  )
})

test('fails closed when TypeScript source cannot be parsed', () => {
  assert.throws(
    () => scanSupabaseCasts('const value =', 'app/api/broken/route.ts'),
    /Unable to parse app\/api\/broken\/route\.ts/
  )
})
