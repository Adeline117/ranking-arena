#!/usr/bin/env node
/**
 * Payment-path canary.
 *
 * This script deliberately has no scheduled mode. It can exercise the current
 * atomic recurring-entitlement authority only when an operator supplies a
 * dedicated, pristine disposable fixture and the rollback-only attestation.
 * The write is enclosed in a database transaction that is always rolled back;
 * a second connection then proves the fixture snapshot was restored exactly.
 *
 * Exit 0: atomic path passed and restoration was proved.
 * Exit 1: payment-path assertion failed, but restoration was proved.
 * Exit 2: safety gate, database access, rollback, or restoration proof failed.
 */
import { randomUUID as cryptoRandomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import pg from 'pg'
import {
  inferSupabaseProjectRef,
  PRODUCTION_PROJECT_REF,
} from '../attest-production-types-source.mjs'

export const FIXTURE_HANDLE_PREFIX = 'payment_canary_disposable_'
export const WRITE_ATTESTATION = 'ROLLBACK_ONLY_DISPOSABLE_FIXTURE_V1'
export const TARGET_ATTESTATION = 'STAGING_SUPABASE_DISPOSABLE_DB_V1'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HANDLE_PATTERN = /^payment_canary_disposable_[a-z0-9_]{1,40}$/

class SafetyGateError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SafetyGateError'
  }
}

function safeError(error) {
  return String(error instanceof Error ? error.message : error).slice(0, 240)
}

function databaseClientOptions(databaseUrl) {
  return {
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
    application_name: 'arena_payment_path_canary_rollback_only',
    connectionTimeoutMillis: 10_000,
    query_timeout: 60_000,
  }
}

export function validatePaymentCanaryEnvironment(env = process.env) {
  const errors = []
  const databaseUrl = env.PAYMENT_CANARY_STAGING_DATABASE_URL?.trim()
  const expectedProjectRef = env.PAYMENT_CANARY_STAGING_PROJECT_REF?.trim().toLowerCase()
  const fixtureUserId = env.PAYMENT_CANARY_DISPOSABLE_USER_ID?.trim()
  const fixtureHandle = env.PAYMENT_CANARY_DISPOSABLE_HANDLE?.trim()

  if (!databaseUrl) errors.push('PAYMENT_CANARY_STAGING_DATABASE_URL is required')
  if (!expectedProjectRef || !/^[a-z0-9]{20}$/.test(expectedProjectRef)) {
    errors.push('PAYMENT_CANARY_STAGING_PROJECT_REF must be a Supabase project ref')
  } else if (expectedProjectRef === PRODUCTION_PROJECT_REF) {
    errors.push('payment canary staging project must not be the production project')
  }
  if (env.PAYMENT_CANARY_TARGET_ATTESTATION !== TARGET_ATTESTATION) {
    errors.push('staging target attestation is missing')
  }

  if (databaseUrl && expectedProjectRef && /^[a-z0-9]{20}$/.test(expectedProjectRef)) {
    try {
      const parsed = new URL(databaseUrl)
      if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.hash) {
        errors.push('payment canary database URL must be an unfragmented PostgreSQL URL')
      } else {
        let username = ''
        try {
          username = decodeURIComponent(parsed.username)
        } catch {
          errors.push('payment canary database URL has invalid username encoding')
        }
        const actualProjectRef = inferSupabaseProjectRef({
          hostname: parsed.hostname,
          username,
        })
        if (actualProjectRef !== expectedProjectRef) {
          errors.push('payment canary database URL is not bound to the expected staging project')
        }
        if (actualProjectRef === PRODUCTION_PROJECT_REF) {
          errors.push('payment canary database URL identifies the production project')
        }
      }
    } catch {
      errors.push('payment canary database URL is invalid')
    }
  }
  if (!fixtureUserId || !UUID_PATTERN.test(fixtureUserId)) {
    errors.push('PAYMENT_CANARY_DISPOSABLE_USER_ID must be a UUID')
  }
  if (!fixtureHandle || !HANDLE_PATTERN.test(fixtureHandle)) {
    errors.push(`PAYMENT_CANARY_DISPOSABLE_HANDLE must start with ${FIXTURE_HANDLE_PREFIX}`)
  }
  if (env.PAYMENT_CANARY_WRITE_ATTESTATION !== WRITE_ATTESTATION) {
    errors.push('rollback-only write attestation is missing')
  }

  return {
    ok: errors.length === 0,
    errors,
    databaseUrl,
    expectedProjectRef,
    fixtureUserId,
    fixtureHandle,
  }
}

async function sendTelegram(text, env = process.env, fetchImpl = globalThis.fetch) {
  const token = env.TELEGRAM_BOT_TOKEN
  const chatId = env.TELEGRAM_ALERT_CHAT_ID || env.TELEGRAM_CHAT_ID
  if (!token || !chatId || typeof fetchImpl !== 'function') return

  try {
    await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
  } catch (error) {
    console.error('[payment-canary] Telegram alert failed:', safeError(error))
  }
}

async function closeClient(client) {
  if (!client) return
  await client.end().catch(() => {})
}

async function lockAndValidateFixture(client, fixtureUserId, fixtureHandle) {
  const { rows } = await client.query(
    `SELECT
       profile.id,
       profile.handle,
       profile.deleted_at,
       profile.banned_at,
       COALESCE(profile.is_banned, false) AS is_banned,
       COALESCE(profile.is_pro, false) AS is_pro,
       COALESCE(profile.subscription_tier, 'free') AS subscription_tier,
       profile.pro_plan,
       profile.pro_expires_at,
       profile.stripe_customer_id,
       profile.stripe_subscription_id,
       (SELECT count(*)::integer FROM public.subscriptions WHERE user_id = profile.id) AS subscription_count,
       (SELECT count(*)::integer FROM public.pro_entitlement_grants WHERE user_id = profile.id) AS grant_count,
       (SELECT count(*)::integer FROM public.stripe_trial_entitlements WHERE user_id = profile.id) AS trial_count,
       (SELECT count(*)::integer FROM public.stripe_entitlement_payments WHERE user_id = profile.id) AS payment_count,
       (SELECT count(*)::integer FROM public.stripe_entitlement_effects WHERE user_id = profile.id) AS effect_count,
       (SELECT count(*)::integer FROM public.stripe_manual_reviews WHERE user_id = profile.id) AS review_count,
       (SELECT count(*)::integer FROM public.pro_official_group_members WHERE user_id = profile.id) AS official_group_count
     FROM public.user_profiles AS profile
     WHERE profile.id = $1::uuid
     FOR UPDATE`,
    [fixtureUserId]
  )

  if (rows.length !== 1) {
    throw new SafetyGateError('disposable fixture profile does not exist')
  }

  const fixture = rows[0]
  if (fixture.handle !== fixtureHandle || !fixture.handle.startsWith(FIXTURE_HANDLE_PREFIX)) {
    throw new SafetyGateError('database fixture marker does not match the requested handle')
  }
  if (fixture.deleted_at || fixture.banned_at || fixture.is_banned) {
    throw new SafetyGateError('disposable fixture is deleted or banned')
  }

  const pristine =
    !fixture.is_pro &&
    fixture.subscription_tier === 'free' &&
    fixture.pro_plan === null &&
    fixture.pro_expires_at === null &&
    fixture.stripe_customer_id === null &&
    fixture.stripe_subscription_id === null &&
    fixture.subscription_count === 0 &&
    fixture.grant_count === 0 &&
    fixture.trial_count === 0 &&
    fixture.payment_count === 0 &&
    fixture.effect_count === 0 &&
    fixture.review_count === 0 &&
    fixture.official_group_count === 0

  if (!pristine) {
    throw new SafetyGateError(
      'disposable fixture is not pristine; restore or replace it before running the canary'
    )
  }
}

async function captureFixtureSnapshot(client, fixtureUserId) {
  const { rows } = await client.query(
    `SELECT pg_catalog.md5(snapshot.payload::text) AS snapshot
     FROM (
       SELECT pg_catalog.jsonb_build_object(
       'profile', (
         SELECT pg_catalog.to_jsonb(profile)
         FROM public.user_profiles AS profile
         WHERE profile.id = $1::uuid
       ),
       'subscriptions', COALESCE((
         SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(subscription) ORDER BY subscription.id)
         FROM public.subscriptions AS subscription
         WHERE subscription.user_id = $1::uuid
       ), '[]'::jsonb),
       'grants', COALESCE((
         SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(entitlement_grant) ORDER BY entitlement_grant.id)
         FROM public.pro_entitlement_grants AS entitlement_grant
         WHERE entitlement_grant.user_id = $1::uuid
       ), '[]'::jsonb),
       'trials', COALESCE((
         SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(trial) ORDER BY trial.id)
         FROM public.stripe_trial_entitlements AS trial
         WHERE trial.user_id = $1::uuid
       ), '[]'::jsonb),
       'payments', COALESCE((
         SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(payment) ORDER BY payment.id)
         FROM public.stripe_entitlement_payments AS payment
         WHERE payment.user_id = $1::uuid
       ), '[]'::jsonb),
       'effects', COALESCE((
         SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(effect) ORDER BY effect.id)
         FROM public.stripe_entitlement_effects AS effect
         WHERE effect.user_id = $1::uuid
       ), '[]'::jsonb),
       'reviews', COALESCE((
         SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(review) ORDER BY review.id)
         FROM public.stripe_manual_reviews AS review
         WHERE review.user_id = $1::uuid
       ), '[]'::jsonb),
       'official_groups', COALESCE((
         SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(member) ORDER BY member.id)
         FROM public.pro_official_group_members AS member
         WHERE member.user_id = $1::uuid
       ), '[]'::jsonb)
       ) AS payload
     ) AS snapshot`,
    [fixtureUserId]
  )
  if (!rows[0]?.snapshot) throw new Error('fixture snapshot could not be captured')
  return rows[0].snapshot
}

function buildSyntheticStripeIdentity(randomUUID) {
  const key = randomUUID().replaceAll('-', '')
  return {
    customerId: `cus_canary_${key}`,
    subscriptionId: `sub_canary_${key}`,
    invoiceId: `in_canary_${key}`,
    paymentIntentId: `pi_canary_${key}`,
    chargeId: `ch_canary_${key}`,
  }
}

async function exerciseAtomicPaymentPath(client, fixtureUserId, identity) {
  const periodStart = new Date(Date.now() - 60_000)
  const periodEnd = new Date(periodStart.getTime() + 30 * 24 * 60 * 60 * 1000)
  const { rows } = await client.query(
    `SELECT public.activate_recurring_entitlement_payment_atomic(
       $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text,
       'monthly'::text, 100::bigint, 'usd'::text,
       $7::timestamptz, $8::timestamptz, 'paid'::text, 'active'::text
     ) AS result`,
    [
      fixtureUserId,
      identity.customerId,
      identity.subscriptionId,
      identity.invoiceId,
      identity.paymentIntentId,
      identity.chargeId,
      periodStart.toISOString(),
      periodEnd.toISOString(),
    ]
  )

  if (rows[0]?.result?.status !== 'activated') {
    throw new Error(
      `atomic entitlement authority returned ${rows[0]?.result?.status || 'no status'}`
    )
  }

  const verification = await client.query(
    `SELECT
       public.stripe_has_current_pro_authority_v2($1::uuid) AS has_authority,
       (SELECT count(*)::integer
        FROM public.subscriptions AS subscription
        WHERE subscription.user_id = $1::uuid
          AND subscription.stripe_subscription_id = $2::text
          AND subscription.tier = 'pro'
          AND subscription.plan = 'monthly'
          AND subscription.status = 'active'
          AND public.stripe_subscription_has_exact_payment_binding_v2($1::uuid)
       ) AS exact_subscription_count,
       (SELECT count(*)::integer
        FROM public.stripe_entitlement_payments AS payment
        WHERE payment.user_id = $1::uuid
          AND payment.stripe_charge_id = $3::text
          AND payment.payment_status = 'paid'
       ) AS payment_count`,
    [fixtureUserId, identity.subscriptionId, identity.chargeId]
  )

  const proof = verification.rows[0]
  if (
    proof?.has_authority !== true ||
    proof?.exact_subscription_count !== 1 ||
    proof?.payment_count !== 1
  ) {
    throw new Error('atomic entitlement write did not produce an exact current authority')
  }
}

/**
 * Dependency injection exists only so the fail-closed boundary can be tested
 * without opening a network connection.
 */
export async function runPaymentPathCanary({
  env = process.env,
  clientFactory = (options) => new pg.Client(options),
  randomUUID = cryptoRandomUUID,
} = {}) {
  const configuration = validatePaymentCanaryEnvironment(env)
  if (!configuration.ok) {
    return {
      exitCode: 2,
      status: 'blocked',
      message: `safety gate blocked execution: ${configuration.errors.join('; ')}`,
    }
  }

  const identity = buildSyntheticStripeIdentity(randomUUID)
  const options = databaseClientOptions(configuration.databaseUrl)
  let transactionClient
  let transactionStarted = false
  let snapshotBefore
  let operationError
  let rollbackError

  try {
    transactionClient = clientFactory(options)
    await transactionClient.connect()
    await transactionClient.query('BEGIN')
    transactionStarted = true
    await transactionClient.query("SET LOCAL statement_timeout = '45s'")
    await transactionClient.query(
      `SELECT
         pg_catalog.set_config('request.jwt.claim.role', 'service_role', true),
         pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true)`
    )
    await lockAndValidateFixture(
      transactionClient,
      configuration.fixtureUserId,
      configuration.fixtureHandle
    )
    snapshotBefore = await captureFixtureSnapshot(transactionClient, configuration.fixtureUserId)
    await exerciseAtomicPaymentPath(transactionClient, configuration.fixtureUserId, identity)
  } catch (error) {
    operationError = error
  } finally {
    if (transactionStarted) {
      try {
        await transactionClient.query('ROLLBACK')
      } catch (error) {
        rollbackError = error
      }
    }
    await closeClient(transactionClient)
  }

  if (operationError instanceof SafetyGateError) {
    return {
      exitCode: 2,
      status: 'blocked',
      message: operationError.message,
    }
  }
  if (!snapshotBefore) {
    return {
      exitCode: 2,
      status: 'unverified',
      message: `could not capture the pre-write snapshot: ${safeError(operationError)}`,
    }
  }

  let verificationClient
  let snapshotAfter
  try {
    verificationClient = clientFactory(options)
    await verificationClient.connect()
    snapshotAfter = await captureFixtureSnapshot(verificationClient, configuration.fixtureUserId)
  } catch (error) {
    return {
      exitCode: 2,
      status: 'unverified',
      message: `post-rollback restoration could not be proved: ${safeError(error)}`,
    }
  } finally {
    await closeClient(verificationClient)
  }

  if (snapshotAfter !== snapshotBefore) {
    return {
      exitCode: 2,
      status: 'restore_mismatch',
      message: 'post-rollback fixture snapshot differs from the locked pre-write snapshot',
    }
  }
  if (rollbackError) {
    return {
      exitCode: 2,
      status: 'rollback_error',
      message: `rollback command failed even though the restored snapshot matched: ${safeError(rollbackError)}`,
    }
  }
  if (operationError) {
    return {
      exitCode: 1,
      status: 'path_failed_restored',
      message: `atomic payment path failed; fixture restoration was proved: ${safeError(operationError)}`,
    }
  }

  return {
    exitCode: 0,
    status: 'passed_restored',
    message: 'atomic payment authority passed; exact rollback restoration was proved',
  }
}

export async function main(env = process.env) {
  const result = await runPaymentPathCanary({ env })
  const prefix = result.exitCode === 0 ? '✅' : result.exitCode === 1 ? '🔴' : '⚠️'
  const message = `${prefix} payment-path-canary: ${result.message}`
  const output = result.exitCode === 0 ? console.log : console.error
  output(message)
  if (result.exitCode !== 0) await sendTelegram(message, env)
  return result.exitCode
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  loadDotenv({ path: new URL('../../.env.local', import.meta.url).pathname })
  main().then(
    (exitCode) => {
      process.exitCode = exitCode
    },
    async (error) => {
      const message = `⚠️ payment-path-canary crashed: ${safeError(error)}`
      console.error(message)
      await sendTelegram(message)
      process.exitCode = 2
    }
  )
}
