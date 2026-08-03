#!/usr/bin/env node

/**
 * Machine evidence for the legacy API-tier Checkout writer cutover.
 *
 * Secrets are accepted only through the process environment:
 *   STRIPE_SECRET_KEY
 *   DATABASE_URL
 *   API_TIER_CUTOVER_CONFIRMATION (execute mode only)
 *
 * Example (scan only):
 *   node scripts/maintenance/api-tier-cutover.mjs \
 *     --mode scan \
 *     --expected-release-sha <40-char SHA> \
 *     --output /secure/path/api-tier-cutover.json
 *
 * The report intentionally remains validator-incomplete until the sealed
 * release/canary and the financial-reversal settlement authority are wired.
 * An incomplete candidate is still written, then the process exits non-zero.
 */

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateDatabaseUrl } from '../attest-production-types-source.mjs'
import { validateApiTierCutoverReport } from './validate-api-tier-cutover-report.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const FULL_SHA = /^[0-9a-f]{40}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const STRIPE_ID = {
  checkout: /^cs_[A-Za-z0-9_]+$/,
  customer: /^cus_[A-Za-z0-9_]+$/,
  subscription: /^sub_[A-Za-z0-9_]+$/,
  price: /^price_[A-Za-z0-9_]+$/,
}
const MAX_STRIPE_ID_LENGTH = 255
const MAX_STRIPE_UNIX_SECONDS = 253_402_300_799
const LEGACY_METADATA_KEYS = ['api_plan', 'supabase_user_id', 'type', 'userId']
const MODERN_METADATA_KEYS = [
  'api_plan',
  'api_tier_reservation_id',
  'supabase_user_id',
  'type',
  'userId',
]
const REQUIRED_MIGRATIONS = [
  {
    version: '20260729020000',
    name: 'api_tier_cancellation_identity',
    phase: 'predeploy',
    file: '20260729020000_api_tier_cancellation_identity.sql',
  },
  {
    version: '20260729021000',
    name: 'disable_legacy_api_tier_writer',
    phase: 'postdeploy',
    file: '20260729021000_disable_legacy_api_tier_writer.sql',
  },
]
const EXPECTED_PLAN = {
  starter: { amount: 4_900, dailyLimit: 10_000 },
  pro: { amount: 19_900, dailyLimit: 0 },
}
const DEFAULT_BASE_URL = 'https://www.arenafi.org'
const DEFAULT_PROBE_ATTEMPTS = 3
const PROBE_TIMEOUT_MS = 20_000
const MAX_PAGINATION_PAGES = 100_000

export class ApiTierCutoverError extends Error {
  constructor(code) {
    super(code)
    this.name = 'ApiTierCutoverError'
    this.code = code
  }
}

function fail(code) {
  throw new ApiTierCutoverError(code)
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function exactKeys(value, expected) {
  if (!record(value)) return false
  const actual = Object.keys(value).sort()
  const canonical = [...expected].sort()
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  )
}

function exactCanonicalUuid(value) {
  return typeof value === 'string' &&
    value === value.trim() &&
    value === value.toLowerCase() &&
    UUID.test(value)
    ? value
    : null
}

function exactStripeId(value, pattern) {
  return typeof value === 'string' && value.length <= MAX_STRIPE_ID_LENGTH && pattern.test(value)
    ? value
    : null
}

function stripeObjectId(value, pattern) {
  if (typeof value === 'string') return exactStripeId(value, pattern)
  const object = record(value)
  return object ? exactStripeId(object.id, pattern) : null
}

function safeNonNegativeInteger(value, code) {
  const parsed =
    typeof value === 'string' && /^\d+$/.test(value) ? Number.parseInt(value, 10) : value
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(code)
  return parsed
}

function normalizeTimestamp(value, code) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) fail(code)
  return date.toISOString()
}

function normalizeBaseUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    fail('BASE_URL_INVALID')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    fail('BASE_URL_INVALID')
  }
  return url.origin
}

function normalizeReleaseSha(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!FULL_SHA.test(normalized)) fail('RELEASE_SHA_INVALID')
  return normalized
}

function normalizePlanPrices(value) {
  const prices = record(value)
  const starter = exactStripeId(prices?.starter, STRIPE_ID.price)
  const pro = exactStripeId(prices?.pro, STRIPE_ID.price)
  if (!starter || !pro || starter === pro) fail('API_PRICE_CONFIGURATION_INVALID')
  return { starter, pro }
}

export function expectedExecuteConfirmation(releaseSha, livemode) {
  return `I_ACKNOWLEDGE_EXPIRE_ALL_LEGACY_API_TIER_CHECKOUTS:${
    livemode ? 'LIVE' : 'TEST'
  }:${normalizeReleaseSha(releaseSha)}`
}

function assertExecuteConfirmation({ mode, confirmation, releaseSha, livemode }) {
  if (mode !== 'execute') return
  if (confirmation !== expectedExecuteConfirmation(releaseSha, livemode)) {
    fail('EXECUTE_CONFIRMATION_INVALID')
  }
}

async function external(code, operation) {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof ApiTierCutoverError) throw error
    fail(code)
  }
}

async function bestEffort(operation) {
  try {
    await operation()
    return true
  } catch {
    return false
  }
}

async function responseJson(response, code) {
  return external(code, async () => {
    const value = await response.json()
    if (!record(value)) fail(code)
    return value
  })
}

async function oneClosedWriterProbe({ fetchImpl, baseUrl, expectedReleaseSha }) {
  const healthUrl = new URL('/api/health', baseUrl)
  const checkoutUrl = new URL('/api/stripe/create-api-checkout', baseUrl)
  const requestHealth = async () => {
    const response = await external('HEALTH_PROBE_TRANSPORT_FAILED', () =>
      fetchImpl(healthUrl, {
        method: 'GET',
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
    )
    const body = await responseJson(response, 'HEALTH_PROBE_BODY_INVALID')
    if (body.commit !== expectedReleaseSha) fail('HEALTH_RELEASE_SHA_DRIFT')
    return body.commit
  }

  await requestHealth()
  const checkoutResponse = await external('WRITER_PROBE_TRANSPORT_FAILED', () =>
    fetchImpl(checkoutUrl, {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ plan: 'starter' }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
  )
  const checkoutBody = await responseJson(checkoutResponse, 'WRITER_PROBE_BODY_INVALID')
  const writerHeader = checkoutResponse.headers?.get?.('x-arena-api-checkout-writer')
  if (
    checkoutResponse.status !== 503 ||
    checkoutBody.code !== 'API_CHECKOUT_WRITER_CLOSED' ||
    writerHeader !== 'closed'
  ) {
    fail('WRITER_NOT_EXACTLY_CLOSED')
  }
  await requestHealth()

  return {
    release_sha: expectedReleaseSha,
    writer_mode: 'closed',
    http_status: 503,
    writer_header: 'closed',
  }
}

export async function probeClosedWriter({
  fetchImpl,
  baseUrl,
  expectedReleaseSha,
  attempts = DEFAULT_PROBE_ATTEMPTS,
}) {
  if (typeof fetchImpl !== 'function') fail('FETCH_DEPENDENCY_INVALID')
  const canonicalBaseUrl = normalizeBaseUrl(baseUrl)
  const canonicalSha = normalizeReleaseSha(expectedReleaseSha)
  if (!Number.isSafeInteger(attempts) || attempts <= 0 || attempts > 100) {
    fail('PROBE_ATTEMPTS_INVALID')
  }

  let evidence
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    evidence = await oneClosedWriterProbe({
      fetchImpl,
      baseUrl: canonicalBaseUrl,
      expectedReleaseSha: canonicalSha,
    })
  }
  return evidence
}

function metadataClassification(metadata) {
  const object = record(metadata)
  if (!object) return 'unrelated'
  if (exactKeys(object, LEGACY_METADATA_KEYS)) return 'legacy'
  if (exactKeys(object, MODERN_METADATA_KEYS)) return 'modern'
  if (
    object.type === 'api_tier' ||
    own(object, 'api_plan') ||
    own(object, 'api_tier_reservation_id')
  ) {
    return 'malformed'
  }
  return 'unrelated'
}

function parseMetadataIdentity(metadata, { modern }) {
  const userId = exactCanonicalUuid(metadata.userId)
  const supabaseUserId = exactCanonicalUuid(metadata.supabase_user_id)
  const plan = metadata.api_plan
  const reservationId = modern ? exactCanonicalUuid(metadata.api_tier_reservation_id) : null
  if (!userId || !supabaseUserId) return { issue: 'malformed' }
  if (userId !== supabaseUserId) return { issue: 'identity_conflict' }
  if (
    metadata.type !== 'api_tier' ||
    (plan !== 'starter' && plan !== 'pro') ||
    (modern && !reservationId)
  ) {
    return { issue: 'malformed' }
  }
  return { userId, plan, reservationId }
}

function classifyListedSession(sessionValue, expectedStatus, livemode) {
  const session = record(sessionValue)
  if (!session) fail('STRIPE_SESSION_LIST_ITEM_INVALID')
  const id = exactStripeId(session.id, STRIPE_ID.checkout)
  if (
    !id ||
    session.object !== 'checkout.session' ||
    session.status !== expectedStatus ||
    typeof session.livemode !== 'boolean'
  ) {
    fail('STRIPE_SESSION_LIST_ITEM_INVALID')
  }
  if (session.livemode !== livemode) fail('STRIPE_LIVEMODE_MISMATCH')

  const classification = metadataClassification(session.metadata)
  if (classification === 'unrelated') return { kind: 'unrelated', id }
  const metadata = record(session.metadata)
  const identity = parseMetadataIdentity(metadata, { modern: classification === 'modern' })
  if (classification === 'modern') {
    if (identity.issue || session.mode !== 'subscription') {
      return { kind: identity.issue ?? 'malformed', id, status: expectedStatus }
    }
    return { kind: 'modern', id }
  }
  if (classification === 'malformed' || identity.issue) {
    return {
      kind: identity.issue ?? 'malformed',
      id,
      status: expectedStatus,
    }
  }

  const customerId = stripeObjectId(session.customer, STRIPE_ID.customer)
  if (session.mode !== 'subscription' || !customerId) {
    return { kind: 'malformed', id, status: expectedStatus }
  }
  return {
    kind: 'legacy',
    id,
    status: expectedStatus,
    customerId,
    userId: identity.userId,
    plan: identity.plan,
  }
}

async function listStatusPages({ stripe, status, livemode, globallySeenIds }) {
  const legacy = []
  const issues = []
  let pages = 0
  let startingAfter
  const cursors = new Set()

  while (true) {
    pages += 1
    if (pages > MAX_PAGINATION_PAGES) fail('STRIPE_PAGINATION_LIMIT_EXCEEDED')
    const page = await external('STRIPE_SESSION_LIST_FAILED', () =>
      stripe.checkout.sessions.list({
        limit: 100,
        status,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      })
    )
    if (!record(page) || !Array.isArray(page.data) || typeof page.has_more !== 'boolean') {
      fail('STRIPE_SESSION_PAGE_INVALID')
    }
    if (page.has_more && page.data.length === 0) fail('STRIPE_PAGINATION_DID_NOT_ADVANCE')

    for (const rawSession of page.data) {
      const parsed = classifyListedSession(rawSession, status, livemode)
      if (globallySeenIds.has(parsed.id)) fail('STRIPE_SESSION_ID_DUPLICATED')
      globallySeenIds.add(parsed.id)
      if (parsed.kind === 'legacy') legacy.push(parsed)
      else if (parsed.kind === 'malformed' || parsed.kind === 'identity_conflict') {
        issues.push(parsed)
      }
    }

    if (!page.has_more) break
    const cursor = page.data.at(-1)?.id
    if (
      !exactStripeId(cursor, STRIPE_ID.checkout) ||
      cursor === startingAfter ||
      cursors.has(cursor)
    ) {
      fail('STRIPE_PAGINATION_DID_NOT_ADVANCE')
    }
    cursors.add(cursor)
    startingAfter = cursor
  }

  return { pages, legacy, issues }
}

export async function listLegacyCheckoutSessions({ stripe, livemode }) {
  if (!stripe?.checkout?.sessions?.list) fail('STRIPE_DEPENDENCY_INVALID')
  if (typeof livemode !== 'boolean') fail('STRIPE_LIVEMODE_INVALID')
  const seen = new Set()
  const open = await listStatusPages({
    stripe,
    status: 'open',
    livemode,
    globallySeenIds: seen,
  })
  const complete = await listStatusPages({
    stripe,
    status: 'complete',
    livemode,
    globallySeenIds: seen,
  })
  return { open, complete }
}

function assertSameLegacyIdentity(parsed, expected) {
  if (
    parsed.kind !== 'legacy' ||
    parsed.id !== expected.id ||
    parsed.customerId !== expected.customerId ||
    parsed.userId !== expected.userId ||
    parsed.plan !== expected.plan
  ) {
    fail('FRESH_SESSION_IDENTITY_MISMATCH')
  }
}

async function retrieveFreshSession(stripe, sessionId) {
  return external('STRIPE_SESSION_RETRIEVE_FAILED', () =>
    stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items.data.price'],
    })
  )
}

async function retrieveExactCustomer({ stripe, customerId, userId, livemode }) {
  const customer = await external('STRIPE_CUSTOMER_RETRIEVE_FAILED', () =>
    stripe.customers.retrieve(customerId)
  )
  const object = record(customer)
  const metadata = record(object?.metadata)
  if (
    !object ||
    object.deleted === true ||
    object.object !== 'customer' ||
    object.id !== customerId ||
    object.livemode !== livemode ||
    !metadata ||
    exactCanonicalUuid(metadata.userId) !== userId ||
    (own(metadata, 'user_id') && metadata.user_id !== userId) ||
    (own(metadata, 'supabase_user_id') && metadata.supabase_user_id !== userId)
  ) {
    fail('STRIPE_CUSTOMER_IDENTITY_INVALID')
  }
  return customer
}

function assertExactPrice(priceValue, { priceId, plan, livemode }) {
  const price = record(priceValue)
  const expected = EXPECTED_PLAN[plan]
  const recurring = record(price?.recurring)
  if (
    !price ||
    price.object !== 'price' ||
    price.id !== priceId ||
    price.livemode !== livemode ||
    price.type !== 'recurring' ||
    price.currency !== 'usd' ||
    price.unit_amount !== expected.amount ||
    price.unit_amount_decimal !== String(expected.amount) ||
    !recurring ||
    recurring.interval !== 'month' ||
    recurring.interval_count !== 1
  ) {
    fail('STRIPE_PRICE_IDENTITY_INVALID')
  }
}

function parseExactLegacyMetadata(metadataValue) {
  const metadata = record(metadataValue)
  if (!metadata || !exactKeys(metadata, LEGACY_METADATA_KEYS)) {
    fail('LEGACY_METADATA_INVALID')
  }
  const identity = parseMetadataIdentity(metadata, { modern: false })
  if (identity.issue) fail('LEGACY_METADATA_INVALID')
  return identity
}

async function retrieveExactSubscription({ stripe, subscriptionId, expected, priceId, livemode }) {
  const subscription = await external('STRIPE_SUBSCRIPTION_RETRIEVE_FAILED', () =>
    stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price'],
    })
  )
  const object = record(subscription)
  const identity = parseExactLegacyMetadata(object?.metadata)
  const customerId = stripeObjectId(object?.customer, STRIPE_ID.customer)
  const items = record(object?.items)
  const item = Array.isArray(items?.data) && items.data.length === 1 ? record(items.data[0]) : null
  const itemPriceId = stripeObjectId(item?.price, STRIPE_ID.price)
  if (
    !object ||
    object.object !== 'subscription' ||
    object.id !== subscriptionId ||
    object.livemode !== livemode ||
    object.status !== 'active' ||
    customerId !== expected.customerId ||
    identity.userId !== expected.userId ||
    identity.plan !== expected.plan ||
    items.has_more !== false ||
    !item ||
    item.quantity !== 1 ||
    itemPriceId !== priceId ||
    !Number.isSafeInteger(object.created) ||
    object.created <= 0 ||
    object.created > MAX_STRIPE_UNIX_SECONDS
  ) {
    fail('STRIPE_SUBSCRIPTION_IDENTITY_INVALID')
  }
  assertExactPrice(item.price, { priceId, plan: expected.plan, livemode })
  return subscription
}

async function parseCompletedAuthority({ stripe, sessionValue, expected, planPrices, livemode }) {
  const parsed = classifyListedSession(sessionValue, 'complete', livemode)
  assertSameLegacyIdentity(parsed, expected)
  const session = record(sessionValue)
  const identity = parseExactLegacyMetadata(session.metadata)
  const planContract = EXPECTED_PLAN[identity.plan]
  const expectedPriceId = planPrices[identity.plan]
  const subscriptionId = stripeObjectId(session.subscription, STRIPE_ID.subscription)
  const lineItems = record(session.line_items)
  const lineItem =
    Array.isArray(lineItems?.data) && lineItems.data.length === 1 ? record(lineItems.data[0]) : null
  const linePriceId = stripeObjectId(lineItem?.price, STRIPE_ID.price)
  const totalDetails = record(session.total_details)
  if (
    session.payment_status !== 'paid' ||
    session.currency !== 'usd' ||
    session.amount_subtotal !== planContract.amount ||
    session.amount_total !== planContract.amount ||
    !totalDetails ||
    totalDetails.amount_discount !== 0 ||
    totalDetails.amount_shipping !== 0 ||
    totalDetails.amount_tax !== 0 ||
    !subscriptionId ||
    lineItems?.has_more !== false ||
    !lineItem ||
    lineItem.quantity !== 1 ||
    lineItem.amount_discount !== 0 ||
    lineItem.amount_tax !== 0 ||
    lineItem.amount_subtotal !== planContract.amount ||
    lineItem.amount_total !== planContract.amount ||
    lineItem.currency !== 'usd' ||
    linePriceId !== expectedPriceId
  ) {
    fail('COMPLETED_CHECKOUT_IDENTITY_INVALID')
  }
  assertExactPrice(lineItem.price, {
    priceId: expectedPriceId,
    plan: identity.plan,
    livemode,
  })
  await retrieveExactCustomer({
    stripe,
    customerId: expected.customerId,
    userId: expected.userId,
    livemode,
  })
  const subscription = await retrieveExactSubscription({
    stripe,
    subscriptionId,
    expected,
    priceId: expectedPriceId,
    livemode,
  })

  return {
    checkoutSessionId: expected.id,
    userId: expected.userId,
    customerId: expected.customerId,
    subscriptionId,
    subscriptionCreated: subscription.created,
    plan: expected.plan,
    priceId: expectedPriceId,
    amount: planContract.amount,
    dailyLimit: planContract.dailyLimit,
  }
}

async function preflightOpenSession({ stripe, expected, planPrices, livemode }) {
  const fresh = await retrieveFreshSession(stripe, expected.id)
  const status = record(fresh)?.status
  if (status === 'complete') {
    return {
      status: 'complete',
      authority: await parseCompletedAuthority({
        stripe,
        sessionValue: fresh,
        expected,
        planPrices,
        livemode,
      }),
    }
  }
  if (status !== 'open' && status !== 'expired') fail('FRESH_SESSION_STATUS_INVALID')
  const parsed = classifyListedSession(fresh, status, livemode)
  assertSameLegacyIdentity(parsed, expected)
  await retrieveExactCustomer({
    stripe,
    customerId: expected.customerId,
    userId: expected.userId,
    livemode,
  })
  return { status }
}

async function expireAndRetrieve({ stripe, expected, planPrices, livemode }) {
  try {
    await stripe.checkout.sessions.expire(expected.id)
  } catch {
    // A Session can complete between the preflight retrieve and expire call.
    // Only the authoritative fresh retrieve below decides its disposition.
  }
  const fresh = await retrieveFreshSession(stripe, expected.id)
  const status = record(fresh)?.status
  if (status === 'complete') {
    return {
      status: 'complete',
      authority: await parseCompletedAuthority({
        stripe,
        sessionValue: fresh,
        expected,
        planPrices,
        livemode,
      }),
    }
  }
  if (status !== 'expired' && status !== 'open') fail('POST_EXPIRE_SESSION_STATUS_INVALID')
  const parsed = classifyListedSession(fresh, status, livemode)
  assertSameLegacyIdentity(parsed, expected)
  await retrieveExactCustomer({
    stripe,
    customerId: expected.customerId,
    userId: expected.userId,
    livemode,
  })
  return { status }
}

function addCompletedAuthority(map, authority) {
  const existing = map.get(authority.checkoutSessionId)
  if (existing) fail('COMPLETED_SESSION_DUPLICATED')
  map.set(authority.checkoutSessionId, authority)
}

function migrationDigest(body) {
  return createHash('sha256').update(body).digest('hex')
}

async function localMigrationEvidence(migrationDirectory) {
  const evidence = []
  for (const migration of REQUIRED_MIGRATIONS) {
    const body = await external('MIGRATION_FILE_UNREADABLE', () =>
      readFile(resolve(migrationDirectory, migration.file))
    )
    evidence.push({
      ...migration,
      sha256: migrationDigest(body),
    })
  }
  return evidence
}

function validateMigrationStates(states, expected) {
  if (!Array.isArray(states) || states.length !== expected.length) {
    fail('MIGRATION_LEDGER_RESULT_INVALID')
  }
  const byVersion = new Map()
  for (const stateValue of states) {
    const state = record(stateValue)
    if (
      !state ||
      typeof state.version !== 'string' ||
      !['exact', 'missing', 'drift'].includes(state.state) ||
      byVersion.has(state.version)
    ) {
      fail('MIGRATION_LEDGER_RESULT_INVALID')
    }
    byVersion.set(state.version, state.state)
  }
  return expected.map((migration) => {
    const state = byVersion.get(migration.version)
    if (!state) fail('MIGRATION_LEDGER_RESULT_INVALID')
    return {
      version: migration.version,
      name: migration.name,
      phase: migration.phase,
      state,
      sha256: migration.sha256,
    }
  })
}

function validateInspection(value, authorities) {
  const inspection = record(value)
  const backlog = record(inspection?.backlog)
  if (!inspection || !Array.isArray(inspection.settlements) || !backlog) {
    fail('DATABASE_INSPECTION_INVALID')
  }
  const bySubscription = new Map()
  for (const settlementValue of inspection.settlements) {
    const settlement = record(settlementValue)
    if (
      !settlement ||
      !exactStripeId(settlement.subscriptionId, STRIPE_ID.subscription) ||
      typeof settlement.fulfilled !== 'boolean' ||
      typeof settlement.reason !== 'string' ||
      bySubscription.has(settlement.subscriptionId)
    ) {
      fail('DATABASE_INSPECTION_INVALID')
    }
    bySubscription.set(settlement.subscriptionId, settlement)
  }
  for (const authority of authorities) {
    if (!bySubscription.has(authority.subscriptionId)) fail('DATABASE_INSPECTION_INCOMPLETE')
  }
  if (bySubscription.size !== authorities.length) fail('DATABASE_INSPECTION_INVALID')

  return {
    settlements: bySubscription,
    backlog: {
      failedEvents: safeNonNegativeInteger(backlog.failedEvents, 'DATABASE_FAILED_EVENTS_INVALID'),
      processingEvents: safeNonNegativeInteger(
        backlog.processingEvents,
        'DATABASE_PROCESSING_EVENTS_INVALID'
      ),
      profileLedgerDrift: safeNonNegativeInteger(
        backlog.profileLedgerDrift,
        'DATABASE_PROFILE_LEDGER_DRIFT_INVALID'
      ),
      unresolvedFinancialReversals:
        backlog.unresolvedFinancialReversals === null
          ? null
          : safeNonNegativeInteger(
              backlog.unresolvedFinancialReversals,
              'DATABASE_FINANCIAL_REVERSAL_INVALID'
            ),
    },
  }
}

function pendingSealedProbe(releaseSha) {
  return {
    release_sha: releaseSha,
    writer_mode: 'pending',
    http_status: 0,
    writer_header: 'pending',
  }
}

function pendingCanary(livemode) {
  return {
    reservation_id: '00000000-0000-4000-8000-000000000000',
    checkout_session_id: 'cs_pending',
    customer_id: 'cus_pending',
    subscription_id: 'sub_pending',
    event_id: 'evt_pending',
    livemode,
    api_tier: 'starter',
    daily_limit: 10_000,
    reservation_status: 'pending',
    event_status: 'pending',
    profile_exact: false,
    keys_exact: false,
  }
}

function buildUnsettledEvidence({
  generatedAt,
  releaseSha,
  livemode,
  settlements,
  authorities,
  scanIssues,
  reversalAuthorityPending,
}) {
  const sessions = []
  for (const authority of authorities) {
    const settlement = settlements.get(authority.subscriptionId)
    if (!settlement.fulfilled) {
      sessions.push({
        checkout_session_id: authority.checkoutSessionId,
        user_id: authority.userId,
        customer_id: authority.customerId,
        subscription_id: authority.subscriptionId,
        api_plan: authority.plan,
        price_id: authority.priceId,
        amount: authority.amount,
        currency: 'usd',
        reason: settlement.reason,
      })
    }
  }
  sessions.sort((left, right) => left.checkout_session_id.localeCompare(right.checkout_session_id))
  return {
    schema_version: 1,
    generated_at: generatedAt,
    release_sha: releaseSha,
    livemode,
    financial_reversal_authority_pending: reversalAuthorityPending,
    scan_issues: scanIssues
      .map((issue) => ({
        checkout_session_id: issue.id,
        status: issue.status,
        reason:
          issue.kind === 'identity_conflict'
            ? 'metadata_identity_conflict'
            : 'malformed_api_tier_metadata',
      }))
      .sort((left, right) => left.checkout_session_id.localeCompare(right.checkout_session_id)),
    sessions,
  }
}

export async function runApiTierCutover({
  mode,
  expectedReleaseSha,
  baseUrl = DEFAULT_BASE_URL,
  livemode,
  confirmation,
  planPrices,
  fetchImpl,
  stripe,
  database,
  migrationDirectory = resolve(ROOT, 'supabase/migrations'),
  probeAttempts = DEFAULT_PROBE_ATTEMPTS,
  now = () => new Date(),
}) {
  if (mode !== 'scan' && mode !== 'execute') fail('MODE_INVALID')
  const releaseSha = normalizeReleaseSha(expectedReleaseSha)
  const canonicalPrices = normalizePlanPrices(planPrices)
  if (typeof livemode !== 'boolean') fail('STRIPE_LIVEMODE_INVALID')
  if (
    !database?.readMigrationStates ||
    !database?.inspectCutover ||
    !stripe?.checkout?.sessions ||
    !stripe?.customers?.retrieve ||
    !stripe?.subscriptions?.retrieve
  ) {
    fail('CUTOVER_DEPENDENCY_INVALID')
  }
  assertExecuteConfirmation({ mode, confirmation, releaseSha, livemode })

  const drainStartedAt = normalizeTimestamp(now(), 'CLOCK_INVALID')
  const closedProbe = await probeClosedWriter({
    fetchImpl,
    baseUrl,
    expectedReleaseSha: releaseSha,
    attempts: probeAttempts,
  })
  const drainCompletedAt = normalizeTimestamp(now(), 'CLOCK_INVALID')

  const localMigrations = await localMigrationEvidence(migrationDirectory)
  const rawMigrationStates = await external('MIGRATION_LEDGER_QUERY_FAILED', () =>
    database.readMigrationStates(localMigrations)
  )
  const migrationLedgers = validateMigrationStates(rawMigrationStates, localMigrations)
  const predeploy = migrationLedgers.find((entry) => entry.version === '20260729020000')
  if (predeploy?.state !== 'exact') fail('PREDEPLOY_MIGRATION_NOT_EXACT')
  if (migrationLedgers.some((entry) => entry.state === 'drift')) fail('MIGRATION_LEDGER_DRIFT')

  const listed = await listLegacyCheckoutSessions({ stripe, livemode })
  const scanIssues = [...listed.open.issues, ...listed.complete.issues]
  const malformed = scanIssues.filter((issue) => issue.kind === 'malformed').length
  const identityConflicts = scanIssues.filter((issue) => issue.kind === 'identity_conflict').length
  const issueOpen = scanIssues.filter((issue) => issue.status === 'open').length
  const issueComplete = scanIssues.filter((issue) => issue.status === 'complete').length

  const completedAuthorities = new Map()
  for (const expected of listed.complete.legacy) {
    const fresh = await retrieveFreshSession(stripe, expected.id)
    addCompletedAuthority(
      completedAuthorities,
      await parseCompletedAuthority({
        stripe,
        sessionValue: fresh,
        expected,
        planPrices: canonicalPrices,
        livemode,
      })
    )
  }

  let expired = 0
  let openRemaining = issueOpen
  let raceCompleted = 0
  const preparedOpen = []
  if (mode === 'scan' || scanIssues.length > 0) {
    openRemaining += listed.open.legacy.length
  } else {
    for (const expected of listed.open.legacy) {
      const preflight = await preflightOpenSession({
        stripe,
        expected,
        planPrices: canonicalPrices,
        livemode,
      })
      if (preflight.status === 'complete') {
        addCompletedAuthority(completedAuthorities, preflight.authority)
        raceCompleted += 1
      } else if (preflight.status === 'expired') {
        expired += 1
      } else {
        preparedOpen.push(expected)
      }
    }

    // Bind every mutation to a second exact closed-release probe after all
    // Stripe identities have been freshly preflighted.
    await probeClosedWriter({
      fetchImpl,
      baseUrl,
      expectedReleaseSha: releaseSha,
      attempts: 1,
    })

    for (const expected of preparedOpen) {
      const result = await expireAndRetrieve({
        stripe,
        expected,
        planPrices: canonicalPrices,
        livemode,
      })
      if (result.status === 'complete') {
        addCompletedAuthority(completedAuthorities, result.authority)
        raceCompleted += 1
      } else if (result.status === 'expired') {
        expired += 1
      } else {
        openRemaining += 1
      }
    }
  }

  const authorities = [...completedAuthorities.values()].sort((left, right) =>
    left.checkoutSessionId.localeCompare(right.checkoutSessionId)
  )
  const rawInspection = await external('DATABASE_INSPECTION_FAILED', () =>
    database.inspectCutover({ livemode, authorities })
  )
  const inspection = validateInspection(rawInspection, authorities)
  let fulfilled = 0
  for (const authority of authorities) {
    if (inspection.settlements.get(authority.subscriptionId).fulfilled) fulfilled += 1
  }
  const unsettledComplete = authorities.length - fulfilled + issueComplete
  const reversalAuthorityPending = inspection.backlog.unresolvedFinancialReversals === null
  const unresolvedFinancialReversals = reversalAuthorityPending
    ? 1
    : inspection.backlog.unresolvedFinancialReversals

  const generatedAt = normalizeTimestamp(now(), 'CLOCK_INVALID')
  const uniqueLegacySessions =
    listed.open.legacy.length + listed.complete.legacy.length + scanIssues.length
  const report = {
    schema_version: 1,
    generated_at: generatedAt,
    release_sha: releaseSha,
    closed_probe: closedProbe,
    drain: {
      started_at: drainStartedAt,
      completed_at: drainCompletedAt,
      old_instances_remaining: 0,
    },
    migration_ledgers: migrationLedgers,
    legacy_checkout_scan: {
      livemode,
      open_pages: listed.open.pages,
      complete_pages: listed.complete.pages,
      unique_legacy_sessions: uniqueLegacySessions,
      open_observed: listed.open.legacy.length + issueOpen,
      complete_observed: listed.complete.legacy.length + issueComplete + raceCompleted,
      expired,
      fulfilled,
      cancel_refund_acked: 0,
      open_remaining: openRemaining,
      unsettled_complete: unsettledComplete,
      malformed,
      identity_conflicts: identityConflicts,
      duplicate_ids: 0,
    },
    webhook_and_projection: {
      failed_events: inspection.backlog.failedEvents,
      processing_events: inspection.backlog.processingEvents,
      paid_unbound: unsettledComplete,
      profile_ledger_drift: inspection.backlog.profileLedgerDrift,
      unresolved_financial_reversals: unresolvedFinancialReversals,
    },
    sealed_probe: pendingSealedProbe(releaseSha),
    canary: pendingCanary(livemode),
  }
  const unsettled = buildUnsettledEvidence({
    generatedAt,
    releaseSha,
    livemode,
    settlements: inspection.settlements,
    authorities,
    scanIssues,
    reversalAuthorityPending,
  })
  return { report, unsettled }
}

function settlementReason({ profile, ledger, blocked, authority }) {
  if (!profile) return 'profile_missing'
  if (profile.is_deleted === true || profile.status === 'deleted') return 'profile_deleted'
  if (profile.stripe_customer_id !== authority.customerId) return 'profile_customer_mismatch'
  if (
    profile.api_tier !== authority.plan ||
    profile.api_stripe_subscription_id !== authority.subscriptionId
  ) {
    return 'profile_projection_mismatch'
  }
  if (blocked) return 'subscription_blocked'
  if (!ledger) return 'event_ledger_missing'
  if (
    ledger.user_id !== authority.userId ||
    ledger.metadata_user_id !== authority.userId ||
    ledger.metadata_supabase_user_id !== authority.userId ||
    ledger.stripe_customer_id !== authority.customerId ||
    ledger.checkout_reservation_id !== null ||
    ledger.stripe_price_id !== authority.priceId ||
    ledger.stripe_subscription_id !== authority.subscriptionId ||
    Number(ledger.subscription_created) !== authority.subscriptionCreated ||
    ledger.api_tier !== authority.plan ||
    Number(ledger.daily_limit) !== authority.dailyLimit ||
    ledger.is_active !== true ||
    ledger.is_terminal !== false ||
    ledger.identity_source !== 'signed_metadata'
  ) {
    return 'event_ledger_identity_mismatch'
  }
  return 'fulfilled'
}

export function createPostgresCutoverDatabase(pool) {
  if (!pool?.connect) fail('DATABASE_POOL_INVALID')

  return {
    async readMigrationStates(migrations) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        const states = []
        for (const migration of migrations) {
          const result = await client.query(
            `SELECT CASE
               WHEN ledger.version IS NULL THEN 'missing'
               WHEN ledger.name = $2
                AND ledger.created_by = 'codex'
                AND ledger.idempotency_key = 'codex:' || $1 || ':' || $3
                AND pg_catalog.array_length(ledger.statements, 1) = 1
                AND pg_catalog.encode(
                  extensions.digest(ledger.statements[1], 'sha256'),
                  'hex'
                ) = $3
               THEN 'exact'
               ELSE 'drift'
             END AS state
             FROM (SELECT 1) AS seed
             LEFT JOIN supabase_migrations.schema_migrations AS ledger
               ON ledger.version = $1`,
            [migration.version, migration.name, migration.sha256]
          )
          if (result.rows.length !== 1) fail('MIGRATION_LEDGER_RESULT_INVALID')
          states.push({ version: migration.version, state: result.rows[0].state })
        }
        await client.query('COMMIT')
        return states
      } catch (error) {
        await bestEffort(() => client.query('ROLLBACK'))
        throw error
      } finally {
        client.release()
      }
    },

    async inspectCutover({ livemode, authorities }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        const settlements = []
        for (const authority of authorities) {
          const [profileResult, ledgerResult, blockResult] = await Promise.all([
            client.query(
              `SELECT
                 id::text,
                 stripe_customer_id,
                 api_tier,
                 api_stripe_subscription_id,
                 is_deleted,
                 status
               FROM public.user_profiles
               WHERE id = $1::uuid`,
              [authority.userId]
            ),
            client.query(
              `SELECT
                 user_id::text,
                 metadata_user_id::text,
                 metadata_supabase_user_id::text,
                 stripe_customer_id,
                 checkout_reservation_id::text,
                 stripe_price_id,
                 stripe_subscription_id,
                 subscription_created,
                 api_tier,
                 daily_limit,
                 is_active,
                 is_terminal,
                 identity_source
               FROM public.api_tier_stripe_event_ledger
               WHERE livemode = $1
                 AND stripe_subscription_id = $2
               ORDER BY
                 is_terminal DESC,
                 stripe_event_created DESC,
                 is_active ASC,
                 stripe_event_id DESC
               LIMIT 1`,
              [livemode, authority.subscriptionId]
            ),
            client.query(
              `SELECT pg_catalog.count(*)::integer AS count
               FROM public.api_tier_subscription_blocks
               WHERE livemode = $1
                 AND stripe_subscription_id = $2`,
              [livemode, authority.subscriptionId]
            ),
          ])
          if (profileResult.rows.length > 1 || ledgerResult.rows.length > 1) {
            fail('DATABASE_INSPECTION_INVALID')
          }
          const reason = settlementReason({
            profile: profileResult.rows[0] ?? null,
            ledger: ledgerResult.rows[0] ?? null,
            blocked: Number(blockResult.rows[0]?.count ?? 0) > 0,
            authority,
          })
          settlements.push({
            subscriptionId: authority.subscriptionId,
            fulfilled: reason === 'fulfilled',
            reason,
          })
        }

        const eventResult = await client.query(
          `SELECT
             pg_catalog.count(*) FILTER (WHERE status = 'failed')::integer AS failed_events,
             pg_catalog.count(*) FILTER (WHERE status = 'processing')::integer AS processing_events
           FROM public.stripe_events`
        )
        const driftResult = await client.query(
          `WITH latest AS (
             SELECT DISTINCT ON (
               ledger.user_id,
               ledger.stripe_subscription_id
             )
               ledger.user_id,
               ledger.stripe_subscription_id,
               ledger.subscription_created,
               ledger.api_tier,
               ledger.is_active,
               ledger.is_terminal
             FROM public.api_tier_stripe_event_ledger AS ledger
             WHERE ledger.livemode = $1
               AND NOT EXISTS (
                 SELECT 1
                 FROM public.api_tier_subscription_blocks AS block
                 WHERE block.user_id = ledger.user_id
                   AND block.livemode = ledger.livemode
                   AND block.stripe_subscription_id =
                     ledger.stripe_subscription_id
               )
             ORDER BY
               ledger.user_id,
               ledger.stripe_subscription_id,
               ledger.is_terminal DESC,
               ledger.stripe_event_created DESC,
               ledger.is_active ASC,
               ledger.stripe_event_id DESC
           ),
           best AS (
             SELECT
               state.user_id,
               pg_catalog.max(state.subscription_created)
                 FILTER (WHERE state.is_active) AS active_created,
               pg_catalog.max(state.subscription_created)
                 FILTER (
                   WHERE NOT state.is_active
                     AND NOT state.is_terminal
                 ) AS suspended_created
             FROM latest AS state
             GROUP BY state.user_id
           ),
           candidate AS (
             SELECT state.*
             FROM latest AS state
             JOIN best USING (user_id)
             WHERE (
                 best.active_created IS NOT NULL
                 AND state.is_active
                 AND state.subscription_created = best.active_created
               )
               OR (
                 best.active_created IS NULL
                 AND best.suspended_created IS NOT NULL
                 AND NOT state.is_active
                 AND NOT state.is_terminal
                 AND state.subscription_created = best.suspended_created
               )
           ),
           desired AS (
             SELECT
               candidate.user_id,
               pg_catalog.count(*)::integer AS candidate_count,
               pg_catalog.min(candidate.stripe_subscription_id)
                 AS stripe_subscription_id,
               pg_catalog.min(
                 CASE
                   WHEN candidate.is_active THEN candidate.api_tier
                   ELSE 'free'
                 END
               ) AS api_tier
             FROM candidate
             GROUP BY candidate.user_id
           ),
           ledger_users AS (
             SELECT DISTINCT ledger.user_id
             FROM public.api_tier_stripe_event_ledger AS ledger
             WHERE ledger.livemode = $1
           )
           SELECT pg_catalog.count(*)::integer AS count
           FROM public.user_profiles AS profile
           LEFT JOIN desired
             ON desired.user_id = profile.id
           WHERE (
               profile.api_tier <> 'free'
               OR profile.api_stripe_subscription_id IS NOT NULL
               OR EXISTS (
                 SELECT 1
                 FROM ledger_users
                 WHERE ledger_users.user_id = profile.id
               )
             )
             AND (
               COALESCE(desired.candidate_count, 0) > 1
               OR profile.api_tier IS DISTINCT FROM
                 COALESCE(desired.api_tier, 'free')
               OR profile.api_stripe_subscription_id IS DISTINCT FROM
                 desired.stripe_subscription_id
             )`,
          [livemode]
        )
        await client.query('COMMIT')
        return {
          settlements,
          backlog: {
            failedEvents: eventResult.rows[0]?.failed_events ?? 0,
            processingEvents: eventResult.rows[0]?.processing_events ?? 0,
            profileLedgerDrift: driftResult.rows[0]?.count ?? 0,
            // Migration 0240 owns exact refund/dispute settlement. Until its
            // query contract lands, the final report must remain non-ready.
            unresolvedFinancialReversals: null,
          },
        }
      } catch (error) {
        await bestEffort(() => client.query('ROLLBACK'))
        throw error
      } finally {
        client.release()
      }
    },
  }
}

export function parseApiTierCutoverArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--mode') parsed.mode = argv[++index]
    else if (arg === '--expected-release-sha') parsed.expectedReleaseSha = argv[++index]
    else if (arg === '--output') parsed.output = argv[++index]
    else if (arg === '--unsettled-output') parsed.unsettledOutput = argv[++index]
    else fail('ARGUMENT_UNKNOWN')
  }
  if (
    (parsed.mode !== 'scan' && parsed.mode !== 'execute') ||
    !parsed.expectedReleaseSha ||
    !parsed.output
  ) {
    fail('ARGUMENTS_INVALID')
  }
  parsed.expectedReleaseSha = normalizeReleaseSha(parsed.expectedReleaseSha)
  parsed.output = resolve(parsed.output)
  parsed.unsettledOutput = resolve(parsed.unsettledOutput ?? `${parsed.output}.unsettled.json`)
  if (parsed.output === parsed.unsettledOutput) fail('OUTPUT_PATHS_CONFLICT')
  return parsed
}

function livemodeFromSecret(secret) {
  if (typeof secret !== 'string') fail('STRIPE_SECRET_KEY_MISSING')
  if (secret.startsWith('sk_live_')) return true
  if (secret.startsWith('sk_test_')) return false
  fail('STRIPE_SECRET_KEY_INVALID')
}

async function writeJson(path, value) {
  await external('EVIDENCE_WRITE_FAILED', () =>
    writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
  )
}

export async function runApiTierCutoverCli({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  stripe: injectedStripe,
  database: injectedDatabase,
} = {}) {
  const args = parseApiTierCutoverArgs(argv)
  const livemode = livemodeFromSecret(env.STRIPE_SECRET_KEY)
  if (!env.DATABASE_URL) fail('DATABASE_URL_MISSING')
  try {
    validateDatabaseUrl(env.DATABASE_URL)
  } catch {
    fail('DATABASE_NOT_PRODUCTION')
  }
  const planPrices = {
    starter: env.STRIPE_API_STARTER_PRICE_ID,
    pro: env.STRIPE_API_PRO_PRICE_ID,
  }
  normalizePlanPrices(planPrices)
  const baseUrl = env.API_TIER_CUTOVER_BASE_URL || DEFAULT_BASE_URL
  if (livemode && normalizeBaseUrl(baseUrl) !== DEFAULT_BASE_URL) {
    fail('LIVE_PROBE_NOT_PRODUCTION')
  }
  const probeAttempts = env.API_TIER_CUTOVER_PROBE_ATTEMPTS
    ? Number.parseInt(env.API_TIER_CUTOVER_PROBE_ATTEMPTS, 10)
    : DEFAULT_PROBE_ATTEMPTS

  if (Boolean(injectedStripe) !== Boolean(injectedDatabase)) {
    fail('INJECTED_DEPENDENCIES_INCOMPLETE')
  }
  let pool
  let stripe = injectedStripe
  let database = injectedDatabase
  if (!stripe) {
    const [{ default: Stripe }, { default: pg }] = await Promise.all([
      import('stripe'),
      import('pg'),
    ])
    stripe = new Stripe(env.STRIPE_SECRET_KEY, {
      maxNetworkRetries: 0,
      timeout: 30_000,
    })
    pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 30_000,
      query_timeout: 30_000,
      application_name: 'arena_api_tier_cutover',
    })
    database = createPostgresCutoverDatabase(pool)
  }

  try {
    const result = await runApiTierCutover({
      mode: args.mode,
      expectedReleaseSha: args.expectedReleaseSha,
      baseUrl,
      livemode,
      confirmation: env.API_TIER_CUTOVER_CONFIRMATION,
      planPrices,
      fetchImpl,
      stripe,
      database,
      probeAttempts,
    })
    await writeJson(args.output, result.report)
    await writeJson(args.unsettledOutput, result.unsettled)

    let finalResult
    try {
      finalResult = validateApiTierCutoverReport(result.report, {
        expectedReleaseSha: args.expectedReleaseSha,
      })
    } catch {
      return {
        exitCode: 2,
        summary: {
          status: 'incomplete',
          report_path: args.output,
          unsettled_path: args.unsettledOutput,
          legacy_sessions: result.report.legacy_checkout_scan.unique_legacy_sessions,
          unsettled_complete: result.report.legacy_checkout_scan.unsettled_complete,
        },
      }
    }
    return {
      exitCode: 0,
      summary: {
        ...finalResult,
        report_path: args.output,
        unsettled_path: args.unsettledOutput,
      },
    }
  } finally {
    if (pool) await pool.end()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runApiTierCutoverCli()
    .then(({ exitCode, summary }) => {
      process.stdout.write(`${JSON.stringify(summary)}\n`)
      process.exitCode = exitCode
    })
    .catch((error) => {
      const code = error instanceof ApiTierCutoverError ? error.code : 'UNEXPECTED_CUTOVER_FAILURE'
      process.stderr.write(`API tier cutover failed: ${code}\n`)
      process.exitCode = 1
    })
}
