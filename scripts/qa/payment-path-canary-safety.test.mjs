import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { parse } from 'yaml'

import {
  TARGET_ATTESTATION,
  WRITE_ATTESTATION,
  runPaymentPathCanary,
  validatePaymentCanaryEnvironment,
} from '../openclaw/payment-path-canary.mjs'

const UUID_VALUE_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i

const disposableEnvironment = {
  PAYMENT_CANARY_STAGING_DATABASE_URL:
    'postgresql://postgres@db.abcdefghijklmnopqrst.supabase.co/postgres',
  PAYMENT_CANARY_STAGING_PROJECT_REF: 'abcdefghijklmnopqrst',
  PAYMENT_CANARY_TARGET_ATTESTATION: TARGET_ATTESTATION,
  PAYMENT_CANARY_DISPOSABLE_USER_ID: '11111111-1111-4111-8111-111111111111',
  PAYMENT_CANARY_DISPOSABLE_HANDLE: 'payment_canary_disposable_ci',
  PAYMENT_CANARY_WRITE_ATTESTATION: WRITE_ATTESTATION,
}

test('payment canary blocks before constructing a database client without a disposable fixture', async () => {
  let clientConstructions = 0
  const result = await runPaymentPathCanary({
    env: { DATABASE_URL: 'postgresql://legacy.invalid/arena' },
    clientFactory() {
      clientConstructions += 1
      throw new Error('must not construct a client')
    },
  })

  assert.equal(result.exitCode, 2)
  assert.equal(result.status, 'blocked')
  assert.equal(clientConstructions, 0)
})

test('payment canary requires both a marked handle and exact rollback attestation', () => {
  assert.equal(validatePaymentCanaryEnvironment(disposableEnvironment).ok, true)
  assert.equal(
    validatePaymentCanaryEnvironment({
      ...disposableEnvironment,
      PAYMENT_CANARY_DISPOSABLE_HANDLE: 'qa_button_test',
    }).ok,
    false
  )
  assert.equal(
    validatePaymentCanaryEnvironment({
      ...disposableEnvironment,
      PAYMENT_CANARY_WRITE_ATTESTATION: 'yes',
    }).ok,
    false
  )
})

test('payment canary is bound to one explicitly attested non-production Supabase project', () => {
  assert.equal(
    validatePaymentCanaryEnvironment({
      ...disposableEnvironment,
      PAYMENT_CANARY_STAGING_DATABASE_URL:
        'postgresql://postgres@db.iknktzifjdyujdccyhsv.supabase.co/postgres',
      PAYMENT_CANARY_STAGING_PROJECT_REF: 'iknktzifjdyujdccyhsv',
    }).ok,
    false
  )
  assert.equal(
    validatePaymentCanaryEnvironment({
      ...disposableEnvironment,
      PAYMENT_CANARY_STAGING_DATABASE_URL:
        'postgresql://postgres@db.zyxwvutsrqponmlkjihg.supabase.co/postgres',
    }).ok,
    false
  )
  assert.equal(
    validatePaymentCanaryEnvironment({
      ...disposableEnvironment,
      PAYMENT_CANARY_TARGET_ATTESTATION: 'yes',
    }).ok,
    false
  )
})

test('payment canary always rolls back and proves restoration from a second connection', async () => {
  const clients = []
  const queries = []
  const fixtureRow = {
    id: disposableEnvironment.PAYMENT_CANARY_DISPOSABLE_USER_ID,
    handle: disposableEnvironment.PAYMENT_CANARY_DISPOSABLE_HANDLE,
    deleted_at: null,
    banned_at: null,
    is_banned: false,
    is_pro: false,
    subscription_tier: 'free',
    pro_plan: null,
    pro_expires_at: null,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    subscription_count: 0,
    grant_count: 0,
    trial_count: 0,
    payment_count: 0,
    effect_count: 0,
    review_count: 0,
    official_group_count: 0,
  }

  const result = await runPaymentPathCanary({
    env: disposableEnvironment,
    randomUUID: () => '22222222-2222-4222-8222-222222222222',
    clientFactory() {
      const clientNumber = clients.length + 1
      const client = {
        async connect() {},
        async end() {},
        async query(sql) {
          queries.push({ clientNumber, sql })
          if (/FROM public\.user_profiles AS profile[\s\S]*FOR UPDATE/.test(sql)) {
            return { rows: [fixtureRow] }
          }
          if (/pg_catalog\.md5\(snapshot\.payload::text\)/.test(sql)) {
            return { rows: [{ snapshot: 'same-fingerprint' }] }
          }
          if (/activate_recurring_entitlement_payment_atomic/.test(sql)) {
            return { rows: [{ result: { status: 'activated' } }] }
          }
          if (/stripe_has_current_pro_authority_v2/.test(sql)) {
            return {
              rows: [
                {
                  has_authority: true,
                  exact_subscription_count: 1,
                  payment_count: 1,
                },
              ],
            }
          }
          return { rows: [] }
        },
      }
      clients.push(client)
      return client
    },
  })

  assert.equal(result.exitCode, 0)
  assert.equal(result.status, 'passed_restored')
  assert.equal(clients.length, 2)
  assert.equal(
    queries.some(({ sql }) => sql === 'BEGIN'),
    true
  )
  assert.equal(
    queries.some(({ sql }) => sql === 'ROLLBACK'),
    true
  )
  assert.equal(
    queries.some(
      ({ clientNumber, sql }) =>
        clientNumber === 2 && /pg_catalog\.md5\(snapshot\.payload::text\)/.test(sql)
    ),
    true
  )
})

test('payment canary source uses current authority, no hard-coded fixture UUID, and no destructive cleanup fallback', async () => {
  const source = await readFile(
    new URL('../openclaw/payment-path-canary.mjs', import.meta.url),
    'utf8'
  )

  assert.match(source, /activate_recurring_entitlement_payment_atomic/)
  assert.match(source, /ROLLBACK/)
  assert.doesNotMatch(source, /update_subscription_and_profile/)
  assert.doesNotMatch(source, /DELETE\s+FROM\s+subscriptions/i)
  assert.doesNotMatch(source, /subscription_tier\s*=\s*'free'/i)
  assert.doesNotMatch(source, UUID_VALUE_PATTERN)
  assert.doesNotMatch(source, /\bCOMMIT\b/)
})

test('payment canary is suspended with its protected input contract intact', async () => {
  const workflow = await readFile(
    new URL('../../.github/workflows/payment-path-canary.yml', import.meta.url),
    'utf8'
  )
  const parsedWorkflow = parse(workflow)
  const sentinelsWorkflow = await readFile(
    new URL('../../.github/workflows/openclaw-sentinels.yml', import.meta.url),
    'utf8'
  )

  assert.deepEqual(Object.keys(parsedWorkflow.on), ['workflow_call'])
  assert.equal(parsedWorkflow.on.workflow_call.secrets, undefined)
  assert.equal(parsedWorkflow.jobs['payment-path-canary'].if, '${{ false }}')
  assert.match(workflow, /confirm_rollback_only_staging:/)
  assert.match(workflow, /environment: arena-staging-payment-canary/)
  assert.match(workflow, /secrets\.PAYMENT_CANARY_STAGING_DATABASE_URL/)
  assert.match(workflow, /secrets\.PAYMENT_CANARY_STAGING_PROJECT_REF/)
  assert.doesNotMatch(workflow, /DATABASE_URL: \$\{\{ secrets\.DATABASE_URL \}\}/)
  assert.doesNotMatch(sentinelsWorkflow, /payment-path-canary/)
})
