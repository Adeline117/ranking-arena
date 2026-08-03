import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  ApiTierCutoverError,
  expectedExecuteConfirmation,
  listLegacyCheckoutSessions,
  parseApiTierCutoverArgs,
  probeClosedWriter,
  runApiTierCutover,
  runApiTierCutoverCli,
} from './api-tier-cutover.mjs'

const RELEASE_SHA = 'a'.repeat(40)
const DRIFT_SHA = 'b'.repeat(40)
const USER_ID = '11111111-1111-4111-8111-111111111111'
const RESERVATION_ID = '22222222-2222-4222-8222-222222222222'
const STARTER_PRICE = 'price_api_starter'
const PRO_PRICE = 'price_api_pro'

function legacyMetadata(overrides = {}) {
  return {
    api_plan: 'starter',
    supabase_user_id: USER_ID,
    type: 'api_tier',
    userId: USER_ID,
    ...overrides,
  }
}

function modernMetadata() {
  return {
    api_plan: 'starter',
    api_tier_reservation_id: RESERVATION_ID,
    supabase_user_id: USER_ID,
    type: 'api_tier',
    userId: USER_ID,
  }
}

function listedSession({
  id = 'cs_legacy',
  status = 'open',
  livemode = true,
  metadata = legacyMetadata(),
  customer = 'cus_owner',
} = {}) {
  return {
    object: 'checkout.session',
    id,
    status,
    livemode,
    mode: 'subscription',
    metadata,
    customer,
  }
}

function exactPrice({ id = STARTER_PRICE, amount = 4_900, livemode = true } = {}) {
  return {
    object: 'price',
    id,
    livemode,
    type: 'recurring',
    currency: 'usd',
    unit_amount: amount,
    unit_amount_decimal: String(amount),
    recurring: {
      interval: 'month',
      interval_count: 1,
    },
  }
}

function completedSession({
  id = 'cs_legacy',
  livemode = true,
  customer = 'cus_owner',
  subscription = 'sub_legacy',
} = {}) {
  return {
    ...listedSession({ id, status: 'complete', livemode, customer }),
    payment_status: 'paid',
    currency: 'usd',
    amount_subtotal: 4_900,
    amount_total: 4_900,
    total_details: {
      amount_discount: 0,
      amount_shipping: 0,
      amount_tax: 0,
    },
    subscription,
    line_items: {
      has_more: false,
      data: [
        {
          quantity: 1,
          amount_discount: 0,
          amount_tax: 0,
          amount_subtotal: 4_900,
          amount_total: 4_900,
          currency: 'usd',
          price: exactPrice({ livemode }),
        },
      ],
    },
  }
}

function exactCustomer({ livemode = true } = {}) {
  return {
    object: 'customer',
    id: 'cus_owner',
    livemode,
    deleted: false,
    metadata: {
      source: 'ranking-arena-api',
      plan: 'api_starter',
      userId: USER_ID,
    },
  }
}

function exactSubscription({ livemode = true } = {}) {
  return {
    object: 'subscription',
    id: 'sub_legacy',
    livemode,
    status: 'active',
    customer: 'cus_owner',
    created: 1_800_000_000,
    metadata: legacyMetadata(),
    items: {
      has_more: false,
      data: [
        {
          quantity: 1,
          price: exactPrice({ livemode }),
        },
      ],
    },
  }
}

function jsonResponse(status, body, headers = {}) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  )
  return {
    status,
    headers: {
      get(name) {
        return normalizedHeaders.get(name.toLowerCase()) ?? null
      },
    },
    async json() {
      return body
    },
  }
}

function closedFetch({ healthShas = [RELEASE_SHA], requests = [] } = {}) {
  let healthIndex = 0
  return async (urlValue, init = {}) => {
    const url = new URL(urlValue)
    requests.push({ pathname: url.pathname, init })
    if (url.pathname === '/api/health') {
      const commit = healthShas[Math.min(healthIndex, healthShas.length - 1)]
      healthIndex += 1
      return jsonResponse(200, { commit })
    }
    if (url.pathname === '/api/stripe/create-api-checkout') {
      return jsonResponse(
        503,
        { code: 'API_CHECKOUT_WRITER_CLOSED' },
        { 'X-Arena-API-Checkout-Writer': 'closed' }
      )
    }
    throw new Error('unexpected URL')
  }
}

function exactMigrationDatabase({
  settlements = [],
  failedEvents = 0,
  processingEvents = 0,
  profileLedgerDrift = 0,
  unresolvedFinancialReversals = null,
  inspect,
} = {}) {
  return {
    async readMigrationStates(migrations) {
      return migrations.map((migration) => ({
        version: migration.version,
        state: migration.version === '20260729020000' ? 'exact' : 'missing',
      }))
    },
    async inspectCutover(input) {
      if (inspect) return inspect(input)
      return {
        settlements,
        backlog: {
          failedEvents,
          processingEvents,
          profileLedgerDrift,
          unresolvedFinancialReversals,
        },
      }
    },
  }
}

function emptyStripe({ open = [], complete = [] } = {}) {
  const mutations = []
  return {
    mutations,
    checkout: {
      sessions: {
        async list({ status }) {
          return {
            data: status === 'open' ? open : complete,
            has_more: false,
          }
        },
        async retrieve() {
          throw new Error('unexpected retrieve')
        },
        async expire(id) {
          mutations.push(id)
          throw new Error('unexpected expire')
        },
      },
    },
    customers: {
      async retrieve() {
        throw new Error('unexpected customer retrieve')
      },
    },
    subscriptions: {
      async retrieve() {
        throw new Error('unexpected subscription retrieve')
      },
    },
  }
}

function runFixture(overrides = {}) {
  return {
    mode: 'scan',
    expectedReleaseSha: RELEASE_SHA,
    baseUrl: 'https://arena.example',
    livemode: true,
    confirmation: undefined,
    planPrices: {
      starter: STARTER_PRICE,
      pro: PRO_PRICE,
    },
    fetchImpl: closedFetch(),
    stripe: emptyStripe(),
    database: exactMigrationDatabase(),
    probeAttempts: 1,
    now: () => new Date('2026-07-29T08:00:00.000Z'),
    ...overrides,
  }
}

test('closed probe binds an unauthenticated writer rejection between two exact release probes', async () => {
  const requests = []
  const evidence = await probeClosedWriter({
    fetchImpl: closedFetch({ requests }),
    baseUrl: 'https://arena.example',
    expectedReleaseSha: RELEASE_SHA,
    attempts: 1,
  })

  assert.deepEqual(evidence, {
    release_sha: RELEASE_SHA,
    writer_mode: 'closed',
    http_status: 503,
    writer_header: 'closed',
  })
  assert.deepEqual(
    requests.map((request) => request.pathname),
    ['/api/health', '/api/stripe/create-api-checkout', '/api/health']
  )
  const post = requests[1].init
  assert.equal(post.credentials, 'omit')
  assert.equal(post.headers.Authorization, undefined)
  assert.equal(post.headers.Cookie, undefined)
  assert.deepEqual(JSON.parse(post.body), { plan: 'starter' })
})

test('closed probe rejects release SHA drift', async () => {
  await assert.rejects(
    probeClosedWriter({
      fetchImpl: closedFetch({ healthShas: [RELEASE_SHA, DRIFT_SHA] }),
      baseUrl: 'https://arena.example',
      expectedReleaseSha: RELEASE_SHA,
      attempts: 1,
    }),
    (error) => error instanceof ApiTierCutoverError && error.code === 'HEALTH_RELEASE_SHA_DRIFT'
  )
})

test('Checkout listing paginates beyond 100 pages and excludes exact modern metadata', async () => {
  const stripe = emptyStripe()
  stripe.checkout.sessions.list = async ({ status, starting_after: startingAfter }) => {
    if (status === 'complete') return { data: [], has_more: false }
    const index = startingAfter
      ? Number.parseInt(startingAfter.slice('cs_page_'.length), 10) + 1
      : 0
    return {
      data: [
        listedSession({
          id: `cs_page_${index}`,
          metadata: index === 0 ? legacyMetadata() : modernMetadata(),
        }),
      ],
      has_more: index < 100,
    }
  }

  const listed = await listLegacyCheckoutSessions({ stripe, livemode: true })
  assert.equal(listed.open.pages, 101)
  assert.equal(listed.open.legacy.length, 1)
  assert.equal(listed.open.legacy[0].id, 'cs_page_0')
  assert.equal(listed.open.issues.length, 0)
  assert.equal(listed.complete.pages, 1)
})

test('Checkout listing rejects duplicate cursors and wrong livemode', async (t) => {
  await t.test('duplicate cursor', async () => {
    const stripe = emptyStripe()
    stripe.checkout.sessions.list = async ({ status }) => {
      if (status === 'complete') return { data: [], has_more: false }
      return {
        data: [listedSession({ id: 'cs_duplicate' })],
        has_more: true,
      }
    }
    await assert.rejects(
      listLegacyCheckoutSessions({ stripe, livemode: true }),
      (error) =>
        error instanceof ApiTierCutoverError &&
        (error.code === 'STRIPE_SESSION_ID_DUPLICATED' ||
          error.code === 'STRIPE_PAGINATION_DID_NOT_ADVANCE')
    )
  })

  await t.test('wrong livemode', async () => {
    const stripe = emptyStripe({
      open: [listedSession({ id: 'cs_wrong_mode', livemode: false })],
    })
    await assert.rejects(
      listLegacyCheckoutSessions({ stripe, livemode: true }),
      (error) => error instanceof ApiTierCutoverError && error.code === 'STRIPE_LIVEMODE_MISMATCH'
    )
  })
})

test('dry-run records open legacy Sessions without any mutation', async () => {
  const stripe = emptyStripe({
    open: [
      listedSession({ id: 'cs_open_legacy' }),
      listedSession({ id: 'cs_modern', metadata: modernMetadata() }),
    ],
  })
  const { report } = await runApiTierCutover(runFixture({ stripe }))

  assert.equal(stripe.mutations.length, 0)
  assert.equal(report.legacy_checkout_scan.unique_legacy_sessions, 1)
  assert.equal(report.legacy_checkout_scan.open_observed, 1)
  assert.equal(report.legacy_checkout_scan.open_remaining, 1)
  assert.equal(report.legacy_checkout_scan.malformed, 0)
  assert.equal(report.webhook_and_projection.unresolved_financial_reversals, 1)
  assert.equal(report.sealed_probe.writer_mode, 'pending')
})

test('execute mode fails closed on malformed legacy metadata before any mutation', async () => {
  const stripe = emptyStripe({
    open: [
      listedSession({
        id: 'cs_malformed',
        metadata: {
          api_plan: 'starter',
          type: 'api_tier',
          userId: USER_ID,
        },
      }),
    ],
  })
  const { report, unsettled } = await runApiTierCutover(
    runFixture({
      mode: 'execute',
      confirmation: expectedExecuteConfirmation(RELEASE_SHA, true),
      stripe,
    })
  )

  assert.equal(stripe.mutations.length, 0)
  assert.equal(report.legacy_checkout_scan.malformed, 1)
  assert.equal(report.legacy_checkout_scan.open_remaining, 1)
  assert.deepEqual(unsettled.scan_issues, [
    {
      checkout_session_id: 'cs_malformed',
      status: 'open',
      reason: 'malformed_api_tier_metadata',
    },
  ])
})

test('execute mode freshly verifies, handles an expire/complete race, and classifies fulfillment', async () => {
  const callOrder = []
  let phase = 'open'
  const stripe = emptyStripe({
    open: [listedSession({ id: 'cs_legacy' })],
  })
  stripe.checkout.sessions.retrieve = async () => {
    callOrder.push('session.retrieve')
    return phase === 'open' ? listedSession({ id: 'cs_legacy' }) : completedSession()
  }
  stripe.checkout.sessions.expire = async (id) => {
    callOrder.push('session.expire')
    stripe.mutations.push(id)
    phase = 'complete'
    throw new Error('sk_live_must_never_escape')
  }
  stripe.customers.retrieve = async () => {
    callOrder.push('customer.retrieve')
    return exactCustomer()
  }
  stripe.subscriptions.retrieve = async () => {
    callOrder.push('subscription.retrieve')
    return exactSubscription()
  }
  const database = exactMigrationDatabase({
    inspect({ authorities }) {
      assert.equal(authorities.length, 1)
      assert.equal(authorities[0].checkoutSessionId, 'cs_legacy')
      return {
        settlements: [
          {
            subscriptionId: 'sub_legacy',
            fulfilled: true,
            reason: 'fulfilled',
          },
        ],
        backlog: {
          failedEvents: 0,
          processingEvents: 0,
          profileLedgerDrift: 0,
          unresolvedFinancialReversals: null,
        },
      }
    },
  })

  const result = await runApiTierCutover(
    runFixture({
      mode: 'execute',
      confirmation: expectedExecuteConfirmation(RELEASE_SHA, true),
      stripe,
      database,
    })
  )

  assert.deepEqual(stripe.mutations, ['cs_legacy'])
  assert.deepEqual(callOrder, [
    'session.retrieve',
    'customer.retrieve',
    'session.expire',
    'session.retrieve',
    'customer.retrieve',
    'subscription.retrieve',
  ])
  assert.equal(result.report.legacy_checkout_scan.unique_legacy_sessions, 1)
  assert.equal(result.report.legacy_checkout_scan.open_observed, 1)
  assert.equal(result.report.legacy_checkout_scan.complete_observed, 1)
  assert.equal(result.report.legacy_checkout_scan.fulfilled, 1)
  assert.equal(result.report.legacy_checkout_scan.open_remaining, 0)
  assert.equal(result.report.legacy_checkout_scan.unsettled_complete, 0)
  assert.equal(result.unsettled.sessions.length, 0)
  assert.doesNotMatch(JSON.stringify(result), /sk_live_must_never_escape/)
})

test('complete but unbound Sessions are emitted before remediation is allowed', async () => {
  const stripe = emptyStripe({
    complete: [listedSession({ id: 'cs_legacy', status: 'complete' })],
  })
  stripe.checkout.sessions.retrieve = async () => completedSession()
  stripe.customers.retrieve = async () => exactCustomer()
  stripe.subscriptions.retrieve = async () => exactSubscription()
  const database = exactMigrationDatabase({
    settlements: [
      {
        subscriptionId: 'sub_legacy',
        fulfilled: false,
        reason: 'event_ledger_missing',
      },
    ],
  })

  const result = await runApiTierCutover(runFixture({ stripe, database }))
  assert.equal(result.report.legacy_checkout_scan.unsettled_complete, 1)
  assert.equal(result.report.webhook_and_projection.paid_unbound, 1)
  assert.deepEqual(result.unsettled.sessions, [
    {
      checkout_session_id: 'cs_legacy',
      user_id: USER_ID,
      customer_id: 'cus_owner',
      subscription_id: 'sub_legacy',
      api_plan: 'starter',
      price_id: STARTER_PRICE,
      amount: 4_900,
      currency: 'usd',
      reason: 'event_ledger_missing',
    },
  ])
})

test('completed Session amount and price drift fail closed', async () => {
  const stripe = emptyStripe({
    complete: [listedSession({ id: 'cs_legacy', status: 'complete' })],
  })
  stripe.checkout.sessions.retrieve = async () => ({
    ...completedSession(),
    amount_total: 4_899,
  })

  await assert.rejects(
    runApiTierCutover(runFixture({ stripe })),
    (error) =>
      error instanceof ApiTierCutoverError && error.code === 'COMPLETED_CHECKOUT_IDENTITY_INVALID'
  )
  assert.equal(stripe.mutations.length, 0)
})

test('execute confirmation is exact and secret-bearing CLI arguments are rejected', async () => {
  await assert.rejects(
    runApiTierCutover(
      runFixture({
        mode: 'execute',
        confirmation: `wrong:${RELEASE_SHA}`,
      })
    ),
    (error) => error instanceof ApiTierCutoverError && error.code === 'EXECUTE_CONFIRMATION_INVALID'
  )

  assert.throws(
    () =>
      parseApiTierCutoverArgs([
        '--mode',
        'scan',
        '--expected-release-sha',
        RELEASE_SHA,
        '--output',
        '/tmp/report.json',
        '--stripe-secret-key',
        'sk_live_forbidden',
      ]),
    (error) => error instanceof ApiTierCutoverError && error.code === 'ARGUMENT_UNKNOWN'
  )
})

test('CLI writes secret-free intermediate evidence and exits non-zero until final proof exists', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'arena-api-tier-cutover-'))
  const reportPath = resolve(directory, 'report.json')
  const unsettledPath = resolve(directory, 'unsettled.json')
  const databaseUrl =
    'postgresql://postgres.iknktzifjdyujdccyhsv:db-secret@aws-0-us-west-2.pooler.supabase.com:5432/postgres'
  try {
    const result = await runApiTierCutoverCli({
      argv: [
        '--mode',
        'scan',
        '--expected-release-sha',
        RELEASE_SHA,
        '--output',
        reportPath,
        '--unsettled-output',
        unsettledPath,
      ],
      env: {
        STRIPE_SECRET_KEY: 'sk_live_cli_secret',
        DATABASE_URL: databaseUrl,
        STRIPE_API_STARTER_PRICE_ID: STARTER_PRICE,
        STRIPE_API_PRO_PRICE_ID: PRO_PRICE,
        API_TIER_CUTOVER_PROBE_ATTEMPTS: '1',
      },
      fetchImpl: closedFetch(),
      stripe: emptyStripe(),
      database: exactMigrationDatabase(),
    })

    assert.equal(result.exitCode, 2)
    assert.equal(result.summary.status, 'incomplete')
    const artifacts = `${await readFile(reportPath, 'utf8')}${await readFile(
      unsettledPath,
      'utf8'
    )}`
    assert.doesNotMatch(artifacts, /sk_live_cli_secret|db-secret/)
    assert.equal(artifacts.includes(databaseUrl), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
