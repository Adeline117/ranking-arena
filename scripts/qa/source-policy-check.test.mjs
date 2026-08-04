import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateSource } from './source-policy-check.mjs'

function rules(path, source) {
  return evaluateSource(path, source).map((violation) => violation.rule)
}

test('rejects direct modal scroll locking outside tests', () => {
  const source = "document.body.style.overflow = 'hidden'"
  assert.deepEqual(rules('app/components/UnsafeModal.tsx', source), ['modal-scroll-lock'])
  assert.deepEqual(rules('app/components/UnsafeModal.test.tsx', source), [])
})

test('keeps specialized wallet connectors and peers outside runtime source', () => {
  assert.deepEqual(
    rules('lib/web3/unsafe-safe.ts', "import { injected, safe } from 'wagmi/connectors'"),
    ['specialized-wallet-connector-boundary']
  )
  assert.deepEqual(
    rules('lib/web3/unsafe-peer.ts', "import { createSDK } from '@safe-global/safe-apps-sdk'"),
    ['specialized-wallet-peer-boundary']
  )
  assert.deepEqual(
    rules('lib/web3/unsafe-namespace.ts', "import * as connectors from 'wagmi/connectors'"),
    ['opaque-wallet-connector-boundary']
  )
  assert.deepEqual(
    rules(
      'lib/web3/wallet-factories.ts',
      "import { injected, walletConnect } from 'wagmi/connectors'"
    ),
    []
  )
  assert.deepEqual(
    rules(
      'lib/web3/__tests__/connector.test.ts',
      "import { safe } from 'wagmi/connectors'; import '@base-org/account'"
    ),
    []
  )
})

test('rejects multiline notification inserts in non-cron API routes', () => {
  const source = "supabase.from('notifications')\n  .insert({ user_id: id })"
  assert.deepEqual(rules('app/api/social/route.ts', source), ['notification-writer-boundary'])
  assert.deepEqual(rules('app/api/cron/broadcast/route.ts', source), [])
  assert.deepEqual(
    rules(
      'app/api/internal-batch/route.ts',
      `// source-policy-exempt: notification-batch\n${source}`
    ),
    []
  )
})

test('requires the shared counter service unless a named non-counter RPC is exempt', () => {
  const source = "await supabase.rpc('increment_post_count', { post_id: id })"
  assert.deepEqual(rules('app/api/posts/route.ts', source), ['counter-service-boundary'])
  assert.deepEqual(
    rules('app/api/metering/route.ts', `// source-policy-exempt: counter-rpc\n${source}`),
    []
  )
})

test('requires Stripe idempotency and escaped interpolated ilike input', () => {
  assert.deepEqual(
    rules('app/api/billing/route.ts', 'stripe.checkout.sessions.create({ line_items: [] })'),
    ['stripe-idempotency']
  )
  assert.deepEqual(
    rules(
      'app/api/billing/route.ts',
      'stripe.checkout.sessions.create({ line_items: [] }, { idempotencyKey })'
    ),
    []
  )
  assert.deepEqual(rules('app/api/search/route.ts', 'query.ilike("name", `%${input}%`)'), [
    'ilike-escaping',
  ])
  assert.deepEqual(
    rules(
      'app/api/search/route.ts',
      'const safe = escapeLikePattern(input); query.ilike("name", `%${safe}%`)'
    ),
    []
  )
})

test('requires the checked-out ingest client wrapper in runtime code', () => {
  const source = 'const client = await getIngestPool().connect()'
  assert.deepEqual(rules('worker/src/ingest/unsafe.ts', source), ['ingest-pool-checkout'])
  assert.deepEqual(rules('lib/ingest/db.ts', source), [])
  assert.deepEqual(rules('lib/ingest/__tests__/unsafe.test.ts', source), [])
  assert.deepEqual(rules('lib/ingest/serving/__integration__/test-db.ts', source), [])
})
